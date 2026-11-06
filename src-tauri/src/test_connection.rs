//! "Test connection": runs the same steps a real query would, one at a time, so a failure says
//! where it failed (DNS, TCP, TLS / login, server) instead of one opaque error.

use std::time::{Duration, Instant};

use tokio::net::{lookup_host, TcpStream};

use crate::cancel::Guard;
use crate::model::{ConnectionParams, DbType, TargetSessionAttrs, TestReport, TestStep};
use crate::{clickhouse, postgres};

struct Steps {
    steps: Vec<TestStep>,
}

impl Steps {
    fn ok(&mut self, name: &str, detail: impl Into<String>, started: Instant) {
        self.steps.push(TestStep {
            name: name.to_string(),
            ok: true,
            detail: detail.into(),
            ms: started.elapsed().as_millis() as u64,
        });
    }

    fn fail(mut self, name: &str, detail: impl Into<String>, started: Instant) -> TestReport {
        self.steps.push(TestStep {
            name: name.to_string(),
            ok: false,
            detail: detail.into(),
            ms: started.elapsed().as_millis() as u64,
        });
        TestReport {
            ok: false,
            steps: self.steps,
            server_version: None,
        }
    }
}

pub async fn run(conn: &ConnectionParams, password: &str, guard: &Guard<'_>) -> TestReport {
    let mut steps = Steps { steps: Vec::new() };

    let started = Instant::now();
    if conn.db_type == DbType::Postgres {
        let endpoints = match conn.pg_hosts() {
            Ok(hosts) => hosts.endpoints().into_iter().map(|(h, p)| (h.to_string(), p)).collect::<Vec<_>>(),
            Err(message) => return steps.fail("Check address", message, started),
        };
        if endpoints.len() > 1 {
            return test_postgres_hosts(conn, password, guard, &endpoints, steps).await;
        }
    }
    let (host, port) = match endpoint(conn) {
        Ok(v) => v,
        Err(message) => return steps.fail("Check address", message, started),
    };

    // 1. DNS
    let started = Instant::now();
    let addrs: Vec<_> = match lookup_host((host.as_str(), port)).await {
        Ok(found) => found.collect(),
        Err(e) => return steps.fail("Resolve host", format!("no such host ({e})"), started),
    };
    let Some(first) = addrs.first().copied() else {
        return steps.fail("Resolve host", "no addresses found", started);
    };
    steps.ok("Resolve host", first.ip().to_string(), started);

    // 2. TCP
    let started = Instant::now();
    match tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(first)).await {
        Ok(Ok(_)) => steps.ok("Open TCP connection", format!("port {port}"), started),
        Ok(Err(e)) => return steps.fail("Open TCP connection", e.to_string(), started),
        Err(_) => return steps.fail("Open TCP connection", "timed out after 10 s", started),
    }

    // 3. TLS + login (+ the connection's read-only / timeout settings), then the server version.
    match conn.db_type {
        DbType::Postgres => test_postgres(conn, password, guard, steps, None).await,
        DbType::Clickhouse => test_clickhouse(conn, password, guard, steps).await,
    }
}

fn endpoint(conn: &ConnectionParams) -> Result<(String, u16), String> {
    let port = conn.port_number()?;
    let host = match conn.db_type {
        DbType::Postgres => {
            let hosts = conn.pg_hosts()?;
            return Ok((hosts.hosts[0].to_string(), hosts.ports[0]));
        }
        DbType::Clickhouse => {
            let url = clickhouse::base_url(conn)?;
            url.host_str()
                .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string())
                .ok_or("Invalid host")?
        }
    };
    Ok((host, port))
}

/// What one host of a Postgres host list said when logged into on its own.
struct HostProbe {
    ms: u64,
    outcome: Result<HostState, String>,
}

struct HostState {
    addr: String,
    /// SHOW transaction_read_only is on: the value the driver checks for target_session_attrs.
    read_only: bool,
    in_recovery: bool,
}

impl HostState {
    fn role(&self) -> &'static str {
        match (self.in_recovery, self.read_only) {
            (true, _) => "replica (read-only)",
            (false, true) => "primary, but read-only",
            (false, false) => "primary (read-write)",
        }
    }

    /// The driver's rule for picking a host.
    fn matches(&self, target: TargetSessionAttrs) -> bool {
        match target {
            TargetSessionAttrs::Any => true,
            TargetSessionAttrs::ReadWrite => !self.read_only,
            TargetSessionAttrs::ReadOnly => self.read_only,
        }
    }
}

