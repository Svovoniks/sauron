//! Certificate files of a Postgres connection, the same ones libpq takes as sslrootcert, sslcert and sslkey.
//! They are read on every connect, so a re-issued certificate (keex hands out week-long ones) is picked up
//! by overwriting the files, without editing the connection. A connection can also use the default files
//! from Settings (settings.json), so one keex certificate serves every STG database.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use native_tls::{Certificate, Identity, TlsConnectorBuilder};

use crate::model::ConnectionParams;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where settings.json lives (the app data directory), for the default certificates.
pub fn init(data_dir: PathBuf) {
    let _ = DATA_DIR.set(data_dir);
}

/// Certificate file paths as typed, "" when unused.
#[derive(Debug, Default, PartialEq)]
pub struct Files {
    pub root: String,
    pub cert: String,
    pub key: String,
}

/// The files a connection uses: its own, or the defaults from Settings when it asks for them.
pub fn files(conn: &ConnectionParams) -> Result<Files, String> {
    if !conn.use_default_certs {
        return Ok(Files {
            root: conn.ssl_root_cert.trim().to_string(),
            cert: conn.ssl_cert.trim().to_string(),
            key: conn.ssl_key.trim().to_string(),
        });
    }
    let defaults = DATA_DIR.get().map(|dir| defaults_in(dir)).unwrap_or_default();
    if defaults == Files::default() {
        return Err("This connection uses the default certificates, but none are set in Settings > Connections".to_string());
    }
    Ok(defaults)
}

fn defaults_in(data_dir: &Path) -> Files {
    let settings = std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_default();
    let path = |key: &str| settings.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
    Files {
        root: path("defaultSslRootCert"),
        cert: path("defaultSslCert"),
        key: path("defaultSslKey"),
    }
}

/// Trust the connection's root certificate and present its client certificate, when they are set.
pub fn configure(builder: &mut TlsConnectorBuilder, conn: &ConnectionParams) -> Result<(), String> {
    let files = files(conn)?;
    if !files.root.is_empty() {
        for root in root_certificates(&read("root certificate", &files.root)?)? {
            builder.add_root_certificate(root);
        }
    }
    match (files.cert.is_empty(), files.key.is_empty()) {
        (true, true) => {}
        (false, false) => {
            let cert = read("client certificate", &files.cert)?;
            let key = pkcs8_der(&read("client key", &files.key)?)?;
            builder.identity(identity(&cert, &key)?);
        }
        (true, false) => return Err("A client key is set but no client certificate".to_string()),
        (false, true) => return Err("A client certificate is set but no client key".to_string()),
    }
    Ok(())
}

