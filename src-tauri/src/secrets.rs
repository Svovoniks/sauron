//! Passwords live in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux), keyed by connection id - never in app storage or export files.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.svovoniks.sauron";

/// Passwords already read from the keychain this session. macOS asks for permission on *every* keychain read
/// (ad-hoc signed builds can't keep an "Always Allow"), and one click on a connection runs several commands
/// (test, schema, query), so without this each of them would show its own prompt. The lock is held across the
/// read on purpose: concurrent commands wait for the first prompt and then hit the cache instead of prompting again.
fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn locked() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn entry(connection_id: &str) -> Result<keyring::Entry, String> {
    if connection_id.is_empty() {
        return Err("Connection has no id".to_string());
    }
    keyring::Entry::new(SERVICE, connection_id).map_err(|e| e.to_string())
}

pub fn get(connection_id: &str) -> Result<Option<String>, String> {
    let mut cached = locked();
    if let Some(password) = cached.get(connection_id) {
        return Ok(Some(password.clone()));
    }
    match entry(connection_id)?.get_password() {
        Ok(password) => {
            cached.insert(connection_id.to_string(), password.clone());
            Ok(Some(password))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the saved password from the keychain: {e}")),
    }
}

pub fn set(connection_id: &str, password: &str) -> Result<(), String> {
    let mut cached = locked();
    entry(connection_id)?
        .set_password(password)
        .map_err(|e| format!("Could not save the password to the keychain: {e}"))?;
    cached.insert(connection_id.to_string(), password.to_string());
    Ok(())
}

pub fn delete(connection_id: &str) -> Result<(), String> {
    let mut cached = locked();
    cached.remove(connection_id);
    match entry(connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete the saved password: {e}")),
    }
}

/// Password for a connection; empty when none is saved.
pub fn password_or_empty(connection_id: &str) -> Result<String, String> {
    Ok(get(connection_id)?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real OS keychain: `cargo test -- --ignored secrets`.
    #[test]
    #[ignore]
    fn roundtrip_through_the_os_keychain() {
        let id = format!("sauron-test-{}", uuid::Uuid::new_v4());
        assert_eq!(get(&id).unwrap(), None);
        set(&id, "p@ss w0rd/ü").unwrap();
        assert_eq!(get(&id).unwrap().as_deref(), Some("p@ss w0rd/ü"));
        set(&id, "changed").unwrap();
        assert_eq!(password_or_empty(&id).unwrap(), "changed");
        delete(&id).unwrap();
        assert_eq!(get(&id).unwrap(), None);
        delete(&id).unwrap(); // deleting twice is fine
        assert_eq!(password_or_empty(&id).unwrap(), "");
    }
}
