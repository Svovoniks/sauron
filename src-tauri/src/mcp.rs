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
//! Kafka connections have no SQL: read_messages and send_message take the fields of the app's Kafka form, and
//! send_message follows the same rule as a SQL write (--allow-writes, and never on read-only or prod connections).
//!
//! Every tool call is written to the agent log (`agent_log.rs`), which the app shows in its Agent tab.
//!
//! When the app updates itself, a running server switches to the new executable at the next message (see relaunch):
//! on macOS the old process can no longer use client certificates (see executable.rs), and it would run old code anyway.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::cancel::Registry;
use crate::model::{ConnectionParams, DbType, StatementOutcome, TargetSessionAttrs};
use crate::agent_log::{self, Entry, Table};
use crate::executable::{self, State};
use crate::{clickhouse, kafka, meta, postgres, secrets};

/// Must match `identifier` in tauri.conf.json: Tauri's app data dir is `<OS data dir>/<identifier>`.
const APP_IDENTIFIER: &str = "com.svovoniks.sauron";
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_MAX_ROWS: usize = 100;
const MAX_ROWS: usize = 1000;
/// An agent must not hang forever on a connection that has no timeout of its own.
const DEFAULT_TIMEOUT_SECS: u64 = 60;
/// First keywords of statements that only read.
const READ_KEYWORDS: [&str; 9] = ["select", "with", "values", "table", "show", "explain", "describe", "desc", "exists"];
/// Set by a server that switched to the updated executable, for the new program: a Resume as JSON.
const RESUME_VAR: &str = "SAURON_MCP_RESUME";
/// A bigger message is handled by the old program rather than passed on in the environment.
const MAX_RESUME_BYTES: usize = 64 * 1024;
/// What to do when the old program could not switch and a client certificate fails (see executable::explain).
const RESTART: &str = "Call the tool again: the server switches to the new version when no other call is running. \
                       If the error stays, restart the sauron MCP server (in Claude Code: /mcp, then Reconnect).";

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
    executable::remember(RESTART);
    let resume = take_resume();
    if resume.is_some() {
        let path = executable::path().map(|path| path.display().to_string()).unwrap_or_default();
        eprintln!("sauron --mcp: switched to the updated executable {path} (version {})", env!("CARGO_PKG_VERSION"));
    }
    let data_dir = dirs::data_dir()
        .ok_or("Could not find the app data directory")?
        .join(APP_IDENTIFIER);
    secrets::init(data_dir.clone());
    crate::client_cert::init(data_dir.clone());
    let (client, message) = resume.map(|r| (r.client, r.message)).unzip();
    let server = Arc::new(Server {
        data_dir,
        allow_writes,
        running: Mutex::default(),
        client: Mutex::new(client.unwrap_or_default()),
    });
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(serve(server, message));
    Ok(())
}

/// What a server that switched to the updated executable passes on to the new program, which then carries on
/// with the same agent: the name it gave in initialize, and the message that arrived when the switch was made.
#[derive(Deserialize)]
struct Resume {
    client: String,
    message: Value,
}

fn take_resume() -> Option<Resume> {
    let text = std::env::var(RESUME_VAR).ok()?;
    // not for the commands this process starts (psql, the certificate renewal), nor for a later switch
    std::env::remove_var(RESUME_VAR);
    serde_json::from_str(&text)
        .inspect_err(|e| eprintln!("sauron --mcp: ignoring {RESUME_VAR}, it is not valid: {e}"))
        .ok()
}

/// Turns this process into the program now at the path it was started from, with the same pid, arguments and
/// stdin / stdout, so the agent keeps talking to it without noticing. Returns only when that fails.
#[cfg(unix)]
fn relaunch(path: &Path, resume: &str) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let mut args = std::env::args_os();
    let mut command = std::process::Command::new(path);
    if let Some(arg0) = args.next() {
        command.arg0(arg0);
    }
    command.args(args).env(RESUME_VAR, resume).exec()
}

/// Windows cannot replace a running program in place (and keeps it from being overwritten).
#[cfg(not(unix))]
fn relaunch(_path: &Path, _resume: &str) -> std::io::Error {
    std::io::ErrorKind::Unsupported.into()
}

/// Writes the responses to stdout, one per line; the handle finishes once every sender is dropped.
fn spawn_writer() -> (tokio::sync::mpsc::UnboundedSender<Value>, tokio::task::JoinHandle<()>) {
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
    (out_tx, writer)
}

