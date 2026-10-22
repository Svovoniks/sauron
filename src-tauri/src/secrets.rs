//! Passwords live in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux), keyed by connection id - never in app storage or export files.

const SERVICE: &str = "com.svovoniks.sauron";

fn entry(connection_id: &str) -> Result<keyring::Entry, String> {
    if connection_id.is_empty() {
        return Err("Connection has no id".to_string());
    }
    keyring::Entry::new(SERVICE, connection_id).map_err(|e| e.to_string())
}

pub fn get(connection_id: &str) -> Result<Option<String>, String> {
    match entry(connection_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the saved password from the keychain: {e}")),
    }
}

pub fn set(connection_id: &str, password: &str) -> Result<(), String> {
    entry(connection_id)?
        .set_password(password)
        .map_err(|e| format!("Could not save the password to the keychain: {e}"))
}

pub fn delete(connection_id: &str) -> Result<(), String> {
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
