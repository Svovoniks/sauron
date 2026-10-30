use std::time::Duration;

use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, Config, SimpleQueryMessage, SimpleQueryRow};

use crate::cancel::{Guard, Killer};
use crate::client_cert;
use crate::model::{ColumnMeta, ConnectionParams, QueryResult, SslMode, StatementError, StatementOutcome, CANCELLED};

const CURSOR_NAME: &str = "sauron_cursor";

pub fn tls_connector(conn: &ConnectionParams) -> Result<MakeTlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    match conn.ssl_mode {
        SslMode::Verify => {}
        SslMode::VerifyCa => {
            builder.danger_accept_invalid_hostnames(true);
        }
        // Same semantics as libpq's `require`: encrypt, but do not validate the certificate.
        SslMode::Disable | SslMode::Prefer | SslMode::Require => {
            builder
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true);
        }
    }
    client_cert::configure(&mut builder, conn)?;
    let connector = builder.build().map_err(|e| e.to_string())?;
    Ok(MakeTlsConnector::new(connector))
}

pub fn build_config(conn: &ConnectionParams, password: &str) -> Result<Config, String> {
    let mut cfg = Config::new();
    cfg.host(conn.host_trimmed()?)
        .port(conn.port_number()?)
        .application_name("sauron")
        .connect_timeout(Duration::from_secs(10))
        .keepalives(true);
    if !conn.username.trim().is_empty() {
        cfg.user(conn.username.trim());
    }
    if !conn.database.trim().is_empty() {
        cfg.dbname(conn.database.trim());
    }
    if !password.is_empty() {
        cfg.password(password);
    }
    cfg.ssl_mode(match conn.ssl_mode {
        SslMode::Disable => tokio_postgres::config::SslMode::Disable,
        SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
        SslMode::Require | SslMode::VerifyCa | SslMode::Verify => tokio_postgres::config::SslMode::Require,
    });
    Ok(cfg)
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
    guard
        .run(async {
            let client = connect_session(conn, password, guard).await?;
            run_statements(&client, statements, row_limit, conn.read_only).await
        })
        .await
}

/// Did the connection die while negotiating TLS (as opposed to a wrong password, an unreachable host or a timeout)?
fn tls_attempt_failed(e: &tokio_postgres::Error) -> bool {
    if e.as_db_error().is_some() {
        return false;
    }
    let text = format!("{e:?} {e}").to_lowercase();
    ["tls", "ssl", "eof", "closed", "reset"].iter().any(|needle| text.contains(needle))
}

/// Connect, register the cancel token and apply the connection's read-only / timeout settings.
pub async fn connect_session(
    conn: &ConnectionParams,
    password: &str,
    guard: &Guard<'_>,
) -> Result<Client, String> {
    let mut cfg = build_config(conn, password)?;
    client_cert::renew_if_expired(conn).await?;
    let tls = tls_connector(conn)?;

    let (client, connection) = match cfg.connect(tls.clone()).await {
        Ok(connected) => connected,
        // libpq's `prefer` also retries without TLS when the server offers it but the handshake then fails
        // (old TLS version, a proxy that accepts SSL but cannot finish it); tokio-postgres only falls back on a plain "no".
        Err(e) if conn.ssl_mode == SslMode::Prefer && tls_attempt_failed(&e) => {
            cfg.ssl_mode(tokio_postgres::config::SslMode::Disable);
            cfg.connect(tls.clone()).await.map_err(describe_error)?
        }
        Err(e) => return Err(describe_error(e)),
    };
    tokio::spawn(async move {
        let _ = connection.await;
    });
    guard.set_killer(Killer::Postgres {
        token: client.cancel_token(),
        tls,
    });

    let mut setup = String::new();
    if conn.read_only {
        setup.push_str("SET default_transaction_read_only = on;");
    }
    if conn.timeout_secs > 0 {
        setup.push_str(&format!(
            "SET statement_timeout = {};",
            conn.timeout_secs.saturating_mul(1000)
        ));
    }
    if !setup.is_empty() {
        client.batch_execute(&setup).await.map_err(describe_error)?;
    }
    Ok(client)
}

