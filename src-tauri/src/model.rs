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

/// Outcome of "Test connection": every step that ran, the last one failing when `ok` is false.
#[derive(Serialize, Debug)]
pub struct TestReport {
    pub ok: bool,
    pub steps: Vec<TestStep>,
    pub server_version: Option<String>,
}
