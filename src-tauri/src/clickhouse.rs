//! ClickHouse over its HTTP interface. Runs in Rust (not in the webview) so the password
//! stays in the keychain, TLS is configurable, and cancellation/row limits work like Postgres.

use std::time::Duration;

use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::cancel::{Guard, Killer};
use crate::model::{ColumnMeta, ConnectionParams, QueryResult, SslMode, StatementError, StatementOutcome, CANCELLED};

/// Everything needed to `KILL QUERY` a running statement from another task.
pub struct Kill {
    client: Client,
    url: Url,
    username: String,
    password: String,
    query_id: String,
}

impl Kill {
    pub async fn send(self) {
        let mut request = self.client.post(self.url).body(format!(
            "KILL QUERY WHERE query_id = '{}' ASYNC",
            self.query_id
        ));
        if !self.username.is_empty() {
            request = request.basic_auth(&self.username, Some(&self.password));
        }
        let _ = request.timeout(Duration::from_secs(10)).send().await;
    }
}

#[derive(Deserialize)]
struct Meta {
    name: String,
    #[serde(rename = "type")]
    ty: String,
}

#[derive(Deserialize)]
struct Response<'a> {
    meta: Vec<Meta>,
    #[serde(borrow)]
    data: Vec<Vec<&'a RawValue>>,
}

pub fn base_url(conn: &ConnectionParams) -> Result<Url, String> {
    let mut host = conn.host_trimmed()?;
    // Be forgiving about a pasted URL.
    for prefix in ["http://", "https://"] {
        if let Some(rest) = host.strip_prefix(prefix) {
            host = rest;
        }
    }
    let host = host.trim_end_matches('/');
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]") // bare IPv6
    } else {
        host.to_string()
    };
    let scheme = if conn.ssl_mode == SslMode::Disable { "http" } else { "https" };
    Url::parse(&format!("{scheme}://{host}:{}/", conn.port_number()?))
        .map_err(|e| format!("Invalid host: {e}"))
}

fn build_client(conn: &ConnectionParams) -> Result<Client, String> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(conn.ssl_mode == SslMode::Require || conn.ssl_mode == SslMode::Prefer);
    if conn.timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(conn.timeout_secs.saturating_add(5)));
    }
    builder.build().map_err(|e| e.to_string())
}

pub async fn execute(
    conn: &ConnectionParams,
    password: &str,
    statements: &[String],
    row_limit: usize,
    guard: &Guard<'_>,
) -> Result<QueryResult, String> {
    if statements.is_empty() {
        return Err("No SQL statements to execute".to_string());
    }
    let url = base_url(conn)?;
    let client = build_client(conn)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let username = conn.username.trim().to_string();

    guard
        .run(async {
            let (last, earlier) = statements.split_last().expect("checked above");

            for statement in earlier {
                let query_id = uuid::Uuid::new_v4().to_string();
                register_kill(guard, &client, &url, &username, password, &query_id);
                send(&client, conn, &url, &username, password, &session_id, &query_id, statement, None).await?;
            }

            let query_id = uuid::Uuid::new_v4().to_string();
            register_kill(guard, &client, &url, &username, password, &query_id);
            let (body, summary) = send(
                &client, conn, &url, &username, password, &session_id, &query_id, last, Some(row_limit),
            )
            .await?;
            parse_response(&body, summary.as_deref(), row_limit)
        })
        .await
}

