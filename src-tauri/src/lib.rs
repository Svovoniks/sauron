use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::io::ErrorKind;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_postgres::{types::Type, Client, NoTls, Row};

#[derive(Serialize)]
struct PsqlAvailability {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

async fn setup_connection(connection_string: &str) -> Result<Client, tokio_postgres::Error> {
    let (client, connection) = tokio_postgres::connect(connection_string, NoTls).await?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("connection error: {}", e);
        }
    });
    Ok(client)
}

use lazy_static::lazy_static;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio_postgres::types::{FromSql, Type as PgType};

// Custom wrapper to accept any type as raw bytes and convert to string
struct RawText(String);

impl<'a> FromSql<'a> for RawText {
    fn from_sql(
        _ty: &PgType,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawText(String::from_utf8_lossy(raw).to_string()))
    }

    fn accepts(_ty: &PgType) -> bool {
        // Accept any type
        true
    }
}

lazy_static! {
    static ref CHANNEL: (mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>) = {
        let (sender, receiver) = mpsc::channel(1);
        (sender, receiver.into())
    };
}

#[tauri::command]
async fn cancel_query() {
    let _ = CHANNEL.0.send(()).await;
}

async fn execute_statements_in_session(
    client: &Client,
    statements: &[String],
) -> Result<Vec<Row>, String> {
    if statements.is_empty() {
        return Err("No SQL statements to execute".to_string());
    }

    for statement in statements.iter().take(statements.len().saturating_sub(1)) {
        client
            .simple_query(statement)
            .await
            .map_err(|e| e.to_string())?;
    }

    let last_statement = statements
        .last()
        .ok_or_else(|| "No SQL statements to execute".to_string())?;

    let prepared = client
        .prepare(last_statement)
        .await
        .map_err(|e| e.to_string())?;

    if prepared.columns().is_empty() {
        client
            .execute(&prepared, &[])
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Vec::new());
    }

    client
        .query(&prepared, &[])
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn execute_query(connection_string: &str, query: &str) -> Result<String, String> {
    execute_query_batch(connection_string, vec![query.to_string()]).await
}

fn psql_candidates() -> Vec<&'static str> {
    let mut candidates = vec!["psql"];

    #[cfg(target_os = "macos")]
    {
        candidates.push("/opt/homebrew/bin/psql");
        candidates.push("/usr/local/bin/psql");
        candidates.push("/Applications/Postgres.app/Contents/Versions/latest/bin/psql");
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push("psql.exe");
    }

    candidates
}

async fn check_psql_candidate(psql_path: &str) -> Result<PsqlAvailability, String> {
    let output = Command::new(psql_path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                format!("psql binary not found at {}", psql_path)
            } else {
                format!("Failed to start psql: {}", error)
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        return Ok(PsqlAvailability {
            available: true,
            path: Some(psql_path.to_string()),
            version: if stdout.is_empty() {
                None
            } else {
                Some(stdout)
            },
            error: None,
        });
    }

    Err(if stderr.is_empty() {
        format!("psql --version exited with status {}", output.status)
    } else {
        stderr
    })
}

#[tauri::command]
async fn check_psql_availability() -> Result<PsqlAvailability, String> {
    let mut not_found_errors = Vec::new();
    for candidate in psql_candidates() {
        match check_psql_candidate(candidate).await {
            Err(error) if error.starts_with("psql binary not found") => {
                not_found_errors.push(error);
            }
            Ok(availability) => return Ok(availability),
            Err(error) => {
                return Ok(PsqlAvailability {
                    available: false,
                    path: Some(candidate.to_string()),
                    version: None,
                    error: Some(error),
                });
            }
        }
    }

    Ok(PsqlAvailability {
        available: false,
        path: None,
        version: None,
        error: Some(format!(
            "Could not find psql. Tried: {}",
            not_found_errors.join(", ")
        )),
    })
}

