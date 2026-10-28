//! MCP server for AI agents: `sauron --mcp` speaks the Model Context Protocol (JSON-RPC 2.0, one message per line)
//! over stdin / stdout instead of opening a window.
//!
//! It uses the app's saved connections and passwords, so an agent can list the connections, look at their schema
//! and run queries without ever seeing a password. Everything is read-only unless the server is started with
//! `--allow-writes`; even then a connection marked read-only or `prod` in the app stays read-only.
//!
//! Read-only is enforced three times: only reading statements are accepted (SELECT, WITH, SHOW, EXPLAIN, ...), the
//! session is read-only on the server (`default_transaction_read_only` / ClickHouse `readonly`), and on Postgres the
//! statement runs inside `BEGIN READ ONLY ... ROLLBACK`, which a `set_config(...)` cannot switch off.
//!
//! Every tool call is written to the agent log (`agent_log.rs`), which the app shows in its Agent tab.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::cancel::Registry;
use crate::model::{ConnectionParams, DbType, StatementOutcome};
use crate::agent_log::{self, Entry, Table};
use crate::{clickhouse, meta, postgres, secrets};

/// Must match `identifier` in tauri.conf.json: Tauri's app data dir is `<OS data dir>/<identifier>`.
const APP_IDENTIFIER: &str = "com.svovoniks.sauron";
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_MAX_ROWS: usize = 100;
const MAX_ROWS: usize = 1000;
/// An agent must not hang forever on a connection that has no timeout of its own.
const DEFAULT_TIMEOUT_SECS: u64 = 60;
/// First keywords of statements that only read.
const READ_KEYWORDS: [&str; 9] = ["select", "with", "values", "table", "show", "explain", "describe", "desc", "exists"];

/// A connection as the app saves it in `connections.json`.
#[derive(Deserialize, Clone)]
struct Saved {
    #[serde(flatten)]
    params: ConnectionParams,
    #[serde(default)]
    name: String,
    #[serde(default)]
    env: String,
    #[serde(default)]
    description: String,
}

impl Saved {
    fn writable(&self, allow_writes: bool) -> bool {
        allow_writes && !self.params.read_only && self.env != "prod"
    }

    fn label(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.params.id
        } else {
            &self.name
        }
    }
}

struct Server {
    data_dir: PathBuf,
    allow_writes: bool,
    /// Running `tools/call` requests by JSON-RPC id, so `notifications/cancelled` can stop them.
    running: Mutex<HashMap<String, Arc<Registry>>>,
    /// The agent's name from `initialize` (`clientInfo.name`), for the agent log.
    client: Mutex<String>,
}

/// What one tool call did, for the agent log.
#[derive(Default)]
struct Activity {
    connection_id: String,
    connection_name: String,
    sql: String,
    table: Option<Table>,
    /// Refused before anything ran (a write on a read-only connection).
    blocked: bool,
}

impl Activity {
    fn connection(&mut self, saved: &Saved) {
        self.connection_id = saved.params.id.clone();
        self.connection_name = saved.label().to_string();
    }
}

/// Entry point for `sauron --mcp [--allow-writes]`.
pub fn run(allow_writes: bool) -> Result<(), String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find the app data directory")?
        .join(APP_IDENTIFIER);
    secrets::init(data_dir.clone());
    let server = Arc::new(Server {
        data_dir,
        allow_writes,
        running: Mutex::default(),
        client: Mutex::default(),
    });
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(serve(server));
    Ok(())
}

async fn serve(server: Arc<Server>) {
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = out_rx.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(e) => {
                let _ = out_tx.send(error_response(Value::Null, -32700, &format!("Parse error: {e}")));
                continue;
            }
        };
        let server = server.clone();
        let out_tx = out_tx.clone();
        // Requests run concurrently: a long query must not block `ping` or a cancel.
        tasks.spawn(async move {
            if let Some(response) = server.handle(message).await {
                let _ = out_tx.send(response);
            }
        });
    }
    // stdin closed: finish what is running, then stop.
    while tasks.join_next().await.is_some() {}
    drop(out_tx);
    let _ = writer.await;
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