/// Run one row-returning statement and return all of it (no row limit; for small catalog queries).
pub async fn query_table(client: &Client, sql: &str, read_only: bool) -> Result<QueryResult, String> {
    let prepared = client.prepare(sql).await.map_err(|e| describe_error_ro(e, read_only))?;
    let columns: Vec<(ColumnMeta, Type)> = prepared
        .columns()
        .iter()
        .map(|c| {
            (
                ColumnMeta {
                    name: c.name().to_string(),
                    ui_type: ui_value_type(c.type_()).to_string(),
                },
                c.type_().clone(),
            )
        })
        .collect();
    let messages = client
        .simple_query(&terminated(sql))
        .await
        .map_err(|e| describe_error_ro(e, read_only))?;
    let (rows, _) = collect_rows(messages);
    let types: Vec<&Type> = columns.iter().map(|(_, ty)| ty).collect();
    let rows = rows
        .iter()
        .map(|row| decode_row(row, &types))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(QueryResult {
        columns: columns.into_iter().map(|(meta, _)| meta).collect(),
        rows,
        truncated: false,
        message: None,
    })
}

async fn run_statements(
    client: &Client,
    statements: &[String],
    row_limit: usize,
    read_only: bool,
) -> Result<QueryResult, String> {
    let (last, earlier) = statements.split_last().ok_or("No SQL statements to execute")?;

    for statement in earlier {
        client
            .batch_execute(&terminated(statement))
            .await
            .map_err(|e| describe_error_ro(e, read_only))?;
    }

    run_one(client, last, row_limit, read_only, false)
        .await
        .map_err(|e| e.message)
}

/// Run a whole script in one session and report every statement separately. Stops at the first error.
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
    guard
        .run(async {
            let client = connect_session(conn, password, guard).await?;
            let mut outcomes = Vec::with_capacity(statements.len());
            let mut in_transaction = false;
            for statement in statements {
                let started = std::time::Instant::now();
                let outcome = run_one(&client, statement, row_limit, conn.read_only, in_transaction).await;
                in_transaction = transaction_state_after(statement, in_transaction);
                let elapsed_ms = started.elapsed().as_millis() as u64;
                match outcome {
                    Ok(result) => outcomes.push(StatementOutcome {
                        sql: statement.clone(),
                        elapsed_ms,
                        result: Some(result),
                        error: None,
                    }),
                    Err(error) => {
                        outcomes.push(StatementOutcome {
                            sql: statement.clone(),
                            elapsed_ms,
                            result: None,
                            error: Some(error),
                        });
                        break;
                    }
                }
            }
            Ok(outcomes)
        })
        .await
}

/// Does a statement open or close an explicit transaction? (Row fetching must not use its own
/// BEGIN / ROLLBACK inside the user's transaction: that would undo their work.)
pub fn transaction_state_after(statement: &str, in_transaction: bool) -> bool {
    let words: Vec<String> = statement
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .take(4)
        .map(str::to_ascii_lowercase)
        .collect();
    let keyword = first_keyword(statement);
    match keyword.as_str() {
        "begin" | "start" => true,
        "commit" | "end" if !words.iter().any(|w| w == "prepared") => false,
        "abort" => false,
        "rollback" if words.iter().any(|w| w == "prepared") => in_transaction,
        "rollback" if words.iter().any(|w| w == "to") => in_transaction,
        "rollback" => false,
        _ => in_transaction,
    }
}

fn statement_error(error: tokio_postgres::Error, read_only: bool) -> StatementError {
    let (code, position) = match error.as_db_error() {
        Some(db) => (
            Some(db.code().code().to_string()),
            match db.position() {
                Some(ErrorPosition::Original(position)) => Some(*position),
                _ => None,
            },
        ),
        None => (None, None),
    };
    StatementError {
        message: describe_error_ro(error, read_only),
        code,
        position,
    }
}

