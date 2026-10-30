//! Certificate files of a Postgres connection, the same ones libpq takes as sslrootcert, sslcert and sslkey.
//! They are read on every connect, so a re-issued certificate (keex hands out week-long ones) is picked up
//! by overwriting the files, without editing the connection. A connection can also use the default files
//! from Settings (settings.json), so one keex certificate serves every STG database. When the client
//! certificate has expired, the renewal command from Settings (if any) is run before connecting.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use native_tls::{Certificate, Identity, TlsConnectorBuilder};

use crate::model::ConnectionParams;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// One renewal at a time: connections that notice the expiry together wait for it instead of starting their own.
static RENEWING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Long enough for a browser single sign-on.
const RENEW_TIMEOUT: Duration = Duration::from_secs(300);

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
    let defaults = DATA_DIR.get().map(|dir| defaults_in(&settings_in(dir))).unwrap_or_default();
    if defaults == Files::default() {
        return Err("This connection uses the default certificates, but none are set in Settings > Connections".to_string());
    }
    Ok(defaults)
}

fn settings_in(data_dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn text_setting(settings: &serde_json::Value, key: &str) -> String {
    settings.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
}

fn defaults_in(settings: &serde_json::Value) -> Files {
    Files {
        root: text_setting(settings, "defaultSslRootCert"),
        cert: text_setting(settings, "defaultSslCert"),
        key: text_setting(settings, "defaultSslKey"),
    }
}

/// When the connection's client certificate has expired and Settings has a renewal command, run it and check
/// again. Without a command (or with an unreadable certificate) this does nothing and the connect itself reports it.
pub async fn renew_if_expired(conn: &ConnectionParams) -> Result<(), String> {
    let Ok(files) = files(conn) else { return Ok(()) };
    if files.cert.is_empty() || !is_expired(&files) {
        return Ok(());
    }
    let command = DATA_DIR
        .get()
        .map(|dir| text_setting(&settings_in(dir), "certRenewCommand"))
        .unwrap_or_default();
    if command.is_empty() {
        return Ok(());
    }
    let _renewing = RENEWING.lock().await;
    // another connection may have renewed it while this one waited
    if !is_expired(&files) {
        return Ok(());
    }
    run_renewal(&command, &files).await?;
    if is_expired(&files) {
        return Err(format!(
            "The certificate renewal command finished, but the client certificate {} is still expired",
            expand(&files.cert).display()
        ));
    }
    Ok(())
}

/// "Renew now" in Settings: runs the renewal command whether or not the certificate has expired, with the
/// command and default files as they are on screen (settings.json is written with a delay). Returns how long
/// the client certificate is valid now, when one is set.
pub async fn renew_now(command: &str, files: &Files) -> Result<Option<String>, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Set a certificate renewal command first".to_string());
    }
    let _renewing = RENEWING.lock().await;
    run_renewal(command, files).await?;
    if files.cert.is_empty() {
        return Ok(None);
    }
    let (_, not_after) = validity(&read("client certificate", &files.cert)?)?;
    if now() >= not_after.secs {
        return Err(format!(
            "The certificate renewal command finished, but the client certificate {} is still expired",
            expand(&files.cert).display()
        ));
    }
    Ok(Some(not_after.text))
}

fn is_expired(files: &Files) -> bool {
    read("client certificate", &files.cert)
        .and_then(|cert| validity(&cert))
        .is_ok_and(|(_, not_after)| now() >= not_after.secs)
}

/// Runs the command in the user's login shell (an app started from the Finder has a bare PATH, without Homebrew),
/// with the certificate paths in SAURON_SSL_ROOT_CERT, SAURON_SSL_CERT and SAURON_SSL_KEY.
async fn run_renewal(command: &str, files: &Files) -> Result<(), String> {
    #[cfg(unix)]
    let mut cmd = {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/sh".to_string());
        let mut cmd = tokio::process::Command::new(shell);
        cmd.arg("-l").arg("-c").arg(command).process_group(0);
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    };
    for (var, path) in [("SAURON_SSL_ROOT_CERT", &files.root), ("SAURON_SSL_CERT", &files.cert), ("SAURON_SSL_KEY", &files.key)] {
        cmd.env(var, if path.is_empty() { PathBuf::new() } else { expand(path) });
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the certificate renewal command: {e}"))?;
    // Timing out or cancelling the query drops the wait; the guard then stops everything the command started.
    let _group = ProcessGroup(child.id());
    let output = match tokio::time::timeout(RENEW_TIMEOUT, child.wait_with_output()).await {
        Err(_) => return Err(format!("The certificate renewal command did not finish within {} minutes", RENEW_TIMEOUT.as_secs() / 60)),
        Ok(Err(e)) => return Err(format!("Could not run the certificate renewal command: {e}")),
        Ok(Ok(output)) => output,
    };
    if output.status.success() {
        return Ok(());
    }
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let text = text.trim();
    let tail: String = text.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
    Err(format!(
        "The certificate renewal command failed ({}){}",
        output.status,
        if tail.is_empty() { String::new() } else { format!(": {tail}") }
    ))
}

/// Terminates the renewal command's whole process group when dropped (a no-op once it has exited), so a helper
/// it started, like a listener waiting for the login callback, does not outlive it.
#[cfg_attr(windows, allow(dead_code))]
struct ProcessGroup(Option<u32>);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // A direct killpg: the kill binary from procps-ng skips the group when its leader (the killed shell) is a zombie.
        #[cfg(unix)]
        if let Some(pgid) = self.0.and_then(|pid| libc::pid_t::try_from(pid).ok()) {
            // SAFETY: killpg only sends a signal; an already empty group just makes it fail with ESRCH.
            unsafe {
                libc::killpg(pgid, libc::SIGTERM);
            }
        }
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
            check_dates(&cert, &files.cert, now())?;
            let key = pkcs8_der(&read("client key", &files.key)?)?;
            builder.identity(identity(&cert, &key)?);
        }
        (true, false) => return Err("A client key is set but no client certificate".to_string()),
        (false, true) => return Err("A client certificate is set but no client key".to_string()),
    }
    Ok(())
}