/// Run a whole script in one ClickHouse session and report every statement separately.
pub async fn execute_script(
    conn: &ConnectionParams,
    password: &str,
    statements: &[String],
    row_limit: usize,
    guard: &Guard<'_>,
) -> Result<Vec<StatementOutcome>, String> {
    if statements.is_empty() {
        return Err("No SQL statements to execute".to_string());
    }
    let url = base_url(conn)?;
    let client = build_client(conn)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let username = conn.username.trim().to_string();

    guard
        .run(async {
            let mut outcomes = Vec::with_capacity(statements.len());
            for statement in statements {
                let started = std::time::Instant::now();
                let query_id = uuid::Uuid::new_v4().to_string();
                register_kill(guard, &client, &url, &username, password, &query_id);
                let outcome = match send(
                    &client, conn, &url, &username, password, &session_id, &query_id, statement, Some(row_limit),
                )
                .await
                {
                    Ok((body, summary)) => parse_response(&body, summary.as_deref(), row_limit),
                    Err(message) => Err(message),
                };
                let elapsed_ms = started.elapsed().as_millis() as u64;
                match outcome {
                    Ok(result) => outcomes.push(StatementOutcome {
                        sql: statement.clone(),
                        elapsed_ms,
                        result: Some(result),
                        error: None,
                    }),
                    Err(message) => {
                        outcomes.push(StatementOutcome {
                            sql: statement.clone(),
                            elapsed_ms,
                            result: None,
                            error: Some(describe_statement_error(message)),
                        });
                        break;
                    }
                }
            }
            Ok(outcomes)
        })
        .await
}

/// ClickHouse errors look like `Code: 62. DB::Exception: Syntax error: failed at position 8 (...)`.
pub fn describe_statement_error(message: String) -> StatementError {
    let code = message
        .strip_prefix("Code: ")
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .filter(|digits| !digits.is_empty())
        .map(|digits| format!("CH {digits}"));
    let position = message
        .split("failed at position ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse::<u32>().ok());
    StatementError { message, code, position }
}

fn register_kill(guard: &Guard<'_>, client: &Client, url: &Url, username: &str, password: &str, query_id: &str) {
    guard.set_killer(Killer::ClickHouse(Kill {
        client: client.clone(),
        url: url.clone(),
        username: username.to_string(),
        password: password.to_string(),
        query_id: query_id.to_string(),
    }));
}

#[allow(clippy::too_many_arguments)]
async fn send(
    client: &Client,
    conn: &ConnectionParams,
    url: &Url,
    username: &str,
    password: &str,
    session_id: &str,
    query_id: &str,
    statement: &str,
    row_limit: Option<usize>,
) -> Result<(String, Option<String>), String> {
    let mut params: Vec<(&str, String)> = vec![
        ("session_id", session_id.to_string()),
        ("query_id", query_id.to_string()),
        ("default_format", "JSONCompact".to_string()),
        ("session_timeout", "3600".to_string()),
    ];
    if !conn.database.trim().is_empty() {
        params.push(("database", conn.database.trim().to_string()));
    }
    if conn.read_only {
        // 2 = read-only but settings (like the ones below) may still be changed.
        params.push(("readonly", "2".to_string()));
    }
    if conn.timeout_secs > 0 {
        params.push(("max_execution_time", conn.timeout_secs.to_string()));
    }
    if let Some(limit) = row_limit {
        params.push(("max_result_rows", limit.saturating_add(1).to_string()));
        params.push(("result_overflow_mode", "break".to_string()));
    }

    let mut request = client.post(url.clone()).query(&params).body(statement.to_string());
    if !username.is_empty() {
        request = request.basic_auth(username, Some(password));
    }

    let response = request.send().await.map_err(|e| describe_transport_error(&e))?;
    let status = response.status();
    let summary = response
        .headers()
        .get("x-clickhouse-summary")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.map_err(|e| describe_transport_error(&e))?;

    if !status.is_success() {
        return Err(describe_server_error(status.as_u16(), &body, conn.read_only));
    }
    Ok((body, summary))
}

fn describe_transport_error(error: &reqwest::Error) -> String {
    let mut message = if error.is_timeout() {
        "Request timed out".to_string()
    } else {
        error.to_string()
    };
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

fn describe_server_error(status: u16, body: &str, read_only: bool) -> String {
    let body = body.trim();
    if body.contains("QUERY_WAS_CANCELLED") {
        return CANCELLED.to_string();
    }
    let mut message = if body.is_empty() {
        format!("ClickHouse returned HTTP {status}")
    } else {
        body.to_string()
    };
    if status == 401 || status == 403 {
        message.push_str("\n\nCheck the username and password of this connection.");
    }
    if read_only && (body.contains("READONLY") || body.contains("Cannot execute query in readonly mode")) {
        message.push_str("\n\nThis connection is read-only. Edit the connection to allow writes.");
    }
    message
}

pub fn parse_response(body: &str, summary: Option<&str>, row_limit: usize) -> Result<QueryResult, String> {
    if body.trim().is_empty() {
        return Ok(QueryResult::message(summary_message(summary)));
    }

    let response: Response = serde_json::from_str(body)
        .map_err(|e| format!("Unexpected response from ClickHouse: {e}"))?;

    let columns = response
        .meta
        .iter()
        .map(|m| ColumnMeta {
            name: m.name.clone(),
            ui_type: ui_value_type(&m.ty).to_string(),
        })
        .collect();

    let truncated = response.data.len() > row_limit;
    let rows = response
        .data
        .iter()
        .take(row_limit)
        .map(|row| row.iter().map(|cell| cell_text(cell)).collect())
        .collect();

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        message: None,
    })
}

