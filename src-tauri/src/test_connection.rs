//! "Test connection": runs the same steps a real query would, one at a time, so a failure says
//! where it failed (DNS, TCP, TLS / login, server) instead of one opaque error.

use std::time::{Duration, Instant};

use tokio::net::{lookup_host, TcpStream};

use crate::cancel::Guard;
use crate::model::{ConnectionParams, DbType, TestReport, TestStep};
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
        DbType::Postgres => test_postgres(conn, password, guard, steps).await,
        DbType::Clickhouse => test_clickhouse(conn, password, guard, steps).await,
    }
}

fn endpoint(conn: &ConnectionParams) -> Result<(String, u16), String> {
    let port = conn.port_number()?;
    let host = match conn.db_type {
        DbType::Postgres => conn.host_trimmed()?.to_string(),
        DbType::Clickhouse => {
            let url = clickhouse::base_url(conn)?;
            url.host_str()
                .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string())
                .ok_or("Invalid host")?
        }
    };
    Ok((host, port))
}

async fn test_postgres(conn: &ConnectionParams, password: &str, guard: &Guard<'_>, mut steps: Steps) -> TestReport {
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
    let detail = match crate::client_cert::files(conn) {
        Ok(files) if !files.cert.is_empty() && conn.use_default_certs => format!("{tls}, default client certificate"),
        Ok(files) if !files.cert.is_empty() => format!("{tls}, client certificate"),
        _ => tls.to_string(),
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
