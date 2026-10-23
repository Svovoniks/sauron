//! App data (connections, saved queries, saved results, settings, history) is stored as JSON files in the app
//! data directory instead of the webview's localStorage (5 MB quota, wiped with the webview
//! cache, shared with nothing). Writes are atomic (temp file + rename).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const ALLOWED: [&str; 7] = ["connections", "queries", "results", "settings", "history", "session", "schema"];

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_dir(app)
}

fn file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("Unknown storage name: {name}"));
    }
    Ok(data_dir(app)?.join(format!("{name}.json")))
}

pub async fn read(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    let path = file_path(app, name)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

pub async fn write(app: &AppHandle, name: &str, content: &str) -> Result<(), String> {
    let path = file_path(app, name)?;
    let dir = data_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("Could not replace {}: {e}", path.display()))
}

/// Move a (corrupt) file aside so it is never overwritten, and return where it went.
pub async fn quarantine(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    let path = file_path(app, name)?;
    if !path.exists() {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = path.with_extension(format!("json.bak-{stamp}"));
    tokio::fs::rename(&path, &target)
        .await
        .map_err(|e| format!("Could not move {}: {e}", path.display()))?;
    Ok(Some(target.display().to_string()))
}