/// resumed: the message the previous program had just received when it switched to this one.
async fn serve(server: Arc<Server>, mut resumed: Option<Value>) {
    let (mut out_tx, mut writer) = spawn_writer();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = tokio::task::JoinSet::new();
    let mut relaunch_failed = false;
    loop {
        let message: Value = match resumed.take() {
            Some(message) => message,
            None => {
                let Ok(Some(line)) = lines.next_line().await else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(e) => {
                        let _ = out_tx.send(error_response(Value::Null, -32700, &format!("Parse error: {e}")));
                        continue;
                    }
                }
            }
        };
        while tasks.try_join_next().is_some() {}
        // The switch is made only between messages, with nothing running and nothing read ahead: then every earlier
        // request has its answer, and whatever the agent sends next is still in the pipe, for the new program.
        if !relaunch_failed && tasks.is_empty() && lines.get_ref().buffer().is_empty() && executable::state() == State::Replaced {
            let client = server.client.lock().unwrap().clone();
            let resume = json!({ "client": client, "message": &message }).to_string();
            if let Some(path) = executable::path().filter(|_| resume.len() <= MAX_RESUME_BYTES) {
                drop(out_tx);
                let _ = writer.await;
                let error = relaunch(path, &resume);
                eprintln!("sauron --mcp: could not switch to the updated executable {}: {error}", path.display());
                relaunch_failed = true;
                (out_tx, writer) = spawn_writer();
            }
        }
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
                 Run one statement per query call and keep results small with LIMIT. \
                 Kafka connections have no SQL: list_tables lists their topics, describe_table shows a topic's partitions \
                 and newest messages, read_messages reads messages and send_message sends one. {access}"
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
            "read_messages" => self.read_messages(&args, &registry, &mut activity).await,
            "send_message" => self.send_message(&args, &registry, &mut activity).await,
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
                    "type": match c.params.db_type { DbType::Postgres => "postgres", DbType::Clickhouse => "clickhouse", DbType::Kafka => "kafka" },
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
                // host may be a comma separated list of cluster nodes; this says which node is used
                if c.params.db_type == DbType::Postgres && c.params.target_session_attrs != TargetSessionAttrs::Any {
                    entry["target_session_attrs"] = json!(c.params.target_session_attrs.libpq_name());
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
        if saved.params.db_type == DbType::Kafka {
            return Err(format!("\"{}\" is a Kafka connection: use read_messages and send_message instead of SQL.", saved.label()));
        }
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
            DbType::Kafka => {
                activity.sql = kafka::form_text("topics", "", json!({}), json!({}));
                let outcome = run_kafka(&saved, &activity.sql, MAX_ROWS * 10, false, registry).await?;
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
            DbType::Kafka => {
                // The partitions, then a few messages so the agent sees what the values look like.
                activity.sql = kafka::form_text("describe", &table, json!({}), json!({}));
                let partitions = reply(run_kafka(&saved, &activity.sql, MAX_ROWS, false, registry).await?, activity)?;
                let newest = kafka::form_text("read", &table, json!({ "from": "newest" }), json!({}));
                let sample = reply(run_kafka(&saved, &newest, 3, false, registry).await?, &mut Activity::default())?;
                Ok(format!("Partitions:\n{partitions}\n\nNewest messages:\n{sample}"))
            }
        }
    }

    async fn read_messages(&self, args: &Value, registry: &Registry, activity: &mut Activity) -> Result<String, String> {
        let saved = self.kafka_connection(args).await?;
        activity.connection(&saved);
        let topic = string_arg(args, "topic")?;
        let read = read_form(args)?;
        activity.sql = kafka::form_text("read", &topic, read, json!({}));
        let max_rows = args
            .get("max_rows")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_MAX_ROWS, |n| n as usize)
            .clamp(1, MAX_ROWS);
        let outcome = run_kafka(&saved, &activity.sql, max_rows, false, registry).await?;
        reply(outcome, activity)
    }

    async fn send_message(&self, args: &Value, registry: &Registry, activity: &mut Activity) -> Result<String, String> {
        let saved = self.kafka_connection(args).await?;
        activity.connection(&saved);
        let topic = string_arg(args, "topic")?;
        let headers: Vec<Value> = args
            .get("headers")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(name, value)| json!({ "name": name, "value": value.as_str().map_or_else(|| value.to_string(), str::to_string) }))
                    .collect()
            })
            .unwrap_or_default();
        let value = match args.get("value") {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => return Err("Missing argument: value".to_string()),
        };
        let partition = args.get("partition").and_then(Value::as_i64);
        let send = json!({
            "key": optional_arg(args, "key").unwrap_or_default(),
            "value": value,
            "headers": headers,
            "partitioner": if partition.is_some() { "manual".to_string() } else { optional_arg(args, "partitioner").unwrap_or_else(|| "fnv".to_string()) },
            "partition": partition.unwrap_or(0),
        });
        activity.sql = kafka::form_text("send", &topic, json!({}), send);
        let writable = saved.writable(self.allow_writes);
        if !writable {
            activity.blocked = true;
            return Err(format!(
                "\"{}\" is read-only for agents, so messages cannot be sent. {}",
                saved.label(),
                if self.allow_writes {
                    "The connection is marked read-only or prod in the Sauron app."
                } else {
                    "Start the MCP server with --allow-writes to allow sending on connections that are not read-only or prod."
                }
            ));
        }
        let outcome = run_kafka(&saved, &activity.sql, 1, true, registry).await?;
        reply(outcome, activity)
    }

    async fn kafka_connection(&self, args: &Value) -> Result<Saved, String> {
        let saved = self.connection(args).await?;
        if saved.params.db_type != DbType::Kafka {
            return Err(format!("\"{}\" is not a Kafka connection: use query.", saved.label()));
        }
        Ok(saved)
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
        DbType::Kafka => return Err("Kafka connections have no SQL: use read_messages and send_message.".to_string()),
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

async fn run_kafka(saved: &Saved, form: &str, max_rows: usize, writable: bool, registry: &Registry) -> Result<StatementOutcome, String> {
    let params = session_params(saved, writable);
    let guard = registry.begin();
    let password = password(&params.id).await?;
    let mut outcomes = kafka::execute_script(&params, &password, &[form.to_string()], max_rows, &guard).await?;
    outcomes.pop().ok_or_else(|| "Nothing ran".to_string())
}

/// read_messages arguments as the Kafka form's read part.
fn read_form(args: &Value) -> Result<Value, String> {
    let time = |key: &str| -> Result<Option<i64>, String> {
        match optional_arg(args, key) {
            None => Ok(None),
            Some(text) => chrono::DateTime::parse_from_rfc3339(&text)
                .map(|t| Some(t.timestamp_millis()))
                .map_err(|_| format!("{key} must be an RFC 3339 time like 2026-11-20T10:00:00Z, got \"{text}\"")),
        }
    };
    let (since, until) = (time("since")?, time("until")?);
    let range = optional_arg(args, "range");
    let from = match optional_arg(args, "from") {
        Some(from) => from,
        None if since.is_some() || until.is_some() || range.is_some() => "time".to_string(),
        None if args.get("offset").is_some() => "offset".to_string(),
        None => "newest".to_string(),
    };
    let filters = args.get("filters").cloned().unwrap_or_else(|| json!([]));
    Ok(json!({
        "from": from,
        "range": if since.is_some() || until.is_some() { "custom".to_string() } else { range.unwrap_or_else(|| "24h".to_string()) },
        "sinceMs": since,
        "untilMs": until,
        "partitions": args.get("partitions").cloned().unwrap_or_else(|| json!([])),
        "offsetPartition": args.get("partition").and_then(Value::as_i64).unwrap_or(0),
        "offset": args.get("offset").and_then(Value::as_i64).unwrap_or(0),
        "filters": filters,
    }))
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
        json!({
            "name": "read_messages",
            "title": "Read Kafka messages",
            "description": "Read messages of a topic on a Kafka connection, newest first unless from is oldest or offset. Never joins a consumer group or commits offsets. Rows are partition, offset, timestamp, key, value (the message text, usually JSON) and headers. Filters are checked on every message read, so narrow a search with a time range.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": connection,
                    "topic": { "type": "string" },
                    "from": { "type": "string", "enum": ["newest", "oldest", "time", "offset", "timestamp"], "description": "Where to start (default newest; time when since, until or range is given; offset when offset is given). time reads a window newest first; timestamp reads every partition forwards from the first message at or after since" },
                    "range": { "type": "string", "enum": ["15m", "1h", "6h", "24h", "7d"], "description": "Time window back from now (from = time)" },
                    "since": { "type": "string", "description": "RFC 3339 start of the time window, or the time to start from for from = timestamp" },
                    "until": { "type": "string", "description": "RFC 3339 end of the time window" },
                    "partitions": { "type": "array", "items": { "type": "integer" }, "description": "Only these partitions (default all)" },
                    "partition": { "type": "integer", "description": "The partition for from = offset" },
                    "offset": { "type": "integer", "description": "The first offset for from = offset" },
                    "filters": {
                        "type": "array",
                        "description": "All must match. field: key, value (the whole text), value.a.b.0 (a JSON field; numbers index arrays) or header.name",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": { "type": "string" },
                                "op": { "type": "string", "enum": ["eq", "ne", "contains", "not_contains", "exists", "gt", "lt"] },
                                "value": { "type": "string" },
                            },
                            "required": ["field", "op"],
                        },
                    },
                    "max_rows": { "type": "integer", "minimum": 1, "maximum": MAX_ROWS, "description": format!("Messages to return (default {DEFAULT_MAX_ROWS}, at most {MAX_ROWS})") },
                },
                "required": ["connection", "topic"],
            },
            "annotations": read_only,
        }),
        json!({
            "name": "send_message",
            "title": "Send a Kafka message",
            "description": "Send one message to an existing topic of a Kafka connection. Needs --allow-writes and a connection that is not read-only or prod. Without a partition, a keyed message goes to the partition its key hashes to (partitioner fnv, the sarama default, or murmur2, the Java default) and a message without a key to a random one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": connection,
                    "topic": { "type": "string" },
                    "key": { "type": "string" },
                    "value": { "description": "The message: a string is sent as is, anything else as JSON" },
                    "headers": { "type": "object", "additionalProperties": { "type": "string" } },
                    "partition": { "type": "integer", "description": "Send to this partition instead of hashing the key" },
                    "partitioner": { "type": "string", "enum": ["fnv", "murmur2"] },
                },
                "required": ["connection", "topic", "value"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
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
    fn read_messages_arguments_become_the_read_form() {
        let form = read_form(&json!({ "range": "1h", "filters": [{ "field": "key", "op": "eq", "value": "k" }] })).unwrap();
        assert_eq!(form["from"], "time");
        assert_eq!(form["range"], "1h");
        assert_eq!(form["filters"][0]["field"], "key");
        let form = read_form(&json!({ "since": "2026-11-20T10:00:00Z" })).unwrap();
        assert_eq!(form["range"], "custom");
        assert_eq!(form["sinceMs"], 1_795_168_800_000i64);
        assert_eq!(read_form(&json!({ "partition": 2, "offset": 5 })).unwrap()["from"], "offset");
        let form = read_form(&json!({ "from": "timestamp", "since": "2026-11-20T10:00:00Z" })).unwrap();
        assert_eq!(form["from"], "timestamp");
        assert_eq!(form["sinceMs"], 1_795_168_800_000i64);
        assert_eq!(read_form(&json!({})).unwrap()["from"], "newest");
        assert!(read_form(&json!({ "since": "yesterday" })).is_err());
    }

    #[tokio::test]
    async fn kafka_sends_follow_the_write_rules() {
        let s = server(true);
        std::fs::create_dir_all(&s.data_dir).unwrap();
        let file = json!({ "version": 1, "connections": [
            { "id": "k1", "name": "Bus", "host": "127.0.0.1", "port": "1", "username": "", "database": "", "db_type": "kafka", "read_only": true },
            { "id": "k2", "name": "Bus prod", "host": "127.0.0.1", "port": "1", "username": "", "database": "", "db_type": "kafka", "env": "prod" },
        ] });
        std::fs::write(s.data_dir.join("connections.json"), file.to_string()).unwrap();
        let registry = Registry::default();
        for name in ["Bus", "Bus prod"] {
            let mut activity = Activity::default();
            let refused = s.send_message(&json!({ "connection": name, "topic": "t", "value": "{}" }), &registry, &mut activity).await;
            assert!(refused.unwrap_err().contains("read-only for agents"));
            assert!(activity.blocked);
            assert!(activity.sql.contains("\"mode\":\"send\""));
        }
        let mut activity = Activity::default();
        let sql = s.query(&json!({ "connection": "Bus", "sql": "select 1" }), &registry, &mut activity).await;
        assert!(sql.unwrap_err().contains("Kafka connection"));
        let list: Value = serde_json::from_str(&s.list_connections().await.unwrap()).unwrap();
        assert_eq!(list[0]["type"], "kafka");
        let _ = std::fs::remove_dir_all(&s.data_dir);
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
        assert_eq!(names, ["list_connections", "list_tables", "describe_table", "query", "read_messages", "send_message"]);

        let response = s
            .handle(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "drop_everything" } }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn host_lists_and_target_session_are_listed() {
        let s = server(false);
        std::fs::create_dir_all(&s.data_dir).unwrap();
        let file = json!({ "version": 1, "connections": [
            { "id": "c1", "name": "Cluster", "host": "a,b,c", "port": "6433", "username": "u", "database": "d",
              "db_type": "postgres", "target_session_attrs": "read-write" },
            { "id": "c2", "name": "Old", "host": "h", "port": "5432", "username": "u", "database": "d", "db_type": "postgres" },
        ] });
        std::fs::write(s.data_dir.join("connections.json"), file.to_string()).unwrap();
        let list: Value = serde_json::from_str(&s.list_connections().await.unwrap()).unwrap();
        assert_eq!(list[0]["host"], "a,b,c");
        assert_eq!(list[0]["target_session_attrs"], "read-write");
        assert_eq!(list[1]["name"], "Old");
        assert!(list[1].get("target_session_attrs").is_none());
        let _ = std::fs::remove_dir_all(&s.data_dir);
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
