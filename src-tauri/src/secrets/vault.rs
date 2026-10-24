//! macOS password store: one AES-256-GCM encrypted file in the app data directory, so nothing ever asks for the
//! login password - not on first use and not after an update (see the module docs of `secrets`).
//!
//! The key is derived from this Mac's hardware UUID, so the file is useless when copied to another machine or
//! picked up from a backup. It does not protect against a process running as you on this Mac: that process can
//! derive the same key, just as it could read `~/.pgpass`. The file is readable by the owner only.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sha2::{Digest, Sha256};

use super::keychain;

const FILE: &str = "passwords.bin";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;

static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

struct Vault {
    path: PathBuf,
    key: [u8; 32],
    passwords: HashMap<String, String>,
}

fn state() -> &'static Mutex<Option<Vault>> {
    static STATE: OnceLock<Mutex<Option<Vault>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// Runs `f` on the vault, opening (and decrypting) the file on first use.
fn with_vault<T>(f: impl FnOnce(&mut Vault) -> Result<T, String>) -> Result<T, String> {
    let mut guard: MutexGuard<Option<Vault>> = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        let dir = DIR.get().ok_or("The password store is not initialised")?;
        *guard = Some(Vault::open(dir.join(FILE), machine_key()?)?);
    }
    f(guard.as_mut().expect("opened above"))
}

fn check_id(connection_id: &str) -> Result<(), String> {
    if connection_id.is_empty() {
        return Err("Connection has no id".to_string());
    }
    Ok(())
}

pub fn get(connection_id: &str) -> Result<Option<String>, String> {
    check_id(connection_id)?;
    with_vault(|vault| {
        if let Some(password) = vault.passwords.get(connection_id) {
            return Ok(Some(password.clone()));
        }
        // Saved by an older version, which used the Keychain: move it over (this is the one and only time macOS asks).
        match keychain::get(connection_id)? {
            Some(password) => {
                vault.passwords.insert(connection_id.to_string(), password.clone());
                vault.save()?;
                let _ = keychain::delete(connection_id);
                Ok(Some(password))
            }
            None => Ok(None),
        }
    })
}

pub fn set(connection_id: &str, password: &str) -> Result<(), String> {
    check_id(connection_id)?;
    with_vault(|vault| {
        vault.passwords.insert(connection_id.to_string(), password.to_string());
        vault.save()
    })
}

pub fn delete(connection_id: &str) -> Result<(), String> {
    check_id(connection_id)?;
    with_vault(|vault| {
        if vault.passwords.remove(connection_id).is_some() {
            vault.save()?;
        }
        Ok(())
    })?;
    let _ = keychain::delete(connection_id); // a leftover item from an older version
    Ok(())
}

impl Vault {
    fn open(path: PathBuf, key: [u8; 32]) -> Result<Self, String> {
        let passwords = match std::fs::read(&path) {
            Ok(bytes) => match decrypt(&key, &bytes) {
                Ok(passwords) => passwords,
                Err(reason) => {
                    // Never overwrite a file we cannot read (it may come from another Mac); keep it next to the new one.
                    let aside = path.with_extension("bin.unreadable");
                    std::fs::rename(&path, &aside).map_err(|e| format!("Could not move {} aside: {e}", path.display()))?;
                    eprintln!("password store unreadable ({reason}); moved to {}", aside.display());
                    HashMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        Ok(Self { path, key, passwords })
    }

    fn save(&self) -> Result<(), String> {
        let bytes = encrypt(&self.key, &self.passwords)?;
        write_private(&self.path, &bytes)
    }
}

/// Atomic write (temp file + rename) of a file only the owner can read.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("bin.tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not replace {}: {e}", path.display()))
}

fn machine_key() -> Result<[u8; 32], String> {
    let output = Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("Could not identify this Mac to protect saved passwords: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    // `    "IOPlatformUUID" = "XXXXXXXX-XXXX-..."`
    let uuid = text
        .lines()
        .find(|line| line.contains("IOPlatformUUID"))
        .and_then(|line| line.split('"').nth(3))
        .filter(|uuid| !uuid.is_empty())
        .ok_or("Could not identify this Mac to protect saved passwords")?;
    Ok(derive_key(uuid))
}

fn derive_key(machine_id: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"sauron-password-store-v1\0");
    hasher.update(machine_id.as_bytes());
    hasher.finalize().into()
}

/// `[version][nonce][ciphertext]`
fn encrypt(key: &[u8; 32], passwords: &HashMap<String, String>) -> Result<Vec<u8>, String> {
    let plain = serde_json::to_vec(passwords).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = cipher.encrypt(&nonce, plain.as_slice()).map_err(|_| "Could not encrypt the saved passwords".to_string())?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + sealed.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn decrypt(key: &[u8; 32], bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    if bytes.len() < 1 + NONCE_LEN || bytes[0] != VERSION {
        return Err("unknown file format".to_string());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plain = cipher
        .decrypt(Nonce::from_slice(&bytes[1..1 + NONCE_LEN]), &bytes[1 + NONCE_LEN..])
        .map_err(|_| "wrong key or damaged file".to_string())?;
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> HashMap<String, String> {
        HashMap::from([("a".to_string(), "p@ss w0rd/ü".to_string()), ("b".to_string(), String::new())])
    }

    #[test]
    fn roundtrip() {
        let key = derive_key("machine-1");
        let bytes = encrypt(&key, &sample()).unwrap();
        assert_eq!(decrypt(&key, &bytes).unwrap(), sample());
    }

    #[test]
    fn the_file_does_not_contain_the_passwords() {
        let bytes = encrypt(&derive_key("machine-1"), &sample()).unwrap();
        assert!(!bytes.windows(4).any(|w| w == b"p@ss"));
    }

    #[test]
    fn another_machine_cannot_read_it() {
        let bytes = encrypt(&derive_key("machine-1"), &sample()).unwrap();
        assert!(decrypt(&derive_key("machine-2"), &bytes).is_err());
    }

    #[test]
    fn damaged_or_foreign_files_are_rejected() {
        let key = derive_key("machine-1");
        let mut bytes = encrypt(&key, &sample()).unwrap();
        assert!(decrypt(&key, &[]).is_err());
        assert!(decrypt(&key, b"not a vault, just text").is_err());
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(decrypt(&key, &bytes).is_err());
    }

    #[test]
    fn this_mac_has_an_identity() {
        assert_eq!(machine_key().unwrap(), machine_key().unwrap());
    }

    #[test]
    fn saved_passwords_survive_a_restart_and_the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sauron-vault-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE);
        let key = derive_key("machine-1");

        let mut vault = Vault::open(path.clone(), key).unwrap();
        vault.passwords.insert("c1".into(), "secret".into());
        vault.save().unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        let reopened = Vault::open(path.clone(), key).unwrap();
        assert_eq!(reopened.passwords.get("c1").map(String::as_str), Some("secret"));

        // a file from another Mac is kept aside, not overwritten
        let foreign = Vault::open(path.clone(), derive_key("machine-2")).unwrap();
        assert!(foreign.passwords.is_empty());
        assert!(path.with_extension("bin.unreadable").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