impl Server {
    /// The response to one message; `None` for notifications.
    async fn handle(&self, message: Value) -> Option<Value> {
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = message.get("id").cloned() else {
            if method == "notifications/cancelled" {
                self.cancel(params.get("requestId")).await;
            }
            return None;
        };

        let result = match method.as_str() {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => self.call(&id, &params).await,
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => error_response(id, code, &message),
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
            *self.client.lock().unwrap() = name.to_string();
        }
        let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
        let version = PROTOCOL_VERSIONS
            .iter()
            .find(|v| **v == requested)
            .unwrap_or(&PROTOCOL_VERSIONS[0]);
        let access = if self.allow_writes {
            "Writes are allowed on connections that are not read-only and not prod; everything else is read-only."
        } else {
            "All connections are read-only: only SELECT, WITH, SHOW, EXPLAIN and similar statements are accepted."
        };
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "sauron", "title": "Sauron", "version": env!("CARGO_PKG_VERSION") },
            "instructions": format!(
                "Sauron runs SQL against the Postgres and ClickHouse connections saved in the Sauron app. \
                 Call list_connections first, then list_tables / describe_table to learn the schema, then query. \
                 Run one statement per query call and keep results small with LIMIT. {access}"
            ),
        })
    }

    async fn cancel(&self, request_id: Option<&Value>) {
        let Some(request_id) = request_id else { return };
        let registry = self.running.lock().unwrap().get(&request_id.to_string()).cloned();
        if let Some(registry) = registry {
            registry.cancel().await;
        }
    }

    async fn call(&self, id: &Value, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if !tools().iter().any(|tool| tool["name"] == name) {
            return Err((-32602, format!("Unknown tool: {name}")));
        }

        let registry = Arc::new(Registry::default());
        let key = id.to_string();
        self.running.lock().unwrap().insert(key.clone(), registry.clone());
        let started = std::time::Instant::now();
        let mut activity = Activity::default();
        let outcome = match name {
            "list_connections" => self.list_connections().await,
            "query" => self.query(&args, &registry, &mut activity).await,
            "list_tables" => self.list_tables(&args, &registry, &mut activity).await,
            _ => self.describe_table(&args, &registry, &mut activity).await,
        };
        self.running.lock().unwrap().remove(&key);
        self.log(name, started.elapsed().as_millis() as u64, &outcome, activity).await;

        Ok(match outcome {
            Ok(text) => tool_result(text, false),
            Err(message) => tool_result(message, true),
        })
    }

    async fn log(&self, tool: &str, ms: u64, outcome: &Result<String, String>, activity: Activity) {
        let status = match outcome {
            _ if activity.blocked => "blocked",
            Ok(_) => "ok",
            Err(_) => "error",
        };
        let entry = Entry {
            id: agent_log::new_id(),
            at: agent_log::now_ms(),
            client: self.client.lock().unwrap().clone(),
            tool: tool.to_string(),
            connection_id: activity.connection_id,
            connection_name: activity.connection_name,
            sql: activity.sql,
            ms,
            status: status.to_string(),
            // A table is kept in full in its own file; the text would only repeat it.
            output: if activity.table.is_some() { String::new() } else { outcome.clone().unwrap_or_else(|e| e) },
            rows: None,
            truncated: false,
        };
        let data_dir = self.data_dir.clone();
        let table = activity.table;
        let written = tokio::task::spawn_blocking(move || agent_log::record(&data_dir, entry, table)).await;
        // The agent's answer must not depend on the log; stderr ends up in the agent's MCP log.
        if let Ok(Err(e)) = written {
            eprintln!("sauron --mcp: could not write the agent log: {e}");
        }
    }

    async fn connections(&self) -> Result<Vec<Saved>, String> {
        let path = self.data_dir.join("connections.json");
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        let file: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
        let list = file.get("connections").and_then(Value::as_array).cloned().unwrap_or_default();
        // A connection the app would also reject (missing fields) is skipped rather than failing the whole list.
        Ok(list.into_iter().filter_map(|c| serde_json::from_value(c).ok()).collect())
    }

    /// Find a connection by name (case-insensitive) or id.
    async fn connection(&self, args: &Value) -> Result<Saved, String> {
        let wanted = string_arg(args, "connection")?;
        let connections = self.connections().await?;
        connections
            .iter()
            .find(|c| c.params.id == wanted)
            .or_else(|| connections.iter().find(|c| c.name.trim().eq_ignore_ascii_case(wanted.trim())))
            .cloned()
            .ok_or_else(|| {
                let names: Vec<&str> = connections.iter().map(Saved::label).collect();
                format!("No connection named \"{wanted}\". Saved connections: {}", names.join(", "))
            })
    }

    async fn list_connections(&self) -> Result<String, String> {
        let list: Vec<Value> = self
            .connections()
            .await?
            .iter()
            .map(|c| {
                let mut entry = json!({
                    "name": c.label(),
                    "id": c.params.id,
                    "type": match c.params.db_type { DbType::Postgres => "postgres", DbType::Clickhouse => "clickhouse" },
                    "host": c.params.host,
                    "port": c.params.port,
                    "database": c.params.database,
                    "username": c.params.username,
                    "environment": c.env,
                    "read_only": !c.writable(self.allow_writes),
                });
                if !c.description.trim().is_empty() {
                    entry["description"] = json!(c.description.trim());
                }
                entry
            })
            .collect();
        if list.is_empty() {
            return Ok("No connections are saved. Add one in the Sauron app first.".to_string());
        }
        Ok(serde_json::to_string_pretty(&list).unwrap_or_default())
    }

    async fn query(&self, args: &Value, registry: &Registry, activity: &mut Activity) -> Result<String, String> {
        let saved = self.connection(args).await?;
        activity.connection(&saved);
        let sql = string_arg(args, "sql")?;
        let sql = sql.trim().trim_end_matches(';').trim_end();
        activity.sql = sql.to_string();
        if sql.is_empty() {
            return Err("sql is empty".to_string());
        }
        let max_rows = args
            .get("max_rows")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_MAX_ROWS, |n| n as usize)
            .clamp(1, MAX_ROWS);

        let writable = saved.writable(self.allow_writes);
        if !writable {
            let keyword = postgres::first_keyword(sql);
            if !READ_KEYWORDS.contains(&keyword.as_str()) {
                activity.blocked = true;
                return Err(format!(
                    "\"{}\" is read-only for agents, so only reading statements (SELECT, WITH, SHOW, EXPLAIN, ...) are allowed. {}",
                    saved.label(),
                    if self.allow_writes {
                        "The connection is marked read-only or prod in the Sauron app."
                    } else {
                        "Start the MCP server with --allow-writes to allow writes on connections that are not read-only or prod."
                    }
                ));
            }
        }

        let outcome = run_sql(&saved, sql, max_rows, writable, registry).await?;
        reply(outcome, activity)
    }

    async fn list_tables(&self, args: &Value, registry: &Registry, activity: &mut Activity) -> Result<String, String> {
        let saved = self.connection(args).await?;
        activity.connection(&saved);
        let schema = optional_arg(args, "schema");
        match saved.params.db_type {
            DbType::Postgres => {
                let pattern = schema.map(|s| format!(" {}.*", quote_pg_pattern(&s))).unwrap_or_default();
                activity.sql = format!("\\dtvm+{pattern}");
                run_meta(&saved, &activity.sql, registry).await
            }
            DbType::Clickhouse => {
                let database = match schema {
                    Some(db) => format!("'{}'", db.replace('\\', "\\\\").replace('\'', "\\'")),
                    None => "currentDatabase()".to_string(),
                };
                let sql = format!(
                    "SELECT name, engine, total_rows, formatReadableSize(total_bytes) AS size, comment \
                     FROM system.tables WHERE database = {database} ORDER BY name"
                );
                activity.sql = sql;
                let outcome = run_sql(&saved, &activity.sql, MAX_ROWS, false, registry).await?;
                reply(outcome, activity)
            }
        }
    }

    async fn describe_table(&self, args: &Value, registry: &Registry, activity: &mut Activity) -> Result<String, String> {
        let saved = self.connection(args).await?;
        activity.connection(&saved);
        let table = string_arg(args, "table")?;
        match saved.params.db_type {
            DbType::Postgres => {
                activity.sql = format!("\\d+ {}", quote_pg_pattern(&table));
                run_meta(&saved, &activity.sql, registry).await
            }
            DbType::Clickhouse => {
                let ident = table
                    .split('.')
                    .map(|part| format!("`{}`", part.trim().trim_matches('`').replace('\\', "\\\\").replace('`', "\\`")))
                    .collect::<Vec<_>>()
                    .join(".");
                activity.sql = format!("DESCRIBE TABLE {ident}");
                let outcome = run_sql(&saved, &activity.sql, MAX_ROWS, false, registry).await?;
                reply(outcome, activity)
            }
        }
    }
}

