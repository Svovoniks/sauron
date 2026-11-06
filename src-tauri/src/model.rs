use serde::{Deserialize, Serialize};

/// Message returned (and matched by the UI) when a query was stopped by the user.
pub const CANCELLED: &str = "Query was cancelled";

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    /// Postgres only (libpq's verify-ca): the certificate must chain to a trusted root, the host name is not checked.
    #[serde(rename = "verify-ca")]
    VerifyCa,
    Verify,
}

/// Postgres only: which node of a multi-host list to keep (libpq's target_session_attrs).
/// The driver tries the hosts in order and keeps the first one that matches.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TargetSessionAttrs {
    /// The first host that accepts the connection, primary or replica (the behaviour before multi-host support).
    #[default]
    Any,
    /// A node that accepts writes: the primary.
    ReadWrite,
    /// A node that only allows reads: a replica.
    ReadOnly,
}

impl TargetSessionAttrs {
    /// The libpq spelling (PGTARGETSESSIONATTRS, target_session_attrs=...).
    pub fn libpq_name(self) -> &'static str {
        match self {
            TargetSessionAttrs::Any => "any",
            TargetSessionAttrs::ReadWrite => "read-write",
            TargetSessionAttrs::ReadOnly => "read-only",
        }
    }
}

/// Postgres hosts and ports as libpq takes them: one port for every host, or one port per host.
#[derive(Debug, PartialEq, Eq)]
pub struct PgHosts<'a> {
    pub hosts: Vec<&'a str>,
    pub ports: Vec<u16>,
}

impl PgHosts<'_> {
    /// Every host with the port it is reached on, in the order the driver tries them.
    pub fn endpoints(&self) -> Vec<(&str, u16)> {
        self.hosts
            .iter()
            .enumerate()
            .map(|(i, host)| (*host, self.ports.get(i).copied().unwrap_or(self.ports[0])))
            .collect()
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DbType {
    Postgres,
    Clickhouse,
}

/// Connection as persisted by the frontend. The password is never part of it, it is
/// looked up in the OS keychain by `id`.
#[derive(Deserialize, Clone, Debug)]
pub struct ConnectionParams {
    pub id: String,
    pub host: String,
    pub port: String,
    pub username: String,
    pub database: String,
    pub db_type: DbType,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub timeout_secs: u64,
    /// Postgres certificate files (libpq's sslrootcert, sslcert and sslkey); empty when not used.
    #[serde(default)]
    pub ssl_root_cert: String,
    #[serde(default)]
    pub ssl_cert: String,
    #[serde(default)]
    pub ssl_key: String,
    /// Use the default certificate files from Settings instead of the three above.
    #[serde(default)]
    pub use_default_certs: bool,
    /// Postgres only; "any" for connections saved before multi-host support.
    #[serde(default)]
    pub target_session_attrs: TargetSessionAttrs,
}

impl ConnectionParams {
    pub fn port_number(&self) -> Result<u16, String> {
        self.port
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("Invalid port: \"{}\"", self.port))
    }

    pub fn host_trimmed(&self) -> Result<&str, String> {
        let host = self.host.trim();
        if host.is_empty() {
            Err("Host is required".to_string())
        } else {
            Ok(host)
        }
    }

    /// Postgres host list: the host field split on commas (blanks dropped) and the port field, which
    /// holds either one port for all hosts or a comma separated list with one port per host.
    /// A single host with a single port gives the same errors as host_trimmed and port_number.
    pub fn pg_hosts(&self) -> Result<PgHosts<'_>, String> {
        let hosts: Vec<&str> = self.host.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
        if hosts.is_empty() {
            return Err("Host is required".to_string());
        }
        if !self.port.contains(',') {
            return Ok(PgHosts {
                hosts,
                ports: vec![self.port_number()?],
            });
        }
        let ports = self
            .port
            .split(',')
            .map(|p| p.trim().parse::<u16>().map_err(|_| format!("Invalid port: \"{}\"", p.trim())))
            .collect::<Result<Vec<_>, _>>()?;
        if ports.len() != hosts.len() {
            return Err(format!(
                "{} ports for {} hosts: give one port for all hosts, or one port per host",
                ports.len(),
                hosts.len()
            ));
        }
        Ok(PgHosts { hosts, ports })
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub ui_type: String,
}