async fn run_one(
    client: &Client,
    statement: &str,
    row_limit: usize,
    read_only: bool,
    in_transaction: bool,
) -> Result<QueryResult, StatementError> {
    let prepared = client
        .prepare(statement)
        .await
        .map_err(|e| statement_error(e, read_only))?;

    let columns: Vec<(ColumnMeta, Type)> = prepared
        .columns()
        .iter()
        .map(|column| {
            (
                ColumnMeta {
                    name: column.name().to_string(),
                    ui_type: ui_value_type(column.type_()).to_string(),
                },
                column.type_().clone(),
            )
        })
        .collect();

    if columns.is_empty() {
        let messages = client
            .simple_query(&terminated(statement))
            .await
            .map_err(|e| statement_error(e, read_only))?;
        return Ok(QueryResult::message(command_message(statement, &messages)));
    }

    let (rows, truncated) = if starts_like_query(statement) && !in_transaction {
        fetch_via_cursor(client, statement, row_limit, read_only).await?
    } else {
        let messages = client
            .simple_query(&terminated(statement))
            .await
            .map_err(|e| statement_error(e, read_only))?;
        collect_rows(messages)
    };

    let types: Vec<&Type> = columns.iter().map(|(_, ty)| ty).collect();
    let mut truncated = truncated;
    let mut out = Vec::with_capacity(rows.len().min(row_limit + 1));
    for row in &rows {
        if out.len() >= row_limit {
            truncated = true;
            break;
        }
        out.push(decode_row(row, &types)?);
    }

    Ok(QueryResult {
        columns: columns.into_iter().map(|(meta, _)| meta).collect(),
        rows: out,
        truncated,
        message: None,
    })
}

/// Read at most `row_limit + 1` rows through a server-side cursor so a huge table never has
/// to be transferred (or held in memory) just to be shown. Falls back to running the
/// statement directly for statements a cursor cannot wrap (e.g. data-modifying CTEs).
async fn fetch_via_cursor(
    client: &Client,
    statement: &str,
    row_limit: usize,
    read_only: bool,
) -> Result<(Vec<SimpleQueryRow>, bool), StatementError> {
    client
        .batch_execute("BEGIN")
        .await
        .map_err(|e| statement_error(e, read_only))?;

    let declare = format!(
        "DECLARE {CURSOR_NAME} NO SCROLL CURSOR FOR\n{}\n",
        statement.trim_end_matches(';')
    );
    if let Err(e) = client.batch_execute(&declare).await {
        let _ = client.batch_execute("ROLLBACK").await;
        if e.code() == Some(&SqlState::FEATURE_NOT_SUPPORTED) || e.code() == Some(&SqlState::SYNTAX_ERROR) {
            let messages = client
                .simple_query(&terminated(statement))
                .await
                .map_err(|e| statement_error(e, read_only))?;
            return Ok(collect_rows(messages));
        }
        return Err(describe_error_ro(e, read_only).into());
    }

    let fetch = format!("FETCH FORWARD {} FROM {CURSOR_NAME}", row_limit.saturating_add(1));
    let messages = client.simple_query(&fetch).await;
    let _ = client.batch_execute("ROLLBACK").await;
    Ok(collect_rows(messages.map_err(|e| statement_error(e, read_only))?))
}

fn collect_rows(messages: Vec<SimpleQueryMessage>) -> (Vec<SimpleQueryRow>, bool) {
    let rows = messages
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(row) => Some(row),
            _ => None,
        })
        .collect();
    (rows, false)
}

fn decode_row(row: &SimpleQueryRow, types: &[&Type]) -> Result<Vec<Option<String>>, String> {
    types
        .iter()
        .enumerate()
        .map(|(i, ty)| {
            row.try_get(i)
                .map_err(|e| e.to_string())
                .map(|value| value.map(|v| normalize_text_value(ty, v)))
        })
        .collect()
}

/// Statements are sent as-is; a trailing `-- comment` must not swallow whatever follows.
fn terminated(statement: &str) -> String {
    format!("{statement}\n")
}

