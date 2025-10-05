use chrono::Utc;
use serde_json::Value;
use tokio_postgres::{types::Type, Client, NoTls, Row};

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

#[tauri::command]
async fn execute_query(connection_string: &str, query: &str) -> Result<String, String> {
    let client = setup_connection(connection_string)
        .await
        .map_err(|e| e.to_string())?;

    let cancel_token = client.cancel_token();
    let query_future = async { client.query(query, &[]).await.map_err(|e| e.to_string()) };

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
                Err(e) => return Err(e.to_string()),
            }
        }
    }

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
        .invoke_handler(tauri::generate_handler![greet, execute_query, cancel_query])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