/// Several hosts: look at each one on its own (reachable? primary or replica?), say which one the
/// driver keeps, then log in through the real host list like a query would.
async fn test_postgres_hosts(
    conn: &ConnectionParams,
    password: &str,
    guard: &Guard<'_>,
    endpoints: &[(String, u16)],
    mut steps: Steps,
) -> TestReport {
    let started = Instant::now();
    if let Err(message) = crate::client_cert::renew_if_expired(conn).await {
        return steps.fail("Renew client certificate", message, started);
    }

    // In parallel, so one unreachable host does not hold up the others for the whole connect timeout.
    let handles: Vec<_> = endpoints
        .iter()
        .map(|(host, port)| {
            let single = ConnectionParams {
                host: host.clone(),
                port: port.to_string(),
                target_session_attrs: TargetSessionAttrs::Any,
                ..conn.clone()
            };
            let password = password.to_string();
            tokio::spawn(async move { probe_host(&single, &password).await })
        })
        .collect();
    let mut probes = Vec::with_capacity(handles.len());
    for handle in handles {
        probes.push(handle.await.unwrap_or_else(|e| HostProbe {
            ms: 0,
            outcome: Err(e.to_string()),
        }));
    }

    for ((host, port), probe) in endpoints.iter().zip(&probes) {
        steps.steps.push(TestStep {
            name: format!("Host {host}:{port}"),
            ok: probe.outcome.is_ok(),
            detail: match &probe.outcome {
                Ok(state) => format!("{}, {}", state.addr, state.role()),
                Err(message) => message.clone(),
            },
            ms: probe.ms,
        });
    }

    let target = conn.target_session_attrs;
    let picked = endpoints.iter().zip(&probes).find_map(|((host, port), probe)| match &probe.outcome {
        Ok(state) if state.matches(target) => Some((format!("{host}:{port}"), state.in_recovery)),
        _ => None,
    });
    let rule = match target {
        TargetSessionAttrs::Any => "the first host that answers",
        TargetSessionAttrs::ReadWrite => "the first host that accepts writes",
        TargetSessionAttrs::ReadOnly => "the first read-only host",
    };
    if let Some((label, _)) = &picked {
        steps.steps.push(TestStep {
            name: "Pick host".to_string(),
            ok: true,
            detail: format!("{label} ({rule})"),
            ms: 0,
        });
    } else if probes.iter().any(|p| p.outcome.is_ok()) {
        let started = Instant::now();
        let detail = format!("no host matches target session {} ({rule})", target.libpq_name());
        return steps.fail("Pick host", detail, started);
    }

    test_postgres(conn, password, guard, steps, picked).await
}

async fn probe_host(conn: &ConnectionParams, password: &str) -> HostProbe {
    let started = Instant::now();
    let outcome = match tokio::time::timeout(Duration::from_secs(30), probe_host_state(conn, password)).await {
        Ok(outcome) => outcome,
        Err(_) => Err("timed out after 30 s".to_string()),
    };
    HostProbe {
        ms: started.elapsed().as_millis() as u64,
        outcome,
    }
}

async fn probe_host_state(conn: &ConnectionParams, password: &str) -> Result<HostState, String> {
    let port = conn.port_number()?;
    let addr = match lookup_host((conn.host.as_str(), port)).await {
        Ok(mut found) => found.next().ok_or("no addresses found")?.ip().to_string(),
        Err(e) => return Err(format!("no such host ({e})")),
    };
    let (client, _) = postgres::open_client(conn, password)
        .await
        .map_err(|message| format!("{addr}: {message}"))?;
    let rows = client
        .simple_query("SELECT current_setting('transaction_read_only'), pg_is_in_recovery()::text")
        .await
        .map_err(|e| format!("{addr}: {e}"))?;
    let (read_only, in_recovery) = rows
        .iter()
        .find_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(row) => Some((
                row.get(0).unwrap_or_default() == "on",
                row.get(1).unwrap_or_default() == "true",
            )),
            _ => None,
        })
        .ok_or_else(|| format!("{addr}: the server returned no row"))?;
    Ok(HostState {
        addr,
        read_only,
        in_recovery,
    })
}