fn command_message(statement: &str, messages: &[SimpleQueryMessage]) -> String {
    let affected: u64 = messages
        .iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::CommandComplete(n) => Some(*n),
            _ => None,
        })
        .sum();
    match first_keyword(statement).as_str() {
        "insert" | "update" | "delete" | "merge" | "copy" => {
            format!("{affected} row{} affected", if affected == 1 { "" } else { "s" })
        }
        _ => "Statement executed".to_string(),
    }
}

/// Lower-cased first word of a statement, skipping whitespace, comments and opening parens.
pub fn first_keyword(statement: &str) -> String {
    let bytes = statement.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b if b.is_ascii_whitespace() || b == b'(' => i += 1,
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let mut depth = 1;
                i += 2;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            _ => break,
        }
    }
    statement[i.min(statement.len())..]
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Can this statement be wrapped in `DECLARE ... CURSOR`?
pub fn starts_like_query(statement: &str) -> bool {
    matches!(first_keyword(statement).as_str(), "select" | "with" | "values" | "table")
}

fn describe_error(error: tokio_postgres::Error) -> String {
    describe_error_ro(error, false)
}

fn describe_error_ro(error: tokio_postgres::Error, read_only: bool) -> String {
    let Some(db) = error.as_db_error() else {
        // Connection level problems: surface the whole chain, not just "error connecting to server".
        let mut message = error.to_string();
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            message.push_str(": ");
            message.push_str(&cause.to_string());
            source = cause.source();
        }
        return message;
    };

    if *db.code() == SqlState::QUERY_CANCELED && db.message().contains("user request") {
        return CANCELLED.to_string();
    }

    let mut message = format!("{}: {}", db.severity(), db.message());
    if let Some(detail) = db.detail() {
        message.push_str(&format!("\nDETAIL: {detail}"));
    }
    if let Some(hint) = db.hint() {
        message.push_str(&format!("\nHINT: {hint}"));
    }
    if read_only && *db.code() == SqlState::READ_ONLY_SQL_TRANSACTION {
        message.push_str("\n\nThis connection is read-only. Edit the connection to allow writes.");
    }
    message
}

pub fn ui_value_type(pg_type: &Type) -> &'static str {
    match pg_type.kind() {
        Kind::Array(_) => return "array",
        Kind::Domain(inner) => return ui_value_type(inner),
        _ => {}
    }

    match *pg_type {
        Type::BOOL => "bool",
        Type::INT2 | Type::INT4 | Type::INT8 | Type::FLOAT4 | Type::FLOAT8 | Type::OID | Type::NUMERIC => "number",
        Type::TIMESTAMP => "timestamp",
        Type::TIMESTAMPTZ => "timestamp tz",
        Type::JSONB | Type::JSON => "json",
        _ => "string",
    }
}