async fn run_psql_meta_command_with_binary(
    psql_path: &str,
    host: &str,
    port: &str,
    username: &str,
    password: &str,
    database: &str,
    command_text: &str,
) -> Result<String, String> {
    let mut child = Command::new(psql_path)
        .arg("-X")
        .arg("-w")
        .arg("-P")
        .arg("pager=off")
        .arg("-h")
        .arg(host)
        .arg("-p")
        .arg(port)
        .arg("-U")
        .arg(username)
        .arg("-d")
        .arg(database)
        .env("PGPASSWORD", password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                format!("psql binary not found at {}", psql_path)
            } else {
                format!("Failed to start psql: {}", error)
            }
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(command_text.as_bytes())
            .await
            .map_err(|error| format!("Failed to write command to psql: {}", error))?;
        if !command_text.ends_with('\n') {
            stdin
                .write_all(b"\n")
                .await
                .map_err(|error| format!("Failed to finish command for psql: {}", error))?;
        }
    }

    let mut output_task = tokio::spawn(async move { child.wait_with_output().await });
    let mut receiver = CHANNEL.1.lock().await;

    let output = tokio::select! {
        _ = receiver.recv() => {
            output_task.abort();
            return Err("Query was cancelled".to_string());
        }
        result = &mut output_task => {
            result
                .map_err(|error| format!("Failed to wait for psql: {}", error))?
                .map_err(|error| format!("Failed to run psql: {}", error))?
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined_output = format!("{}{}", stdout, stderr);

    if output.status.success() {
        return Ok(combined_output);
    }

    let trimmed_output = combined_output.trim();
    if trimmed_output.is_empty() {
        Err(format!("psql exited with status {}", output.status))
    } else {
        Err(trimmed_output.to_string())
    }
}

#[tauri::command]
async fn execute_psql_meta_command(
    host: String,
    port: String,
    username: String,
    password: String,
    database: String,
    command_text: String,
) -> Result<String, String> {
    if !command_text.trim_start().starts_with('\\') {
        return Err("Meta command mode expects a psql backslash command.".to_string());
    }

    let mut not_found_errors = Vec::new();
    for candidate in psql_candidates() {
        match run_psql_meta_command_with_binary(
            candidate,
            &host,
            &port,
            &username,
            &password,
            &database,
            &command_text,
        )
        .await
        {
            Err(error) if error.starts_with("psql binary not found") => {
                not_found_errors.push(error);
            }
            result => return result,
        }
    }

    Err(format!(
        "Could not find psql. Tried: {}",
        not_found_errors.join(", ")
    ))
}

#[tauri::command]
async fn execute_query_batch(
    connection_string: &str,
    statements: Vec<String>,
) -> Result<String, String> {
    if statements.is_empty() {
        return Err("No SQL statements to execute".to_string());
    }

    let client = setup_connection(connection_string)
        .await
        .map_err(|e| e.to_string())?;

    let cancel_token = client.cancel_token();
    let query_future = async { execute_statements_in_session(&client, &statements).await };

    let mut receiver = CHANNEL.1.lock().await;

    let rows: Vec<Row>;
    tokio::select! {
        _ = receiver.recv() => {
            let _ = cancel_token.cancel_query(NoTls).await;
            return Err("Query was cancelled".to_string())
        }
        result = query_future => {
            match result {
                Ok(arr) => rows = arr,
                Err(e) => return Err(e),
            }
        }
    }

    rows_to_json(rows)
}

fn rows_to_json(rows: Vec<Row>) -> Result<String, String> {
    let mut results = Vec::new();
    for row in rows {
        let mut row_data = Vec::new();
        for (i, column) in row.columns().iter().enumerate() {
            let (value, val_type) = match *column.type_() {
                Type::BOOL => (
                    row.get::<_, Option<bool>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "bool".to_string(),
                ),
                Type::BYTEA => (
                    row.get::<_, Option<Vec<u8>>>(i)
                        .map(|v| hex::encode(v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                Type::CHAR => (
                    row.get::<_, Option<i8>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "number".to_string(),
                ),
                Type::INT8 => (
                    row.get::<_, Option<i64>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "number".to_string(),
                ),
                Type::INT2 => (
                    row.get::<_, Option<i16>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "number".to_string(),
                ),
                Type::INT4 => (
                    row.get::<_, Option<i32>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "number".to_string(),
                ),
                Type::TEXT_ARRAY => (
                    row.get::<_, Option<Vec<Option<String>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::INT2_ARRAY => (
                    row.get::<_, Option<Vec<Option<i16>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::INT4_ARRAY => (
                    row.get::<_, Option<Vec<Option<i32>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::INT8_ARRAY => (
                    row.get::<_, Option<Vec<Option<i64>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::FLOAT4_ARRAY => (
                    row.get::<_, Option<Vec<Option<f32>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::FLOAT8_ARRAY => (
                    row.get::<_, Option<Vec<Option<f64>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::BOOL_ARRAY => (
                    row.get::<_, Option<Vec<Option<bool>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::TIMESTAMP_ARRAY => (
                    row.get::<_, Option<Vec<Option<chrono::NaiveDateTime>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::TIMESTAMPTZ_ARRAY => (
                    row.get::<_, Option<Vec<Option<chrono::DateTime<Utc>>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::DATE_ARRAY => (
                    row.get::<_, Option<Vec<Option<chrono::NaiveDate>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::TIME_ARRAY => (
                    row.get::<_, Option<Vec<Option<chrono::NaiveTime>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::UUID_ARRAY => (
                    row.get::<_, Option<Vec<Option<uuid::Uuid>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::JSON_ARRAY | Type::JSONB_ARRAY => (
                    row.get::<_, Option<Vec<Option<serde_json::Value>>>>(i)
                        .map(|v| format!("{:?}", v))
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "array".to_string(),
                ),
                Type::JSON | Type::JSONB => (
                    row.get::<_, Option<Value>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                Type::FLOAT4 => (
                    row.get::<_, Option<f32>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "number".to_string(),
                ),
                Type::FLOAT8 => (
                    row.get::<_, Option<f64>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "number".to_string(),
                ),
                Type::TIMESTAMP => (
                    row.get::<_, Option<chrono::NaiveDateTime>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                Type::TIMESTAMPTZ => (
                    row.get::<_, Option<chrono::DateTime<Utc>>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                Type::DATE => (
                    row.get::<_, Option<chrono::NaiveDate>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                Type::TIME => (
                    row.get::<_, Option<chrono::NaiveTime>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                Type::UUID => (
                    row.get::<_, Option<uuid::Uuid>>(i)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<<null>>".to_string()),
                    "string".to_string(),
                ),
                // Default case handles all other types including custom enums
                _ => (
                    match row.try_get::<_, Option<RawText>>(i) {
                        Ok(Some(raw_text)) => raw_text.0,
                        Ok(None) => "<<null>>".to_string(),
                        Err(_) => "<<unsupported type>>".to_string(),
                    },
                    "string".to_string(),
                ),
            };
            let mut value_array = Vec::new();
            value_array.push(Value::String(column.name().to_string()));
            value_array.push(Value::String(val_type));
            value_array.push(Value::String(value));
            row_data.push(value_array);
        }
        results.push(row_data);
    }

    serde_json::to_string(&results).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            execute_query,
            execute_query_batch,
            check_psql_availability,
            execute_psql_meta_command,
            cancel_query
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