fn summary_message(summary: Option<&str>) -> String {
    let written = summary
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("written_rows").and_then(|w| w.as_str().map(str::to_string)))
        .and_then(|w| w.parse::<u64>().ok())
        .unwrap_or(0);
    if written > 0 {
        format!("{written} row{} written", if written == 1 { "" } else { "s" })
    } else {
        "Statement executed".to_string()
    }
}

/// Raw JSON value -> display text: strings are unquoted, numbers keep their exact literal
/// (no float round trip), arrays/objects stay JSON text, null is SQL NULL.
fn cell_text(raw: &RawValue) -> Option<String> {
    let text = raw.get();
    match text.as_bytes().first() {
        Some(b'n') => None,
        Some(b'"') => serde_json::from_str::<String>(text).ok(),
        _ => Some(text.to_string()),
    }
}

pub fn ui_value_type(clickhouse_type: &str) -> &'static str {
    let mut ty = clickhouse_type.trim();
    loop {
        let inner = ["Nullable(", "LowCardinality("]
            .iter()
            .find_map(|wrapper| ty.strip_prefix(wrapper).and_then(|rest| rest.strip_suffix(')')));
        match inner {
            Some(inner) => ty = inner.trim(),
            None => break,
        }
    }

    if ty == "Bool" {
        "bool"
    } else if ty.starts_with("Array(")
        || ty.starts_with("Tuple(")
        || ty.starts_with("Map(")
        || ty.starts_with("Nested(")
        || ty.starts_with("Object(")
        || ty == "JSON"
        || ty.starts_with("JSON(")
    {
        "json"
    } else if ty.starts_with("DateTime") {
        if ty.contains('\'') { "timestamp tz" } else { "timestamp" }
    } else if ty.starts_with("Date") {
        "timestamp"
    } else if ty.starts_with("Int")
        || ty.starts_with("UInt")
        || ty.starts_with("Float")
        || ty.starts_with("Decimal")
        || ty.starts_with("BFloat")
    {
        "number"
    } else {
        "string"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_keep_exact_literals_and_nulls() {
        let body = r#"{"meta":[{"name":"id","type":"UInt64"},{"name":"s","type":"Nullable(String)"},{"name":"a","type":"Array(Int32)"},{"name":"f","type":"Float64"}],
            "data":[["18446744073709551615","he said \"hi\"",[1,2,3],1.50],["1",null,[],0.1]],"rows":2}"#;
        let result = parse_response(body, None, 10).unwrap();
        assert_eq!(result.columns.len(), 4);
        assert_eq!(result.columns[2].ui_type, "json");
        assert_eq!(result.columns[0].ui_type, "number");
        assert_eq!(result.rows[0][0].as_deref(), Some("18446744073709551615"));
        assert_eq!(result.rows[0][1].as_deref(), Some("he said \"hi\""));
        assert_eq!(result.rows[0][2].as_deref(), Some("[1,2,3]"));
        assert_eq!(result.rows[0][3].as_deref(), Some("1.50"));
        assert_eq!(result.rows[1][1], None);
        assert!(!result.truncated);
    }

    #[test]
    fn extra_rows_are_cut_and_flagged() {
        let body = r#"{"meta":[{"name":"n","type":"UInt8"}],"data":[[1],[2],[3]]}"#;
        let result = parse_response(body, None, 2).unwrap();
        assert_eq!(result.rows.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn empty_body_is_a_statement_message() {
        let result = parse_response("", Some(r#"{"read_rows":"0","written_rows":"3"}"#), 10).unwrap();
        assert_eq!(result.message.as_deref(), Some("3 rows written"));
        assert!(result.columns.is_empty());
        assert_eq!(parse_response("\n", None, 10).unwrap().message.as_deref(), Some("Statement executed"));
    }

    #[test]
    fn error_code_and_position_are_extracted() {
        let e = describe_statement_error("Code: 62. DB::Exception: Syntax error: failed at position 8 ('frm')".to_string());
        assert_eq!(e.code.as_deref(), Some("CH 62"));
        assert_eq!(e.position, Some(8));
        let e = describe_statement_error("Request timed out".to_string());
        assert_eq!((e.code, e.position), (None, None));
    }

    #[test]
    fn type_mapping() {
        assert_eq!(ui_value_type("LowCardinality(Nullable(String))"), "string");
        assert_eq!(ui_value_type("Nullable(Int64)"), "number");
        assert_eq!(ui_value_type("Decimal(10, 2)"), "number");
        assert_eq!(ui_value_type("Map(String, UInt8)"), "json");
        assert_eq!(ui_value_type("Bool"), "bool");
        assert_eq!(ui_value_type("DateTime"), "timestamp");
        assert_eq!(ui_value_type("DateTime64(3, 'UTC')"), "timestamp tz");
        assert_eq!(ui_value_type("Date"), "timestamp");
        assert_eq!(ui_value_type("UUID"), "string");
    }

    fn params(host: &str, port: &str, ssl: SslMode) -> ConnectionParams {
        serde_json::from_value(serde_json::json!({
            "id": "x", "host": host, "port": port, "username": "u", "database": "d",
            "db_type": "clickhouse",
            "ssl_mode": match ssl { SslMode::Disable => "disable", SslMode::Prefer => "prefer", SslMode::Require => "require", SslMode::VerifyCa => "verify-ca", SslMode::Verify => "verify" },
        }))
        .unwrap()
    }

    #[test]
    fn base_url_handles_schemes_and_ipv6() {
        assert_eq!(base_url(&params("ch.local", "8123", SslMode::Disable)).unwrap().as_str(), "http://ch.local:8123/");
        assert_eq!(base_url(&params("https://ch.local/", "8443", SslMode::Verify)).unwrap().as_str(), "https://ch.local:8443/");
        assert_eq!(base_url(&params("::1", "8123", SslMode::Disable)).unwrap().as_str(), "http://[::1]:8123/");
        assert!(base_url(&params("", "8123", SslMode::Disable)).is_err());
        assert!(base_url(&params("h", "abc", SslMode::Disable)).is_err());
    }

    #[test]
    fn server_errors_are_readable() {
        assert_eq!(describe_server_error(500, "Code: 394. DB::Exception: QUERY_WAS_CANCELLED", false), CANCELLED);
        assert!(describe_server_error(401, "Code: 516. Authentication failed", false).contains("username and password"));
    }
}

/// Integration tests against a real server. Skipped unless `SAURON_TEST_CH_PORT` is set, e.g.
/// `SAURON_TEST_CH_PORT=18123 SAURON_TEST_CH_USER=sauron SAURON_TEST_CH_PASSWORD=secret cargo test integration`
/// (needs a table `default.t(id UInt64, s String)` with 2500 rows).
#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::cancel::Registry;

    fn conn(read_only: bool, timeout_secs: u64) -> Option<(ConnectionParams, String)> {
        let port = std::env::var("SAURON_TEST_CH_PORT").ok()?;
        let params = serde_json::from_value(serde_json::json!({
            "id": "test", "host": "127.0.0.1", "port": port,
            "username": std::env::var("SAURON_TEST_CH_USER").unwrap_or_else(|_| "default".into()),
            "database": "default", "db_type": "clickhouse", "ssl_mode": "disable",
            "read_only": read_only, "timeout_secs": timeout_secs,
        }))
        .unwrap();
        Some((params, std::env::var("SAURON_TEST_CH_PASSWORD").unwrap_or_default()))
    }

    async fn run(c: &(ConnectionParams, String), sql: &[&str], limit: usize) -> Result<QueryResult, String> {
        let registry = Registry::default();
        let guard = registry.begin();
        let statements: Vec<String> = sql.iter().map(|s| s.to_string()).collect();
        execute(&c.0, &c.1, &statements, limit, &guard).await
    }

    #[tokio::test]
    async fn values_keep_exact_text() {
        let Some(c) = conn(true, 0) else { return };
        let r = run(&c, &["select toUInt64(18446744073709551615) as id, [1,2] as a, 'x' as s, NULL as n, toDecimal64(1.50, 2) as d, map('k', 1) as m"], 10)
            .await
            .unwrap();
        let row = &r.rows[0];
        assert_eq!(row[0].as_deref(), Some("18446744073709551615"));
        assert_eq!(row[1].as_deref(), Some("[1,2]"));
        assert_eq!(row[2].as_deref(), Some("x"));
        assert_eq!(row[3], None);
        assert_eq!(r.columns[1].ui_type, "json");
        assert_eq!(r.columns[5].ui_type, "json");
    }

    #[tokio::test]
    async fn row_limit_and_sessions() {
        let Some(c) = conn(true, 0) else { return };
        let r = run(&c, &["select * from t order by id"], 100).await.unwrap();
        assert_eq!(r.rows.len(), 100);
        assert!(r.truncated);
        let all = run(&c, &["select * from t"], 5000).await.unwrap();
        assert_eq!(all.rows.len(), 2500);
        assert!(!all.truncated);
        // SET in an earlier statement is visible to the next one (same session)
        let r = run(&c, &["set max_threads = 3", "select getSetting('max_threads')"], 10).await.unwrap();
        assert_eq!(r.rows[0][0].as_deref(), Some("3"));
    }

    #[tokio::test]
    async fn ddl_and_writes_work_when_not_read_only_and_fail_when_read_only() {
        let Some(rw) = conn(false, 0) else { return };
        let r = run(&rw, &["create table if not exists default.tmp_w (a UInt8) engine=Memory"], 10).await.unwrap();
        assert_eq!(r.message.as_deref(), Some("Statement executed"));
        let r = run(&rw, &["insert into default.tmp_w values (1),(2),(3)"], 10).await.unwrap();
        assert_eq!(r.message.as_deref(), Some("3 rows written"));
        run(&rw, &["drop table default.tmp_w"], 10).await.unwrap();

        let ro = conn(true, 0).unwrap();
        let err = run(&ro, &["create table default.tmp_ro (a UInt8) engine=Memory"], 10).await.unwrap_err();
        assert!(err.contains("read-only"), "{err}");
    }

    #[tokio::test]
    async fn errors_and_auth_are_readable() {
        let Some(mut c) = conn(true, 0) else { return };
        let err = run(&c, &["select * from nope"], 10).await.unwrap_err();
        assert!(err.contains("nope"), "{err}");
        c.1 = "wrong".to_string();
        let err = run(&c, &["select 1"], 10).await.unwrap_err();
        assert!(err.contains("username and password"), "{err}");
    }

    #[tokio::test]
    async fn timeout_and_cancel() {
        let Some(c) = conn(true, 1) else { return };
        let err = run(&c, &["select sleep(3)"], 10).await.unwrap_err();
        assert!(err.contains("TIMEOUT") || err.to_lowercase().contains("timeout") || err.contains("execution"), "{err}");

        let c = conn(true, 0).unwrap();
        let registry = std::sync::Arc::new(Registry::default());
        let guard = registry.begin();
        let statements = vec!["select sleep(3), count() from numbers(100000000000)".to_string()];
        let canceller = {
            let registry = registry.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                registry.cancel().await;
            }
        };
        let started = std::time::Instant::now();
        let (result, _) = tokio::join!(execute(&c.0, &c.1, &statements, 10, &guard), canceller);
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(started.elapsed().as_secs() < 3);
    }
}