/// Neither Security.framework (macOS) nor schannel (Windows) imports a bare PKCS#8 EC key, the kind keex
/// issues, but both take the same key inside a PKCS#12 bundle, so there the pair is bundled in memory first.
#[cfg(any(target_os = "macos", windows))]
fn identity(cert: &[u8], key_pkcs8: &[u8]) -> Result<Identity, String> {
    const PASSWORD: &str = "sauron";
    let text = std::str::from_utf8(cert).map_err(|_| "The client certificate must be a PEM file".to_string())?;
    let certs = pem_blocks(text, "client certificate")?
        .into_iter()
        .filter(|(label, _)| label == "CERTIFICATE")
        .map(|(_, body)| decode(&body, "client certificate"))
        .collect::<Result<Vec<_>, _>>()?;
    let (leaf, chain) = certs
        .split_first()
        .ok_or("The client certificate file has no certificates in it")?;
    let chain: Vec<&[u8]> = chain.iter().map(Vec::as_slice).collect();
    let bundle = p12::PFX::new_with_cas(leaf, key_pkcs8, &chain, PASSWORD, "sauron")
        .ok_or("Could not bundle the client certificate and key")?;
    Identity::from_pkcs12(&bundle.to_der(), PASSWORD)
        .map_err(|e| format!("Could not use the client certificate and key: {e}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn identity(cert: &[u8], key_pkcs8: &[u8]) -> Result<Identity, String> {
    Identity::from_pkcs8(cert, pem("PRIVATE KEY", key_pkcs8).as_bytes())
        .map_err(|e| format!("Could not use the client certificate and key: {e}"))
}

/// The path as typed, with a leading ~ meaning the home directory.
pub fn expand(path: &str) -> PathBuf {
    let path = path.trim();
    match (path.strip_prefix("~/").or(path.strip_prefix("~\\")), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

fn read(what: &str, path: &str) -> Result<Vec<u8>, String> {
    let full = expand(path);
    std::fs::read(&full).map_err(|e| format!("Could not read the {what} {}: {e}", full.display()))
}

fn root_certificates(data: &[u8]) -> Result<Vec<Certificate>, String> {
    if data.starts_with(b"-----") || data.iter().take(64).all(u8::is_ascii) {
        let roots = Certificate::stack_from_pem(data).map_err(|e| format!("Invalid root certificate: {e}"))?;
        if roots.is_empty() {
            return Err("The root certificate file has no certificates in it".to_string());
        }
        Ok(roots)
    } else {
        Certificate::from_der(data)
            .map(|root| vec![root])
            .map_err(|e| format!("Invalid root certificate: {e}"))
    }
}

/// native-tls wants PKCS#8 keys, while openssl and step-ca often write the older SEC1 (EC) or PKCS#1 (RSA)
/// form, which libpq takes as is. Rewrap those so either file works here too.
fn pkcs8_der(data: &[u8]) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(data).map_err(|_| "The client key must be a PEM file".to_string())?;
    // the first key block, skipping e.g. an EC PARAMETERS block in front of it
    let (label, body) = pem_blocks(text, "client key")?
        .into_iter()
        .find(|(label, _)| label.ends_with("PRIVATE KEY"))
        .ok_or("No private key found in the client key file")?;
    if body.contains("Proc-Type:") || label == "ENCRYPTED PRIVATE KEY" {
        return Err("Password-protected client keys are not supported".to_string());
    }
    let der = decode(&body, "client key")?;
    match label.as_str() {
        "PRIVATE KEY" => Ok(der),
        "EC PRIVATE KEY" => wrap_sec1(&der),
        "RSA PRIVATE KEY" => Ok(wrap_pkcs1(&der)),
        other => Err(format!("Unsupported client key type: {other}")),
    }
}

/// Every BEGIN/END block of a PEM file as (label, body).
fn pem_blocks(text: &str, what: &str) -> Result<Vec<(String, String)>, String> {
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("-----BEGIN ") {
        let after = &rest[start + 11..];
        let label_end = after.find("-----").ok_or_else(|| format!("Malformed PEM header in the {what}"))?;
        let label = after[..label_end].to_string();
        let body_and_rest = &after[label_end + 5..];
        let end_marker = format!("-----END {label}-----");
        let body_end = body_and_rest
            .find(&end_marker)
            .ok_or_else(|| format!("The {what} has no END {label} line"))?;
        blocks.push((label, body_and_rest[..body_end].to_string()));
        rest = &body_and_rest[body_end + end_marker.len()..];
    }
    Ok(blocks)
}

fn decode(body: &str, what: &str) -> Result<Vec<u8>, String> {
    let b64: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(b64).map_err(|e| format!("Invalid base64 in the {what}: {e}"))
}

#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn pem(label: &str, der: &[u8]) -> String {
    let b64 = STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

// --- minimal DER, just enough to rewrap a key ------------------------------------------------

const SEQUENCE: u8 = 0x30;
const OCTET_STRING: u8 = 0x04;
/// version 0 of PrivateKeyInfo
const VERSION_0: [u8; 3] = [0x02, 0x01, 0x00];
/// OID 1.2.840.10045.2.1 (id-ecPublicKey)
const EC_PUBLIC_KEY: [u8; 9] = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
/// OID 1.2.840.113549.1.1.1 (rsaEncryption) followed by NULL parameters
const RSA_ENCRYPTION: [u8; 13] = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/// Splits off one TLV: (tag, content, rest).
fn tlv(buf: &[u8]) -> Result<(u8, &[u8], &[u8]), String> {
    let bad = || "Malformed client key".to_string();
    let tag = *buf.first().ok_or_else(bad)?;
    let first = *buf.get(1).ok_or_else(bad)?;
    let (len, header) = if first < 0x80 {
        (first as usize, 2)
    } else {
        let n = (first & 0x7f) as usize;
        if n == 0 || n > 4 {
            return Err(bad());
        }
        let bytes = buf.get(2..2 + n).ok_or_else(bad)?;
        (bytes.iter().fold(0usize, |acc, b| (acc << 8) | *b as usize), 2 + n)
    };
    let end = header.checked_add(len).filter(|end| *end <= buf.len()).ok_or_else(bad)?;
    Ok((tag, &buf[header..end], &buf[end..]))
}

fn encode(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes: Vec<u8> = len.to_be_bytes().into_iter().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
    out.extend_from_slice(content);
    out
}

fn private_key_info(algorithm: &[u8], key: &[u8]) -> Vec<u8> {
    let mut body = VERSION_0.to_vec();
    body.extend(encode(SEQUENCE, algorithm));
    body.extend(encode(OCTET_STRING, key));
    encode(SEQUENCE, &body)
}

fn wrap_pkcs1(der: &[u8]) -> Vec<u8> {
    private_key_info(&RSA_ENCRYPTION, der)
}

/// SEC1 ECPrivateKey is SEQUENCE { version, privateKey, [0] curve OID (optional), [1] publicKey (optional) };
/// PKCS#8 needs the curve in the algorithm identifier.
fn wrap_sec1(der: &[u8]) -> Result<Vec<u8>, String> {
    let (tag, mut fields, _) = tlv(der)?;
    if tag != SEQUENCE {
        return Err("Malformed EC client key".to_string());
    }
    while !fields.is_empty() {
        let (tag, content, rest) = tlv(fields)?;
        // [0] holds exactly the curve OID, already DER encoded
        if tag == 0xa0 {
            let mut algorithm = EC_PUBLIC_KEY.to_vec();
            algorithm.extend_from_slice(content);
            return Ok(private_key_info(&algorithm, der));
        }
        fields = rest;
    }
    Err("The EC client key does not name its curve".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// prime256v1 (1.2.840.10045.3.1.7)
    const P256: [u8; 10] = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

    /// A SEC1 key file shaped like the ones openssl writes, with an all-zero (not a real) private key.
    fn sec1_pem() -> String {
        let mut body = vec![0x02, 0x01, 0x01];
        body.extend(encode(OCTET_STRING, &[0u8; 32]));
        body.extend(encode(0xa0, &P256));
        format!("{}{}", pem("EC PARAMETERS", &P256), pem("EC PRIVATE KEY", &encode(SEQUENCE, &body)))
    }

    #[test]
    fn sec1_key_is_rewrapped_with_its_curve() {
        let sec1 = sec1_pem();
        let der = pkcs8_der(sec1.as_bytes()).unwrap();
        let (tag, body, rest) = tlv(&der).unwrap();
        assert_eq!((tag, rest.len()), (SEQUENCE, 0));
        assert!(body.starts_with(&VERSION_0));
        let (_, algorithm, rest) = tlv(&body[3..]).unwrap();
        assert_eq!(&algorithm[..9], &EC_PUBLIC_KEY);
        assert_eq!(&algorithm[9..], &P256);
        let (tag, key, _) = tlv(rest).unwrap();
        assert_eq!(tag, OCTET_STRING);
        let (_, sec1_body) = pem_blocks(&sec1, "key").unwrap().remove(1);
        assert_eq!(key, decode(&sec1_body, "key").unwrap().as_slice());
    }

    #[test]
    fn pkcs8_key_passes_through_and_others_are_refused() {
        let pkcs8 = pkcs8_der(sec1_pem().as_bytes()).unwrap();
        assert_eq!(pkcs8_der(pem("PRIVATE KEY", &pkcs8).as_bytes()).unwrap(), pkcs8);
        assert!(pkcs8_der(b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n")
            .unwrap_err()
            .contains("Password-protected"));
        assert!(pkcs8_der(b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n").is_err());
        assert!(pkcs8_der(b"garbage").is_err());
    }

    #[test]
    fn default_files_come_from_settings() {
        let dir = std::env::temp_dir().join(format!("sauron-cert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(defaults_in(&dir), Files::default());
        std::fs::write(
            dir.join("settings.json"),
            r#"{"defaultSslRootCert":" ~/c/root.pem ","defaultSslCert":"/c/cert.pem","defaultSslKey":"/c/key.pem","rowLimit":5}"#,
        )
        .unwrap();
        let files = defaults_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            files,
            Files { root: "~/c/root.pem".into(), cert: "/c/cert.pem".into(), key: "/c/key.pem".into() }
        );
    }

    #[test]
    fn long_lengths_round_trip() {
        let content = vec![7u8; 300];
        let encoded = encode(OCTET_STRING, &content);
        let (tag, parsed, rest) = tlv(&encoded).unwrap();
        assert_eq!((tag, parsed, rest.len()), (OCTET_STRING, content.as_slice(), 0));
    }

    #[test]
    fn rsa_key_gets_the_rsa_algorithm() {
        let der = wrap_pkcs1(&[0x30, 0x00]);
        assert!(der.windows(RSA_ENCRYPTION.len()).any(|w| w == RSA_ENCRYPTION));
    }
}
