//! Self-update from GitHub releases (Tauri updater plugin: signed `latest.json` + per-platform bundles).
//! The frontend asks `check_for_update`, shows what it found, and on confirmation calls `install_update`.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept until it is installed.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Release notes (the GitHub release body), if any.
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum InstallEvent {
    /// `total` is None when the server does not say how big the download is.
    Progress { downloaded: u64, total: Option<u64> },
    /// The download is done and the update is being installed.
    Installing,
}

/// Asks GitHub whether a newer release exists. `None` = already up to date.
#[tauri::command]
pub async fn check_for_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads and installs the update found by `check_for_update`, reporting progress on `events`.
/// The new version runs after a restart (`restart_app`).
#[tauri::command]
pub async fn install_update(pending: State<'_, PendingUpdate>, events: Channel<InstallEvent>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("There is no update to install. Check for updates first.")?;

    let mut downloaded: u64 = 0;
    let progress = events.clone();
    let done = events;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(InstallEvent::Progress { downloaded, total });
            },
            move || {
                let _ = done.send(InstallEvent::Installing);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    *pending.0.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}