/// The connection settings for one agent request: read-only unless writes are allowed, and never without a timeout.
fn session_params(saved: &Saved, writable: bool) -> ConnectionParams {
    let mut params = saved.params.clone();
    params.read_only = !writable;
    if params.timeout_secs == 0 {
        params.timeout_secs = DEFAULT_TIMEOUT_SECS;
    }
    params
}

async fn password(connection_id: &str) -> Result<String, String> {
    let id = connection_id.to_string();
    tokio::task::spawn_blocking(move || secrets::password_or_empty(&id))
        .await
        .map_err(|e| e.to_string())?
}

async fn run_sql(
    saved: &Saved,
    sql: &str,
    max_rows: usize,
    writable: bool,
    registry: &Registry,
) -> Result<StatementOutcome, String> {
    let params = session_params(saved, writable);
    let guard = registry.begin();
    let password = password(&params.id).await?;
    let read_only_transaction = params.db_type == DbType::Postgres && !writable;
    let statements = if read_only_transaction {
        vec!["BEGIN READ ONLY".to_string(), sql.to_string(), "ROLLBACK".to_string()]
    } else {
        vec![sql.to_string()]
    };

    let outcomes = match params.db_type {
        DbType::Postgres => postgres::execute_script(&params, &password, &statements, max_rows, &guard).await?,
        DbType::Clickhouse => clickhouse::execute_script(&params, &password, &statements, max_rows, &guard).await?,
    };
    let mut outcomes = outcomes.into_iter();
    if read_only_transaction {
        // BEGIN READ ONLY only matters when it failed.
        match outcomes.next() {
            Some(begin) if begin.error.is_some() => return Ok(begin),
            _ => {}
        }
    }
    outcomes.next().ok_or_else(|| "The statement did not run".to_string())
}

