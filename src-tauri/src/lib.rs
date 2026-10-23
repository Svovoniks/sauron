mod cancel;
mod clickhouse;
mod meta;
mod model;
mod postgres;
mod psql;
mod psql_format;
mod secrets;
mod storage;
mod test_connection;
mod updater;

use cancel::Registry;
use model::{ConnectionParams, DbType, QueryResult, StatementOutcome, TestReport};
use tauri::{AppHandle, State};

const MAX_ROW_LIMIT: usize = 1_000_000;

#[tauri::command]
async fn execute_query(
    registry: State<'_, Registry>,
    connection: ConnectionParams,
    statements: Vec<String>,
    row_limit: usize,
) -> Result<QueryResult, String> {
    let row_limit = row_limit.clamp(1, MAX_ROW_LIMIT);
    // Registered before anything else (even the password lookup or connect) so Abort always works.
    let guard = registry.begin();
    let password = blocking_password(&connection.id).await?;

    match connection.db_type {
        DbType::Postgres => postgres::execute(&connection, &password, &statements, row_limit, &guard).await,
        DbType::Clickhouse => clickhouse::execute(&connection, &password, &statements, row_limit, &guard).await,
    }
}

/// Runs a script statement by statement in one session and returns every statement's result.
#[tauri::command]
async fn execute_script(
    registry: State<'_, Registry>,
    connection: ConnectionParams,
    statements: Vec<String>,
    row_limit: usize,
    background: Option<bool>,
) -> Result<Vec<StatementOutcome>, String> {
    let row_limit = row_limit.clamp(1, MAX_ROW_LIMIT);
    // Background work (schema loading) must not take over the "running query" slot that Abort stops.
    let own_registry = Registry::default();
    let guard = if background == Some(true) { own_registry.begin() } else { registry.begin() };
    let password = blocking_password(&connection.id).await?;

    match connection.db_type {
        DbType::Postgres => postgres::execute_script(&connection, &password, &statements, row_limit, &guard).await,
        DbType::Clickhouse => clickhouse::execute_script(&connection, &password, &statements, row_limit, &guard).await,
    }
}

/// Step-by-step connection check for the connection form and the tab menu.
#[tauri::command]
async fn test_connection(connection: ConnectionParams, password: Option<String>) -> Result<TestReport, String> {
    // Not cancellable with Abort, and it must not take over the slot of a query that is running.
    let own_registry = Registry::default();
    let guard = own_registry.begin();
    // The form tests what is typed, before it is saved: an explicit password wins over the keychain.
    let password = match password {
        Some(p) if !p.is_empty() => p,
        _ => blocking_password(&connection.id).await?,
    };
    Ok(test_connection::run(&connection, &password, &guard).await)
}

/// Backslash commands: the text goes to the real `psql`, unfiltered. If `psql` is not installed the
/// built-in read-only catalog commands (`meta.rs`) are used instead.
#[tauri::command]
async fn execute_meta_command(
    registry: State<'_, Registry>,
    connection: ConnectionParams,
    command_text: String,
    psql_path: Option<String>,
    use_fallback: Option<bool>,
) -> Result<meta::MetaOutput, String> {
    if connection.db_type != DbType::Postgres {
        return Err("Backslash commands are only available for Postgres connections. For ClickHouse use SHOW DATABASES, SHOW TABLES, DESCRIBE TABLE <name>.".to_string());
    }
    let guard = registry.begin();
    let password = blocking_password(&connection.id).await?;

    match psql::execute(&connection, &password, &command_text, &guard, psql_path.as_deref()).await {
        Ok(text) => Ok(meta::MetaOutput { text }),
        Err(psql::PsqlError::Failed(message)) => Err(message),
        Err(psql::PsqlError::NotInstalled(message)) if use_fallback == Some(false) => Err(message),
        Err(psql::PsqlError::NotInstalled(_)) => meta::execute(&connection, &password, &command_text, &guard)
            .await
            .map_err(|e| format!("psql is not installed, so only the built-in read-only commands are available. {e}")),
    }
}

#[tauri::command]
async fn cancel_query(registry: State<'_, Registry>) -> Result<(), String> {
    registry.cancel().await;
    Ok(())
}

async fn blocking_password(connection_id: &str) -> Result<String, String> {
    let id = connection_id.to_string();
    tokio::task::spawn_blocking(move || secrets::password_or_empty(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_password(connection_id: String, password: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || secrets::set(&connection_id, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_password(connection_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || secrets::delete(&connection_id))
        .await
        .map_err(|e| e.to_string())?
}

/// The saved password itself (used by the eye icon in the connection form and by "export with passwords").
#[tauri::command]
async fn get_password(connection_id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || secrets::get(&connection_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn has_password(connection_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || secrets::get(&connection_id).map(|p| p.is_some()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn storage_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    storage::read(&app, &name).await
}

#[tauri::command]
async fn storage_write(app: AppHandle, name: String, content: String) -> Result<(), String> {
    storage::write(&app, &name, &content).await
}

/// Where the app keeps its files (shown in Settings).
#[tauri::command]
async fn storage_dir(app: AppHandle) -> Result<String, String> {
    storage::dir(&app).map(|p| p.display().to_string())
}

#[tauri::command]
async fn storage_quarantine(app: AppHandle, name: String) -> Result<Option<String>, String> {
    storage::quarantine(&app, &name).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Registry::default())
        .manage(updater::PendingUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            execute_query,
            execute_script,
            test_connection,
            execute_meta_command,
            cancel_query,
            save_password,
            delete_password,
            has_password,
            get_password,
            storage_read,
            storage_write,
            storage_quarantine,
            storage_dir,
            updater::check_for_update,
            updater::install_update,
            updater::restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
