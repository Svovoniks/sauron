//! sauron --mcp switching to the updated executable when the app updates itself while an agent keeps the server
//! running (see src/executable.rs and serve in src/mcp.rs).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use serde_json::{json, Value};

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: Receiver<Value>,
}

impl Server {
    fn start(exe: &Path, home: &Path) -> Server {
        let mut child = Command::new(exe)
            .arg("--mcp")
            // where dirs::data_dir looks: HOME on macOS, XDG_DATA_HOME on Linux
            .env("HOME", home)
            .env("XDG_DATA_HOME", home.join("data"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(serde_json::from_str(&line).unwrap_or(Value::Null));
            }
        });
        Server { child, stdin: Some(stdin), responses }
    }

    fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{message}").unwrap();
        stdin.flush().unwrap();
    }

    fn response(&self) -> Value {
        self.responses.recv_timeout(Duration::from_secs(60)).expect("no response from the MCP server within 60 s")
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let response = self.response();
        assert_eq!(response["id"], id, "{response}");
        response
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The agent log entries of the tool calls: (client, tool).
fn logged_calls(home: &Path) -> Vec<(String, String)> {
    let dirs = [home.join("Library/Application Support"), home.join("data")];
    let mut calls = Vec::new();
    let mut pending: Vec<PathBuf> = dirs.into_iter().collect();
    while let Some(path) = pending.pop() {
        if path.is_dir() {
            pending.extend(std::fs::read_dir(&path).unwrap().flatten().map(|entry| entry.path()));
        } else if let Ok(text) = std::fs::read_to_string(&path) {
            for value in text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
                if let (Some(client), Some(tool)) = (value["client"].as_str(), value["tool"].as_str()) {
                    calls.push((client.to_string(), tool.to_string()));
                }
            }
        }
    }
    calls
}

#[test]
fn the_server_switches_to_the_updated_executable_and_carries_on() {
    let dir = std::env::temp_dir().join(format!("sauron-mcp-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (app, backup, home) = (dir.join("app"), dir.join("backup"), dir.join("home"));
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let exe = app.join("sauron");
    std::fs::copy(env!("CARGO_BIN_EXE_sauron"), &exe).unwrap();

    let mut server = Server::start(&exe, &home);
    let init = server.call(1, "initialize", json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "update-test" } }));
    assert_eq!(init["result"]["serverInfo"]["name"], "sauron", "{init}");
    let before = server.call(2, "tools/call", json!({ "name": "list_connections" }));
    assert_eq!(before["result"]["isError"], false, "{before}");

    // what the updater does on macOS: the running app goes to a backup folder that is then deleted, and the new
    // one takes its place
    std::fs::rename(&app, &backup).unwrap();
    std::fs::create_dir_all(&app).unwrap();
    std::fs::copy(backup.join("sauron"), &exe).unwrap();
    std::fs::remove_dir_all(&backup).unwrap();

    // The call that notices the update is handed to the new program, which answers it, and the ones after it.
    let pid = server.child.id();
    let after = server.call(3, "tools/call", json!({ "name": "list_connections" }));
    assert_eq!(after["result"]["isError"], false, "{after}");
    assert_eq!(server.call(4, "ping", json!({}))["result"], json!({}));
    assert_eq!(server.child.id(), pid);

    // stdin closed: the server finishes and exits
    drop(server.stdin.take());
    let status = server.child.wait().unwrap();
    let mut stderr = String::new();
    std::io::Read::read_to_string(server.child.stderr.as_mut().unwrap(), &mut stderr).unwrap();
    let calls = logged_calls(&home);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(status.success(), "{status}: {stderr}");
    assert!(stderr.contains("switched to the updated executable"), "{stderr}");
    // the new program still knows which agent it is talking to
    let tool = "list_connections".to_string();
    assert_eq!(calls, [("update-test".to_string(), tool.clone()), ("update-test".to_string(), tool)]);
}