/// Fails with a clear message when the client certificate has expired (or is not valid yet), before connecting:
/// the server would only answer with an opaque TLS alert. psql uses it too.
pub fn check_expiry(files: &Files) -> Result<(), String> {
    if files.cert.is_empty() {
        return Ok(());
    }
    check_dates(&read("client certificate", &files.cert)?, &files.cert, now())
}

/// When the connection's client certificate stops being valid, for Test connection ("2026-11-06 08:49 UTC").
pub fn expiry(conn: &ConnectionParams) -> Option<String> {
    let files = files(conn).ok()?;
    if files.cert.is_empty() {
        return None;
    }
    let (_, not_after) = validity(&read("client certificate", &files.cert).ok()?).ok()?;
    Some(not_after.text)
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn check_dates(cert: &[u8], path: &str, now: i64) -> Result<(), String> {
    let (not_before, not_after) = validity(cert)?;
    let shown = expand(path).display().to_string();
    if now >= not_after.secs {
        return Err(format!(
            "The client certificate expired on {} ({shown}). Issue a new one and overwrite the file.",
            not_after.text
        ));
    }
    if now < not_before.secs {
        return Err(format!(
            "The client certificate is not valid until {} ({shown}). Check this computer's clock.",
            not_before.text
        ));
    }
    Ok(())
}

/// A certificate date as seconds since 1970 and as text.
#[derive(Debug, PartialEq)]
struct Moment {
    secs: i64,
    text: String,
}

/// notBefore and notAfter of the first (leaf) certificate of a PEM or DER file.
fn validity(cert: &[u8]) -> Result<(Moment, Moment), String> {
    let der = match std::str::from_utf8(cert) {
        Ok(text) if text.contains("-----BEGIN ") => {
            let (_, body) = pem_blocks(text, "client certificate")?
                .into_iter()
                .find(|(label, _)| label == "CERTIFICATE")
                .ok_or("The client certificate file has no certificates in it")?;
            decode(&body, "client certificate")?
        }
        _ => cert.to_vec(),
    };
    let bad = || "Malformed client certificate".to_string();
    // Certificate is SEQUENCE { tbsCertificate, ... }; tbsCertificate is SEQUENCE { [0] version (optional),
    // serialNumber, signature, issuer, validity, ... }; validity is SEQUENCE { notBefore, notAfter }.
    let (_, certificate, _) = tlv(&der)?;
    let (_, mut tbs, _) = tlv(certificate)?;
    if tbs.first() == Some(&0xa0) {
        tbs = tlv(tbs)?.2;
    }
    for _ in 0..3 {
        tbs = tlv(tbs)?.2;
    }
    let (tag, dates, _) = tlv(tbs)?;
    if tag != SEQUENCE {
        return Err(bad());
    }
    let (tag_before, before, rest) = tlv(dates)?;
    let (tag_after, after, _) = tlv(rest)?;
    Ok((time(tag_before, before).ok_or_else(bad)?, time(tag_after, after).ok_or_else(bad)?))
}

/// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ), the only forms RFC 5280 allows.
fn time(tag: u8, value: &[u8]) -> Option<Moment> {
    let text = std::str::from_utf8(value).ok()?.strip_suffix('Z')?;
    let (year, rest) = match (tag, text.len()) {
        (0x17, 12) => {
            let yy: i64 = text[..2].parse().ok()?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &text[2..])
        }
        (0x18, 14) => (text[..4].parse().ok()?, &text[4..]),
        _ => return None,
    };
    let field = |at: usize| rest.get(at..at + 2)?.parse::<i64>().ok();
    let (month, day, hour, minute, second) = (field(0)?, field(2)?, field(4)?, field(6)?, field(8)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some(Moment {
        secs: days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second,
        text: format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02} UTC"),
    })
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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
        assert_eq!(defaults_in(&settings_in(&dir)), Files::default());
        std::fs::write(
            dir.join("settings.json"),
            r#"{"defaultSslRootCert":" ~/c/root.pem ","defaultSslCert":"/c/cert.pem","defaultSslKey":"/c/key.pem","rowLimit":5}"#,
        )
        .unwrap();
        let files = defaults_in(&settings_in(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            files,
            Files { root: "~/c/root.pem".into(), cert: "/c/cert.pem".into(), key: "/c/key.pem".into() }
        );
    }

    /// Just the parts of a certificate the date check reads: version, serial, algorithm, issuer, validity.
    fn certificate_pem(not_before: (u8, &str), not_after: (u8, &str)) -> String {
        let mut tbs = encode(0xa0, &[0x02, 0x01, 0x02]);
        tbs.extend([0x02, 0x01, 0x01]);
        tbs.extend(encode(SEQUENCE, &EC_PUBLIC_KEY));
        tbs.extend(encode(SEQUENCE, &[]));
        let mut dates = encode(not_before.0, not_before.1.as_bytes());
        dates.extend(encode(not_after.0, not_after.1.as_bytes()));
        tbs.extend(encode(SEQUENCE, &dates));
        pem("CERTIFICATE", &encode(SEQUENCE, &encode(SEQUENCE, &tbs)))
    }

    #[test]
    fn validity_dates_are_read_in_both_time_formats() {
        let cert = certificate_pem((0x17, "261030084811Z"), (0x18, "20261106084911Z"));
        let (before, after) = validity(cert.as_bytes()).unwrap();
        assert_eq!(before, Moment { secs: 1_793_350_091, text: "2026-10-30 08:48 UTC".into() });
        assert_eq!(after, Moment { secs: 1_793_954_951, text: "2026-11-06 08:49 UTC".into() });
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn expired_and_not_yet_valid_certificates_are_refused() {
        let cert = certificate_pem((0x17, "261030084811Z"), (0x17, "261106084911Z"));
        assert!(check_dates(cert.as_bytes(), "/c/cert.pem", 1_793_500_000).is_ok());
        let expired = check_dates(cert.as_bytes(), "/c/cert.pem", 1_793_954_951).unwrap_err();
        assert!(expired.contains("expired on 2026-11-06 08:49 UTC") && expired.contains("/c/cert.pem"), "{expired}");
        let early = check_dates(cert.as_bytes(), "/c/cert.pem", 1_793_350_000).unwrap_err();
        assert!(early.contains("not valid until 2026-10-30 08:48 UTC"), "{early}");
        assert!(validity(b"-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----\n").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn renewal_command_gets_the_paths_and_reports_failures() {
        let dir = std::env::temp_dir().join(format!("sauron-renew-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("seen.txt");
        let files = Files { root: "/c/root.pem".into(), cert: "/c/cert.pem".into(), key: String::new() };
        let ok = format!("printf '%s|%s|%s' \"$SAURON_SSL_ROOT_CERT\" \"$SAURON_SSL_CERT\" \"$SAURON_SSL_KEY\" > '{}'", out.display());
        run_renewal(&ok, &files).await.unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "/c/root.pem|/c/cert.pem|");
        let err = run_renewal("echo login needed >&2; exit 3", &files).await.unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("failed") && err.contains("login needed"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn renew_now_reports_the_new_expiry() {
        let dir = std::env::temp_dir().join(format!("sauron-renew-now-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (fresh, stale, cert) = (dir.join("fresh.pem"), dir.join("stale.pem"), dir.join("cert.pem"));
        std::fs::write(&fresh, certificate_pem((0x17, "250101000000Z"), (0x18, "29991231235900Z"))).unwrap();
        std::fs::write(&stale, certificate_pem((0x17, "250101000000Z"), (0x17, "250108000000Z"))).unwrap();
        let files = Files { cert: cert.display().to_string(), ..Files::default() };
        let copy = |from: &Path| format!("cp '{}' \"$SAURON_SSL_CERT\"", from.display());
        assert_eq!(renew_now(&copy(&fresh), &files).await.unwrap().as_deref(), Some("2999-12-31 23:59 UTC"));
        let still = renew_now(&copy(&stale), &files).await.unwrap_err();
        assert!(still.contains("still expired"), "{still}");
        assert!(renew_now("  ", &files).await.unwrap_err().contains("renewal command first"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_a_renewal_stops_what_it_started() {
        let pid_file = std::env::temp_dir().join(format!("sauron-renew-pid-{}", uuid::Uuid::new_v4()));
        let command = format!("sleep 60 & echo $! > '{}'; wait", pid_file.display());
        let files = Files::default();
        let cancelled = tokio::time::timeout(Duration::from_millis(500), run_renewal(&command, &files)).await;
        assert!(cancelled.is_err(), "the command should still have been running");
        let pid = std::fs::read_to_string(&pid_file).unwrap();
        let _ = std::fs::remove_file(&pid_file);
        // A killed process whose parent shell is gone stays a zombie until something reaps it (on Linux that can
        // take a while, macOS is quick), so a zombie counts as stopped too.
        let running = || {
            let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", pid.trim()]).output().unwrap();
            let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
            !state.is_empty() && !state.starts_with('Z')
        };
        for _ in 0..20 {
            if !running() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!running(), "the background sleep {} outlived the cancelled renewal", pid.trim());
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