/// Result of a query. A cell is the exact text the database returned, `None` is SQL NULL.
#[derive(Serialize, Debug, Default)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: bool,
    pub message: Option<String>,
}

impl QueryResult {
    pub fn message(message: impl Into<String>) -> Self {
        QueryResult {
            message: Some(message.into()),
            ..Default::default()
        }
    }
}

/// Why one statement of a script failed. `code` is the SQLSTATE (Postgres) or "CH <n>" (ClickHouse),
/// `position` the 1-based character offset in that statement when the server reports one.
#[derive(Serialize, Debug, Default)]
pub struct StatementError {
    pub message: String,
    pub code: Option<String>,
    pub position: Option<u32>,
}

impl From<String> for StatementError {
    fn from(message: String) -> Self {
        StatementError {
            message,
            ..Default::default()
        }
    }
}

/// What one statement of a script produced; a script stops at the first failing statement.
#[derive(Serialize, Debug)]
pub struct StatementOutcome {
    pub sql: String,
    pub elapsed_ms: u64,
    pub result: Option<QueryResult>,
    pub error: Option<StatementError>,
}

#[derive(Serialize, Debug)]
pub struct TestStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
    pub ms: u64,
}

/// Outcome of "Test connection": every step that ran, the last one failing when ok is false. A step
/// can also fail without failing the test: one unreachable host of a list, or a replica that rejects writes.
#[derive(Serialize, Debug)]
pub struct TestReport {
    pub ok: bool,
    pub steps: Vec<TestStep>,
    pub server_version: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(host: &str, port: &str) -> ConnectionParams {
        serde_json::from_value(serde_json::json!({
            "id": "t", "host": host, "port": port, "username": "u", "database": "d", "db_type": "postgres",
        }))
        .unwrap()
    }

    #[test]
    fn saved_connections_without_the_field_target_any_node() {
        assert_eq!(conn("h", "5432").target_session_attrs, TargetSessionAttrs::Any);
        let c: ConnectionParams = serde_json::from_value(serde_json::json!({
            "id": "t", "host": "h", "port": "1", "username": "", "database": "", "db_type": "postgres",
            "target_session_attrs": "read-write",
        }))
        .unwrap();
        assert_eq!(c.target_session_attrs, TargetSessionAttrs::ReadWrite);
        assert_eq!(c.target_session_attrs.libpq_name(), "read-write");
    }

    #[test]
    fn single_host_is_unchanged() {
        let c = conn("  db.local ", " 5432 ");
        let hosts = c.pg_hosts().unwrap();
        assert_eq!(hosts, PgHosts { hosts: vec!["db.local"], ports: vec![5432] });
        assert_eq!(hosts.endpoints(), vec![("db.local", 5432)]);
        assert_eq!(conn("  ", "5432").pg_hosts().unwrap_err(), "Host is required");
        assert_eq!(conn("h", "x").pg_hosts().unwrap_err(), "Invalid port: \"x\"");
    }

    #[test]
    fn host_list_shares_one_port_or_has_one_per_host() {
        let c = conn("a, b ,,c,", "6433");
        let hosts = c.pg_hosts().unwrap();
        assert_eq!(hosts.hosts, vec!["a", "b", "c"]);
        assert_eq!(hosts.ports, vec![6433]);
        assert_eq!(hosts.endpoints(), vec![("a", 6433), ("b", 6433), ("c", 6433)]);

        let c = conn("a,b", "1, 2");
        assert_eq!(c.pg_hosts().unwrap().endpoints(), vec![("a", 1), ("b", 2)]);

        assert!(conn("a,b,c", "1,2").pg_hosts().unwrap_err().contains("2 ports for 3 hosts"));
        assert_eq!(conn("a,b", "1,x").pg_hosts().unwrap_err(), "Invalid port: \"x\"");
        assert_eq!(conn(" , ", "1").pg_hosts().unwrap_err(), "Host is required");
    }
}
