//! Passwords are kept apart from the connection list, keyed by connection id - never in app storage or export files.
//!
//! Windows and Linux use the OS keychain (Credential Manager, Secret Service). macOS uses an encrypted file (`vault`):
//! the Keychain remembers which *build* created an item and asks for the login password again after every update,
//! once per saved connection, and that cannot be avoided without a paid Apple Developer ID.

use std::path::PathBuf;

#[cfg(target_os = "macos")]
mod vault;

/// Tells the password store where the app data directory is (only macOS keeps files there).
pub fn init(dir: PathBuf) {
    #[cfg(target_os = "macos")]
    vault::init(dir);
    #[cfg(not(target_os = "macos"))]
    let _ = dir;
}

pub fn get(connection_id: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    return vault::get(connection_id);
    #[cfg(not(target_os = "macos"))]
    return keychain::get(connection_id);
}

pub fn set(connection_id: &str, password: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return vault::set(connection_id, password);
    #[cfg(not(target_os = "macos"))]
    return keychain::set(connection_id, password);
}

pub fn delete(connection_id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return vault::delete(connection_id);
    #[cfg(not(target_os = "macos"))]
    return keychain::delete(connection_id);
}

/// Password for a connection; empty when none is saved.
pub fn password_or_empty(connection_id: &str) -> Result<String, String> {
    Ok(get(connection_id)?.unwrap_or_default())
}

/// The OS keychain, keyed by connection id. On macOS it is only read to pick up passwords saved by older versions.
mod keychain {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    const SERVICE: &str = "com.svovoniks.sauron";

    /// Passwords already read from the keychain this session: one click on a connection runs several commands
    /// (test, schema, query), and a keychain that asks for permission would show a prompt for each of them. The lock
    /// is held across the read on purpose: concurrent commands wait for the first read and then hit the cache.
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

    #[cfg_attr(target_os = "macos", allow(dead_code))]
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real OS keychain: `cargo test -- --ignored secrets`.
    #[test]
    #[ignore]
    fn roundtrip_through_the_os_keychain() {
        let id = format!("sauron-test-{}", uuid::Uuid::new_v4());
        assert_eq!(keychain::get(&id).unwrap(), None);
        keychain::set(&id, "p@ss w0rd/ü").unwrap();
        assert_eq!(keychain::get(&id).unwrap().as_deref(), Some("p@ss w0rd/ü"));
        keychain::set(&id, "changed").unwrap();
        assert_eq!(keychain::get(&id).unwrap().as_deref(), Some("changed"));
        keychain::delete(&id).unwrap();
        assert_eq!(keychain::get(&id).unwrap(), None);
        keychain::delete(&id).unwrap(); // deleting twice is fine
    }
}