pub fn normalize_text_value(pg_type: &Type, value: &str) -> String {
    if let Kind::Domain(inner) = pg_type.kind() {
        return normalize_text_value(inner, value);
    }

    if *pg_type == Type::BOOL {
        return match value {
            "t" => "true".to_string(),
            "f" => "false".to_string(),
            _ => value.to_string(),
        };
    }

    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_keyword_skips_comments_and_parens() {
        assert_eq!(first_keyword("  SELECT 1"), "select");
        assert_eq!(first_keyword("-- hi\n/* x /* nested */ y */ (with a as (select 1)) select"), "with");
        assert_eq!(first_keyword("/* unterminated"), "");
        assert_eq!(first_keyword(""), "");
    }

    #[test]
    fn explicit_transactions_are_tracked() {
        assert!(transaction_state_after("BEGIN", false));
        assert!(transaction_state_after("start transaction isolation level serializable", false));
        assert!(!transaction_state_after("commit", true));
        assert!(!transaction_state_after("END;", true));
        assert!(!transaction_state_after("rollback", true));
        assert!(transaction_state_after("rollback to savepoint a", true));
        assert!(transaction_state_after("select 1", true));
        assert!(!transaction_state_after("select 1", false));
        assert!(transaction_state_after("commit prepared 'x'", true));
    }

    #[test]
    fn cursor_is_only_used_for_plain_queries() {
        assert!(starts_like_query("select * from t"));
        assert!(starts_like_query("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(starts_like_query("(select 1) union (select 2)"));
        assert!(starts_like_query("values (1)"));
        assert!(!starts_like_query("insert into t values (1) returning id"));
        assert!(!starts_like_query("explain select 1"));
        assert!(!starts_like_query("show all"));
    }

    #[test]
    fn bool_and_domain_values_are_normalised() {
        assert_eq!(normalize_text_value(&Type::BOOL, "t"), "true");
        assert_eq!(normalize_text_value(&Type::BOOL, "f"), "false");
        assert_eq!(normalize_text_value(&Type::TEXT, "t"), "t");
    }

    #[test]
    fn int8_and_numeric_are_displayed_as_text_numbers() {
        assert_eq!(ui_value_type(&Type::INT8), "number");
        assert_eq!(ui_value_type(&Type::NUMERIC), "number");
        assert_eq!(ui_value_type(&Type::INT4_ARRAY), "array");
        assert_eq!(ui_value_type(&Type::JSONB), "json");
    }
}

/// Integration tests against a real server. Skipped unless `SAURON_TEST_PG_PORT` is set, e.g.
/// `SAURON_TEST_PG_PORT=54329 SAURON_TEST_PG_USER=sauron cargo test -- --nocapture`
/// (the server needs a table `t(id bigint, name text, flag bool, arr int[], j jsonb)` with 2500 rows).
#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::cancel::Registry;

    fn conn(ssl: &str, read_only: bool, timeout_secs: u64) -> Option<ConnectionParams> {
        let port = std::env::var("SAURON_TEST_PG_PORT").ok()?;
        Some(
            serde_json::from_value(serde_json::json!({
                "id": "test", "host": "127.0.0.1", "port": port,
                "username": std::env::var("SAURON_TEST_PG_USER").unwrap_or_else(|_| "postgres".into()),
                "database": "postgres", "db_type": "postgres",
                "ssl_mode": ssl, "read_only": read_only, "timeout_secs": timeout_secs,
            }))
            .unwrap(),
        )
    }

    async fn run(conn: &ConnectionParams, sql: &[&str], limit: usize) -> Result<QueryResult, String> {
        let registry = Registry::default();
        let guard = registry.begin();
        let statements: Vec<String> = sql.iter().map(|s| s.to_string()).collect();
        execute(conn, "", &statements, limit, &guard).await
    }

    async fn script(conn: &ConnectionParams, sql: &[&str], limit: usize) -> Result<Vec<StatementOutcome>, String> {
        let registry = Registry::default();
        let guard = registry.begin();
        let statements: Vec<String> = sql.iter().map(|s| s.to_string()).collect();
        execute_script(conn, "", &statements, limit, &guard).await
    }

    #[tokio::test]
    async fn script_reports_every_statement_in_one_session() {
        let Some(c) = conn("disable", false, 0) else { return };
        let out = script(
            &c,
            &["create temp table sc(a int)", "insert into sc values (1), (2), (3)", "select * from sc order by a", "update sc set a = a + 1 where a > 1"],
            100,
        )
        .await
        .unwrap();
        assert_eq!(out.len(), 4);
        assert!(out.iter().all(|o| o.error.is_none()));
        // the temp table created by statement 1 is visible to the later ones: one session
        assert_eq!(out[1].result.as_ref().unwrap().message.as_deref(), Some("3 rows affected"));
        assert_eq!(out[2].result.as_ref().unwrap().rows.len(), 3);
        assert_eq!(out[3].result.as_ref().unwrap().message.as_deref(), Some("2 rows affected"));
    }

    #[tokio::test]
    async fn script_stops_at_the_first_error_and_reports_its_position() {
        let Some(c) = conn("disable", true, 0) else { return };
        let out = script(&c, &["select 1", "select id, nme from t", "select 3"], 10).await.unwrap();
        assert_eq!(out.len(), 2, "the statement after the failing one is not run");
        assert!(out[0].error.is_none());
        let error = out[1].error.as_ref().unwrap();
        assert_eq!(error.code.as_deref(), Some("42703"));
        assert_eq!(error.position, Some("select id, nme from t".find("nme").unwrap() as u32 + 1));
        assert!(error.message.contains("nme"));
    }

    #[tokio::test]
    async fn script_keeps_the_users_transaction_when_reading_rows() {
        let Some(c) = conn("disable", false, 0) else { return };
        // A select inside BEGIN must not be wrapped in its own BEGIN/ROLLBACK (that would undo the insert).
        let out = script(
            &c,
            &["create temp table tx(a int)", "begin", "insert into tx values (1)", "select * from tx", "commit", "select count(*) from tx"],
            100,
        )
        .await
        .unwrap();
        assert!(out.iter().all(|o| o.error.is_none()), "{:?}", out.iter().map(|o| &o.error).collect::<Vec<_>>());
        assert_eq!(out[3].result.as_ref().unwrap().rows.len(), 1);
        assert_eq!(out[5].result.as_ref().unwrap().rows[0][0].as_deref(), Some("1"), "the insert survived the select");
    }

    #[tokio::test]
    async fn script_row_limit_applies_per_statement() {
        let Some(c) = conn("disable", true, 0) else { return };
        let out = script(&c, &["select * from t order by id", "select 1"], 50).await.unwrap();
        let first = out[0].result.as_ref().unwrap();
        assert_eq!(first.rows.len(), 50);
        assert!(first.truncated);
        assert!(!out[1].result.as_ref().unwrap().truncated);
    }

    #[tokio::test]
    async fn test_connection_reports_each_step() {
        let Some(c) = conn("disable", true, 0) else { return };
        let registry = Registry::default();
        let guard = registry.begin();
        let report = crate::test_connection::run(&c, "", &guard).await;
        assert!(report.ok, "{:?}", report.steps);
        let names: Vec<_> = report.steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Resolve host", "Open TCP connection", "Encrypt and log in", "Server version", "Read-only mode"]);
        assert!(report.server_version.unwrap().starts_with("PostgreSQL"));

        let mut bad = c.clone();
        bad.port = "1".to_string();
        let registry = Registry::default();
        let guard = registry.begin();
        let report = crate::test_connection::run(&bad, "", &guard).await;
        assert!(!report.ok);
        assert_eq!(report.steps.last().unwrap().name, "Open TCP connection");
        assert!(!report.steps.last().unwrap().ok);
    }

    #[tokio::test]
    async fn duplicate_columns_nulls_and_big_numbers_survive() {
        let Some(c) = conn("disable", true, 0) else { return };
        let r = run(&c, &["select 9007199254740993::bigint as n, 1 as x, 2 as x, null::text as nothing, 'a' as s, true as b, 1.50::numeric as d, '<<null>>' as lit"], 10)
            .await
            .unwrap();
        let names: Vec<_> = r.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["n", "x", "x", "nothing", "s", "b", "d", "lit"]);
        let row = &r.rows[0];
        assert_eq!(row[0].as_deref(), Some("9007199254740993"));
        assert_eq!(row[3], None);
        assert_eq!(row[5].as_deref(), Some("true"));
        assert_eq!(row[6].as_deref(), Some("1.50"));
        assert_eq!(row[7].as_deref(), Some("<<null>>"));
        assert!(!r.truncated);
    }

    #[tokio::test]
    async fn row_limit_truncates_through_a_cursor() {
        let Some(c) = conn("disable", true, 0) else { return };
        let r = run(&c, &["select * from t order by id"], 100).await.unwrap();
        assert_eq!(r.rows.len(), 100);
        assert!(r.truncated);
        assert_eq!(r.rows[99][0].as_deref(), Some("100"));
        assert_eq!(r.columns[3].ui_type, "array");
        assert_eq!(r.rows[0][3].as_deref(), Some("{1,2}"));

        let all = run(&c, &["select * from t"], 5000).await.unwrap();
        assert_eq!(all.rows.len(), 2500);
        assert!(!all.truncated);

        let exact = run(&c, &["select * from t"], 2500).await.unwrap();
        assert_eq!(exact.rows.len(), 2500);
        assert!(!exact.truncated);
    }

    #[tokio::test]
    async fn trailing_comment_and_multi_statement_scripts_work() {
        let Some(c) = conn("disable", false, 0) else { return };
        let r = run(&c, &["create temp table tmp_x(a int)", "insert into tmp_x values (1),(2)", "select * from tmp_x -- trailing"], 10)
            .await
            .unwrap();
        assert_eq!(r.rows.len(), 2);
    }

    #[tokio::test]
    async fn writes_report_affected_rows_and_read_only_blocks_them() {
        let Some(rw) = conn("disable", false, 0) else { return };
        let r = run(&rw, &["create temp table tmp_y(a int)", "insert into tmp_y values (1),(2),(3)"], 10).await.unwrap();
        assert_eq!(r.message.as_deref(), Some("3 rows affected"));

        let Some(ro) = conn("disable", true, 0) else { return };
        let err = run(&ro, &["create temp table tmp_z(a int)"], 10).await.unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        let err = run(&ro, &["delete from t"], 10).await.unwrap_err();
        assert!(err.contains("read-only"), "{err}");
    }

    #[tokio::test]
    async fn data_modifying_cte_falls_back_to_direct_execution() {
        let Some(c) = conn("disable", false, 0) else { return };
        let r = run(&c, &["create temp table tmp_w(a int)", "with ins as (insert into tmp_w values (7) returning a) select * from ins"], 10)
            .await
            .unwrap();
        assert_eq!(r.rows, vec![vec![Some("7".to_string())]]);
    }

    #[tokio::test]
    async fn errors_are_readable() {
        let Some(c) = conn("disable", true, 0) else { return };
        let err = run(&c, &["select * from nope"], 10).await.unwrap_err();
        assert!(err.contains("relation \"nope\" does not exist"), "{err}");
    }

    #[tokio::test]
    async fn statement_timeout_is_applied() {
        let Some(c) = conn("disable", true, 1) else { return };
        let started = std::time::Instant::now();
        let err = run(&c, &["select pg_sleep(10)"], 10).await.unwrap_err();
        assert!(err.contains("statement timeout"), "{err}");
        assert!(started.elapsed().as_secs() < 5);
    }

    /// A server that agrees to SSL and then hangs up (what a proxy that cannot finish the handshake looks like) must count as a
    /// TLS failure so `prefer` retries in plain text; an unreachable host must not.
    #[tokio::test]
    async fn prefer_retries_only_after_a_failed_tls_handshake() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 8];
            socket.read_exact(&mut request).await.unwrap();
            socket.write_all(b"S").await.unwrap();
        });
        let mut cfg = tokio_postgres::Config::new();
        cfg.host("127.0.0.1").port(port).user("u").ssl_mode(tokio_postgres::config::SslMode::Prefer);
        let params: ConnectionParams = serde_json::from_value(serde_json::json!({
            "id": "test", "host": "127.0.0.1", "port": port.to_string(), "username": "u", "database": "",
            "db_type": "postgres", "ssl_mode": "prefer",
        }))
        .unwrap();
        let tls = tls_connector(&params).unwrap();
        let err = cfg.connect(tls.clone()).await.err().expect("the handshake cannot succeed");
        assert!(tls_attempt_failed(&err), "{err:?}");

        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        cfg.port(closed_port);
        let err = cfg.connect(tls).await.err().expect("nothing listens there");
        assert!(!tls_attempt_failed(&err), "{err:?}");
    }

    /// Client certificate login (pg_hba "cert"), the way the STG databases are reached. Skipped unless
    /// SAURON_TEST_PG_CERT_PORT and SAURON_TEST_PG_CERT_DIR (holding stepcaroot.pem, certificate.pem and
    /// private.pem) are set; the server certificate must be issued for a name other than 127.0.0.1.
    #[tokio::test]
    async fn client_certificate_login() {
        let (Ok(port), Ok(dir)) = (std::env::var("SAURON_TEST_PG_CERT_PORT"), std::env::var("SAURON_TEST_PG_CERT_DIR")) else {
            return;
        };
        let conn = |ssl: &str, with_client_cert: bool| -> ConnectionParams {
            let file = |name: &str| if with_client_cert || name == "stepcaroot.pem" { format!("{dir}/{name}") } else { String::new() };
            serde_json::from_value(serde_json::json!({
                "id": "test", "host": "127.0.0.1", "port": port,
                "username": std::env::var("SAURON_TEST_PG_USER").unwrap_or_else(|_| "sauron".into()),
                "database": "postgres", "db_type": "postgres", "ssl_mode": ssl,
                "ssl_root_cert": file("stepcaroot.pem"), "ssl_cert": file("certificate.pem"), "ssl_key": file("private.pem"),
            }))
            .unwrap()
        };
        let sql = ["select ssl, client_dn is not null from pg_stat_ssl where pid = pg_backend_pid()"];
        let row = run(&conn("verify-ca", true), &sql, 1).await.unwrap().rows.remove(0);
        assert_eq!(row, vec![Some("true".to_string()), Some("true".to_string())]);
        // verify-ca does not check the host name, full verification does
        let err = run(&conn("verify", true), &sql, 1).await.unwrap_err();
        assert!(!err.is_empty());
        // the server insists on a client certificate
        assert!(run(&conn("verify-ca", false), &sql, 1).await.is_err());
    }

    #[tokio::test]
    async fn tls_modes() {
        let Some(c) = conn("require", true, 0) else { return };
        assert_eq!(run(&c, &["select ssl from pg_stat_ssl where pid = pg_backend_pid()"], 1).await.unwrap().rows[0][0].as_deref(), Some("true"));
        let c = conn("prefer", true, 0).unwrap();
        assert_eq!(run(&c, &["select ssl from pg_stat_ssl where pid = pg_backend_pid()"], 1).await.unwrap().rows[0][0].as_deref(), Some("true"));
        let c = conn("disable", true, 0).unwrap();
        assert_eq!(run(&c, &["select ssl from pg_stat_ssl where pid = pg_backend_pid()"], 1).await.unwrap().rows[0][0].as_deref(), Some("false"));
        // self-signed certificate must fail full verification
        let c = conn("verify", true, 0).unwrap();
        assert!(run(&c, &["select 1"], 1).await.is_err());
    }

    #[tokio::test]
    async fn cancel_stops_a_running_query_and_does_not_affect_the_next_one() {
        let Some(c) = conn("disable", true, 0) else { return };
        let registry = std::sync::Arc::new(Registry::default());

        let started = std::time::Instant::now();
        let guard = registry.begin();
        let statements = vec!["select pg_sleep(30)".to_string()];
        let canceller = {
            let registry = registry.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                registry.cancel().await;
            }
        };
        let (result, _) = tokio::join!(execute(&c, "", &statements, 10, &guard), canceller);
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(started.elapsed().as_secs() < 5);
        drop(guard);

        // an extra cancel while nothing runs must not poison the next query
        registry.cancel().await;
        let guard = registry.begin();
        let ok = execute(&c, "", &["select 1".to_string()], 10, &guard).await.unwrap();
        assert_eq!(ok.rows.len(), 1);
    }

    #[tokio::test]
    async fn abort_while_connecting_returns_promptly() {
        let Some(mut c) = conn("disable", true, 0) else { return };
        c.host = "10.255.255.1".to_string(); // black hole: connect hangs
        let registry = std::sync::Arc::new(Registry::default());
        let guard = registry.begin();
        let statements = vec!["select 1".to_string()];
        let canceller = {
            let registry = registry.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                registry.cancel().await;
            }
        };
        let started = std::time::Instant::now();
        let (result, _) = tokio::join!(execute(&c, "", &statements, 10, &guard), canceller);
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(started.elapsed().as_secs() < 3);
        drop(guard);

        // and the following query is unaffected
        let c = conn("disable", true, 0).unwrap();
        let guard = registry.begin();
        assert!(execute(&c, "", &["select 1".to_string()], 10, &guard).await.is_ok());
    }
}