async fn run_meta(saved: &Saved, command: &str, registry: &Registry) -> Result<String, String> {
    let params = session_params(saved, false);
    let guard = registry.begin();
    let password = password(&params.id).await?;
    meta::execute(&params, &password, command, &guard).await.map(|out| out.text)
}

/// A table name for a psql pattern: names that need quoting (spaces, upper case) are quoted, the rest kept as typed.
fn quote_pg_pattern(name: &str) -> String {
    let name = name.trim();
    if name.contains('"') || name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_.*?".contains(c)) {
        name.to_string()
    } else {
        name.split('.')
            .map(|part| format!("\"{}\"", part.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(".")
    }
}

/// What the agent gets for one statement: the rows as JSON, or the database error as a tool error.
fn reply(outcome: StatementOutcome, activity: &mut Activity) -> Result<String, String> {
    if let Some(error) = outcome.error {
        let mut text = format!("Error: {}", error.message);
        if let Some(code) = error.code {
            text.push_str(&format!("\nCode: {code}"));
        }
        if let Some(position) = error.position {
            text.push_str(&format!("\nPosition: {position}"));
        }
        return Err(text);
    }
    let Some(result) = outcome.result else {
        return Ok("Statement executed".to_string());
    };
    if result.columns.is_empty() {
        return Ok(result.message.unwrap_or_else(|| "Statement executed".to_string()));
    }
    let columns: Vec<Value> = result.columns.iter().map(|c| json!({ "name": c.name, "type": c.ui_type })).collect();
    let value = json!({
        "columns": columns,
        "rows": result.rows,
        "row_count": result.rows.len(),
        "truncated": result.truncated,
        "elapsed_ms": outcome.elapsed_ms,
    });
    let mut text = value.to_string();
    if result.truncated {
        text.push_str("\n(more rows exist; raise max_rows or narrow the query)");
    }
    activity.table = Some(Table {
        columns,
        rows: result.rows,
        truncated: result.truncated,
        message: result.message,
    });
    Ok(text)
}

fn string_arg(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Missing argument: {key}"))
}

fn optional_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn tools() -> Vec<Value> {
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false });
    let connection = json!({ "type": "string", "description": "Connection name (or id) from list_connections" });
    vec![
        json!({
            "name": "list_connections",
            "title": "List connections",
            "description": "The database connections saved in Sauron: name, type (postgres / clickhouse), host, database, environment and whether this server lets you write to it.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only,
        }),
        json!({
            "name": "list_tables",
            "title": "List tables",
            "description": "Tables and views of a connection. Postgres: everything on the search path, or one schema. ClickHouse: the current database, or the given one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": connection,
                    "schema": { "type": "string", "description": "Postgres schema or ClickHouse database (optional)" },
                },
                "required": ["connection"],
            },
            "annotations": read_only,
        }),
        json!({
            "name": "describe_table",
            "title": "Describe table",
            "description": "Columns and their types of one table (Postgres also lists indexes, constraints and references).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": connection,
                    "table": { "type": "string", "description": "Table name, optionally schema.table (Postgres) or database.table (ClickHouse)" },
                },
                "required": ["connection", "table"],
            },
            "annotations": read_only,
        }),
        json!({
            "name": "query",
            "title": "Run SQL",
            "description": "Run one SQL statement and return the rows as JSON (columns, rows, truncated). Values are the exact text the database returned; null is SQL NULL. Read-only connections only accept SELECT, WITH, SHOW, EXPLAIN, DESCRIBE and VALUES.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": connection,
                    "sql": { "type": "string", "description": "One SQL statement" },
                    "max_rows": { "type": "integer", "minimum": 1, "maximum": MAX_ROWS, "description": format!("Rows to return (default {DEFAULT_MAX_ROWS}, at most {MAX_ROWS})") },
                },
                "required": ["connection", "sql"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false },
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(read_only: bool, env: &str) -> Saved {
        serde_json::from_value(json!({
            "id": "c1", "name": "Local", "host": "localhost", "port": "5432", "username": "u", "database": "d",
            "db_type": "postgres", "ssl_mode": "disable", "read_only": read_only, "timeout_secs": 0, "env": env,
        }))
        .unwrap()
    }

    fn server(allow_writes: bool) -> Server {
        Server {
            data_dir: std::env::temp_dir().join(format!("sauron-mcp-test-{}", uuid::Uuid::new_v4())),
            allow_writes,
            running: Mutex::default(),
            client: Mutex::default(),
        }
    }

    #[test]
    fn writes_need_the_flag_and_a_writable_non_prod_connection() {
        assert!(!saved(false, "").writable(false));
        assert!(saved(false, "local").writable(true));
        assert!(!saved(true, "local").writable(true));
        assert!(!saved(false, "prod").writable(true));
    }

    #[test]
    fn agent_sessions_always_have_a_timeout() {
        let params = session_params(&saved(false, ""), false);
        assert!(params.read_only);
        assert_eq!(params.timeout_secs, DEFAULT_TIMEOUT_SECS);
    }

    #[test]
    fn pg_patterns_are_quoted_only_when_needed() {
        assert_eq!(quote_pg_pattern("public.users"), "public.users");
        assert_eq!(quote_pg_pattern("Orders"), "\"Orders\"");
        assert_eq!(quote_pg_pattern("my schema.My Table"), "\"my schema\".\"My Table\"");
        assert_eq!(quote_pg_pattern("\"Mixed\""), "\"Mixed\"");
    }

    #[tokio::test]
    async fn initialize_negotiates_the_protocol_version() {
        let response = server(false)
            .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }))
            .await
            .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(response["result"]["serverInfo"]["name"], "sauron");

        let response = server(false)
            .handle(json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }))
            .await
            .unwrap();
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[tokio::test]
    async fn notifications_get_no_response_and_unknown_methods_an_error() {
        let s = server(false);
        assert!(s.handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
        let response = s.handle(json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" })).await.unwrap();
        assert_eq!(response["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn tools_are_listed_and_unknown_tools_rejected() {
        let s = server(false);
        let response = s.handle(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" })).await.unwrap();
        let names: Vec<&str> = response["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_connections", "list_tables", "describe_table", "query"]);

        let response = s
            .handle(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "drop_everything" } }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn read_only_connections_reject_writes_before_connecting() {
        let s = server(false);
        std::fs::create_dir_all(&s.data_dir).unwrap();
        let file = json!({ "version": 1, "connections": [{
            "id": "c1", "name": "Local", "host": "localhost", "port": "1", "username": "u", "database": "d",
            "db_type": "postgres", "read_only": false, "env": "",
        }] });
        std::fs::write(s.data_dir.join("connections.json"), file.to_string()).unwrap();

        for sql in ["delete from users", "SET default_transaction_read_only = off", "begin", "/* x */ update t set a = 1"] {
            let response = s
                .handle(json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call",
                    "params": { "name": "query", "arguments": { "connection": "local", "sql": sql } } }))
                .await
                .unwrap();
            assert_eq!(response["result"]["isError"], true, "{sql}");
            let text = response["result"]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains("read-only for agents"), "{sql}: {text}");
        }

        let response = s
            .handle(json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": { "name": "list_connections", "arguments": {} } }))
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"read_only\": true") && !text.contains("password"), "{text}");

        // Every call is in the agent log, the refused writes as "blocked".
        let log = agent_log::list(&s.data_dir);
        assert_eq!(log.len(), 5);
        assert_eq!(log[0].tool, "list_connections");
        assert!(log[1..].iter().all(|e| e.status == "blocked" && e.connection_name == "Local"));
        let _ = std::fs::remove_dir_all(&s.data_dir);
    }

    /// Server with one saved connection to the test database: `SAURON_TEST_PG_PORT=5432 cargo test mcp`.
    fn server_with(db_type: &str, port: &str, allow_writes: bool) -> Server {
        // No password is saved for the test connection; the store only has to exist (in a temp dir, not the real one).
        secrets::init(std::env::temp_dir().join("sauron-mcp-test-store"));
        let s = server(allow_writes);
        std::fs::create_dir_all(&s.data_dir).unwrap();
        let user = if db_type == "postgres" { "postgres" } else { "default" };
        let file = json!({ "version": 1, "connections": [{
            "id": format!("sauron-mcp-test-{}", uuid::Uuid::new_v4()), "name": "Test", "host": "localhost", "port": port,
            "username": user, "database": if db_type == "postgres" { "postgres" } else { "default" },
            "db_type": db_type, "ssl_mode": "disable", "read_only": false, "env": "local",
        }] });
        std::fs::write(s.data_dir.join("connections.json"), file.to_string()).unwrap();
        s
    }

    async fn call(s: &Server, name: &str, arguments: Value) -> (bool, String) {
        let response = s
            .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } }))
            .await
            .unwrap();
        let result = &response["result"];
        (result["isError"] == true, result["content"][0]["text"].as_str().unwrap_or_default().to_string())
    }

    #[tokio::test]
    async fn postgres_end_to_end() {
        let Ok(port) = std::env::var("SAURON_TEST_PG_PORT") else { return };
        let table = format!("mcp_test_{}", uuid::Uuid::new_v4().simple());

        let writer = server_with("postgres", &port, true);
        let (err, text) = call(&writer, "query", json!({ "connection": "Test", "sql": format!("create table {table} (id int primary key, note text)") })).await;
        assert!(!err, "{text}");
        let (err, text) = call(&writer, "query", json!({ "connection": "Test", "sql": format!("insert into {table} values (1, 'a'), (2, null)") })).await;
        assert!(!err, "{text}");

        let reader = server_with("postgres", &port, false);
        let (err, text) = call(&reader, "query", json!({ "connection": "test", "sql": format!("select * from {table} order by id;"), "max_rows": 1 })).await;
        assert!(!err, "{text}");
        let value: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(value["rows"], json!([["1", "a"]]));
        assert_eq!(value["truncated"], true);

        // A write hidden in a reading statement is stopped by the read-only transaction.
        let (err, text) = call(&reader, "query", json!({ "connection": "Test", "sql": format!("with x as (insert into {table} values (3, 'b') returning *) select * from x") })).await;
        assert!(err && text.starts_with("Error:") && text.contains("read-only"), "{text}");
        let (err, text) = call(&reader, "query", json!({ "connection": "Test", "sql": format!("select set_config('transaction_read_only', 'off', false), (select count(*) from {table})") })).await;
        assert!(err && text.starts_with("Error:"), "{text}");

        let (err, text) = call(&reader, "list_tables", json!({ "connection": "Test", "schema": "public" })).await;
        assert!(!err && text.contains(&table), "{text}");
        let (err, text) = call(&reader, "describe_table", json!({ "connection": "Test", "table": format!("public.{table}") })).await;
        assert!(!err && text.contains("note") && text.contains("PRIMARY KEY"), "{text}");

        call(&writer, "query", json!({ "connection": "Test", "sql": format!("drop table {table}") })).await;
        let _ = std::fs::remove_dir_all(&writer.data_dir);
        let _ = std::fs::remove_dir_all(&reader.data_dir);
    }

    #[tokio::test]
    async fn clickhouse_end_to_end() {
        let Ok(port) = std::env::var("SAURON_TEST_CH_PORT") else { return };
        let table = format!("mcp_test_{}", uuid::Uuid::new_v4().simple());

        let writer = server_with("clickhouse", &port, true);
        let (err, text) = call(&writer, "query", json!({ "connection": "Test", "sql": format!("CREATE TABLE {table} (id UInt32, note String) ENGINE = MergeTree ORDER BY id") })).await;
        assert!(!err, "{text}");
        call(&writer, "query", json!({ "connection": "Test", "sql": format!("INSERT INTO {table} VALUES (1, 'a'), (2, 'b')") })).await;

        let reader = server_with("clickhouse", &port, false);
        let (err, text) = call(&reader, "query", json!({ "connection": "Test", "sql": format!("SELECT * FROM {table} ORDER BY id") })).await;
        assert!(!err && text.contains(r#"["1","a"]"#), "{text}");
        let (err, text) = call(&reader, "query", json!({ "connection": "Test", "sql": "SELECT 1 SETTINGS readonly = 0" })).await;
        assert!(err && text.starts_with("Error:"), "{text}");
        let (err, _) = call(&reader, "query", json!({ "connection": "Test", "sql": format!("INSERT INTO {table} VALUES (3, 'c')") })).await;
        assert!(err);

        let (err, text) = call(&reader, "list_tables", json!({ "connection": "Test" })).await;
        assert!(!err && text.contains(&table), "{text}");
        let (err, text) = call(&reader, "describe_table", json!({ "connection": "Test", "table": table })).await;
        assert!(!err && text.contains("note") && text.contains("String"), "{text}");

        call(&writer, "query", json!({ "connection": "Test", "sql": format!("DROP TABLE {table}") })).await;
        let _ = std::fs::remove_dir_all(&writer.data_dir);
        let _ = std::fs::remove_dir_all(&reader.data_dir);
    }
}
