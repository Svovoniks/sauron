//! Backslash commands are handed to the real `psql` binary, unfiltered - exactly what you type is
//! what psql runs, including `\!`, `\i`, `\o`, `\copy` (so a pasted `\! cmd` runs on this machine).
//! That is a deliberate choice: see the README. When `psql` is not installed the built-in
//! implementation in `meta.rs` is used instead (it only knows the read-only catalog commands).

use std::io::ErrorKind;
use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::cancel::Guard;
use crate::model::{ConnectionParams, SslMode};

pub enum PsqlError {
    /// No usable `psql` binary was found; the caller may fall back to the built-in commands.
    NotInstalled(String),
    /// psql ran and reported an error (or could not be run).
    Failed(String),
}

fn psql_candidates() -> Vec<String> {
    let mut candidates = vec!["psql".to_string()];

    #[cfg(target_os = "macos")]
    {
        candidates.push("/opt/homebrew/bin/psql".to_string());
        candidates.push("/usr/local/bin/psql".to_string());
        candidates.push("/Applications/Postgres.app/Contents/Versions/latest/bin/psql".to_string());
        // Homebrew's libpq / versioned formulae are keg-only: not linked into bin/.
        for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
            candidates.push(format!("{prefix}/libpq/bin/psql"));
            if let Ok(entries) = std::fs::read_dir(prefix) {
                let mut versioned: Vec<_> = entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("postgresql@"))
                    .map(|e| e.path().join("bin/psql"))
                    .filter(|p| p.exists())
                    .collect();
                versioned.sort();
                versioned.reverse(); // newest first
                candidates.extend(versioned.into_iter().map(|p| p.display().to_string()));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push("psql.exe".to_string());
    }

    // Skip absolute paths that do not exist.
    candidates.retain(|c| !c.starts_with('/') || Path::new(c).exists());
    candidates
}

async fn run_with_binary(
    psql_path: &str,
    conn: &ConnectionParams,
    password: &str,
    command_text: &str,
) -> Result<String, PsqlError> {
    let host = conn.host_trimmed().map_err(PsqlError::Failed)?;
    let mut command = Command::new(psql_path);
    command
        .arg("-X")
        .arg("-w")
        .arg("-P")
        .arg("pager=off")
        .arg("-h")
        .arg(host)
        .arg("-p")
        .arg(conn.port.trim())
        .arg("-U")
        .arg(conn.username.trim())
        .arg("-d")
        .arg(conn.database.trim())
        .env("PGPASSWORD", password)
        .env("PGCONNECT_TIMEOUT", "10")
        .env(
            "PGSSLMODE",
            match conn.ssl_mode {
                SslMode::Disable => "disable",
                SslMode::Prefer => "prefer",
                SslMode::Require => "require",
                SslMode::Verify => "verify-full",
            },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // The connection's own settings still apply (a script can switch them off again).
    let mut options = Vec::new();
    if conn.read_only {
        options.push("-c default_transaction_read_only=on".to_string());
    }
    if conn.timeout_secs > 0 {
        options.push(format!("-c statement_timeout={}", conn.timeout_secs.saturating_mul(1000)));
    }
    if !options.is_empty() {
        command.env("PGOPTIONS", options.join(" "));
    }

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            PsqlError::NotInstalled(format!("psql binary not found at {psql_path}"))
        } else {
            PsqlError::Failed(format!("Failed to start psql: {error}"))
        }
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(command_text.as_bytes())
            .await
            .map_err(|error| PsqlError::Failed(format!("Failed to write command to psql: {error}")))?;
        if !command_text.ends_with('\n') {
            stdin
                .write_all(b"\n")
                .await
                .map_err(|error| PsqlError::Failed(format!("Failed to finish command for psql: {error}")))?;
        }
    }

    // `kill_on_drop`: when the surrounding guard cancels, this future is dropped and psql dies.
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| PsqlError::Failed(format!("Failed to run psql: {error}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined_output = format!("{stdout}{stderr}");

    if output.status.success() {
        return Ok(combined_output);
    }

    let trimmed_output = combined_output.trim();
    Err(PsqlError::Failed(if trimmed_output.is_empty() {
        format!("psql exited with status {}", output.status)
    } else {
        trimmed_output.to_string()
    }))
}

pub async fn execute(
    conn: &ConnectionParams,
    password: &str,
    command_text: &str,
    guard: &Guard<'_>,
) -> Result<String, PsqlError> {
    let outcome = guard
        .run(async {
            let mut tried = Vec::new();
            for candidate in psql_candidates() {
                match run_with_binary(&candidate, conn, password, command_text).await {
                    Err(PsqlError::NotInstalled(message)) => tried.push(message),
                    other => return Ok(other),
                }
            }
            Ok(Err(PsqlError::NotInstalled(format!("Could not find psql. Tried: {}", tried.join(", ")))))
        })
        .await;

    match outcome {
        Ok(result) => result,
        // cancelled by the user
        Err(message) => Err(PsqlError::Failed(message)),
    }
}

/// Needs a real server and a `psql` binary: skipped unless `SAURON_TEST_PG_PORT` is set.
#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::cancel::Registry;

    fn conn(read_only: bool) -> Option<ConnectionParams> {
        let port = std::env::var("SAURON_TEST_PG_PORT").ok()?;
        Some(
            serde_json::from_value(serde_json::json!({
                "id": "test", "host": "127.0.0.1", "port": port,
                "username": std::env::var("SAURON_TEST_PG_USER").unwrap_or_else(|_| "postgres".into()),
                "database": "postgres", "db_type": "postgres", "ssl_mode": "disable",
                "read_only": read_only, "timeout_secs": 0,
            }))
            .unwrap(),
        )
    }

    async fn run(c: &ConnectionParams, text: &str) -> Result<String, String> {
        let registry = Registry::default();
        let guard = registry.begin();
        match execute(c, "", text, &guard).await {
            Ok(out) => Ok(out),
            Err(PsqlError::Failed(m)) | Err(PsqlError::NotInstalled(m)) => Err(m),
        }
    }

    #[tokio::test]
    async fn text_is_passed_to_psql_unfiltered() {
        let Some(c) = conn(true) else { return };
        let out = run(&c, "\\conninfo").await.unwrap();
        assert!(out.contains("postgres"), "{out}");

        // multi-line input: every line is executed, including SQL
        let out = run(&c, "\\dn\nselect 40 + 2 as answer;").await.unwrap();
        assert!(out.contains("List of schemas") && out.contains("answer") && out.contains("42"), "{out}");

        // the accepted risk: shell escapes run on this machine
        let out = run(&c, "\\! echo from-the-shell").await.unwrap();
        assert!(out.contains("from-the-shell"), "{out}");

        // the connection's read-only setting still applies to SQL sent through psql
        // (psql itself reports SQL errors on stderr and exits normally, so they appear in the output)
        let out = run(&c, "create temp table nope(a int);").await.unwrap();
        assert!(out.contains("read-only transaction"), "{out}");
    }
}