/// picked: for a host list, the host the driver should have kept and whether it is a replica.
async fn test_postgres(
    conn: &ConnectionParams,
    password: &str,
    guard: &Guard<'_>,
    mut steps: Steps,
    picked: Option<(String, bool)>,
) -> TestReport {
    use crate::model::SslMode;

    let started = Instant::now();
    let client = match postgres::connect_session(conn, password, guard).await {
        Ok(client) => client,
        Err(message) => return steps.fail("Log in", message, started),
    };
    let tls = match conn.ssl_mode {
        SslMode::Disable => "no encryption",
        SslMode::Prefer => "TLS if offered",
        SslMode::Require => "TLS, certificate not checked",
        SslMode::VerifyCa => "TLS, certificate authority verified",
        SslMode::Verify => "TLS, certificate verified",
    };
    let detail = match crate::client_cert::expiry(conn) {
        Some(until) if conn.use_default_certs => format!("{tls}, default client certificate valid until {until}"),
        Some(until) => format!("{tls}, client certificate valid until {until}"),
        None => tls.to_string(),
    };
    steps.ok("Encrypt and log in", detail, started);

    let started = Instant::now();
    let rows = client
        .simple_query("select version(), current_setting('default_transaction_read_only')")
        .await;
    let version = match rows {
        Ok(messages) => messages.iter().find_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(row) => Some((
                row.get(0).unwrap_or_default().to_string(),
                row.get(1).unwrap_or_default().to_string(),
            )),
            _ => None,
        }),
        Err(e) => return steps.fail("Ask the server", e.to_string(), started),
    };
    let (full, read_only) = version.unwrap_or_default();
    let short = full.split(" on ").next().unwrap_or(&full).to_string();
    steps.ok("Server version", short.clone(), started);

    // Informational, and skipped on servers that do not know the function.
    let recovery = client.simple_query("SELECT pg_is_in_recovery()::text").await.ok().and_then(|messages| {
        messages.iter().find_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(row) => row.get(0).map(|v| v == "true"),
            _ => None,
        })
    });
    if let Some(in_recovery) = recovery {
        let mut detail = if in_recovery { "replica (read-only)" } else { "primary" }.to_string();
        if let Some((label, _)) = picked.as_ref().filter(|(_, picked_replica)| *picked_replica == in_recovery) {
            detail = format!("{detail} at {label}");
        }
        // The case this exists for: a connection meant for writes that landed on a replica.
        let writes_fail = in_recovery && !conn.read_only && conn.target_session_attrs != TargetSessionAttrs::ReadOnly;
        if writes_fail {
            detail.push_str(
                " - writes will fail: list every node of the cluster in Host (comma separated) and set Target session to read-write",
            );
        }
        steps.steps.push(TestStep {
            name: "Server role".to_string(),
            ok: !writes_fail,
            detail,
            ms: 0,
        });
    }
    steps.steps.push(TestStep {
        name: "Read-only mode".to_string(),
        ok: true,
        detail: if conn.read_only && read_only == "on" {
            "on".to_string()
        } else if conn.read_only {
            "requested, server did not confirm".to_string()
        } else {
            "off (writes allowed)".to_string()
        },
        ms: 0,
    });
    TestReport {
        ok: true,
        steps: steps.steps,
        server_version: Some(short),
    }
}

async fn test_clickhouse(conn: &ConnectionParams, password: &str, guard: &Guard<'_>, mut steps: Steps) -> TestReport {
    let started = Instant::now();
    let statements = vec!["SELECT version()".to_string()];
    match clickhouse::execute(conn, password, &statements, 1, guard).await {
        Ok(result) => {
            let version = result
                .rows
                .first()
                .and_then(|row| row.first())
                .and_then(|cell| cell.clone())
                .unwrap_or_default();
            let scheme = if conn.ssl_mode == crate::model::SslMode::Disable { "http" } else { "https" };
            steps.ok("Log in and ask the server", scheme, started);
            let label = format!("ClickHouse {version}");
            steps.steps.push(TestStep {
                name: "Server version".to_string(),
                ok: true,
                detail: label.clone(),
                ms: 0,
            });
            TestReport {
                ok: true,
                steps: steps.steps,
                server_version: Some(label),
            }
        }
        Err(message) => steps.fail("Log in and ask the server", message, started),
    }
}
