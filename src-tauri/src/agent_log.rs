//! What AI agents did through the MCP server (`mcp.rs`), for the Agent tab of the app.
//!
//! Every tool call is one file in `<app data>/agent-log/`: `<id>.json` with what was asked and how it went, and
//! `<id>.result.json` with the rows the agent got (kept apart so the list stays cheap to read while it is polled).
//! One file per call means several agents (several `sauron --mcp` processes) can write at the same time, and the app
//! never writes to them except to delete. Ids start with the time, so sorting by name sorts by time.
//! The log follows the query history setting (off / 7 / 30 days / forever) and keeps at most `MAX_ENTRIES` calls.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DIR: &str = "agent-log";
pub const MAX_ENTRIES: usize = 500;
const MAX_SQL_CHARS: usize = 20_000;
/// The text the agent got is stored up to this size (a big result is still kept in full in the result file).
const MAX_OUTPUT_CHARS: usize = 50_000;
const DAY_MS: u64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    /// ms since epoch
    pub at: u64,
    /// The agent, as it introduced itself (`clientInfo.name`), e.g. "claude-code".
    pub client: String,
    pub tool: String,
    pub connection_id: String,
    pub connection_name: String,
    /// What ran on the database: the SQL, or the catalog command for list_tables / describe_table.
    pub sql: String,
    pub ms: u64,
    /// "ok", "error" (the database or the tool failed) or "blocked" (refused before it ran, e.g. a write).
    pub status: String,
    /// The text the agent got back, cut at `MAX_OUTPUT_CHARS` (empty when there is a result file instead).
    pub output: String,
    /// Rows in the result file, `None` when there is no table.
    pub rows: Option<usize>,
    pub truncated: bool,
}

/// The table an agent got, in the shape of the app's `QueryResult`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Table {
    pub columns: Vec<Value>,
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: bool,
    pub message: Option<String>,
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Sortable by time: zero padded ms, then a random part so two processes writing in the same ms do not collide.
/// Within a process the ms part only goes up (a call in the same ms as the last one takes the next ms), so calls
/// made in quick succession keep their order instead of sorting by the random part.
pub fn new_id() -> String {
    static LAST_MS: AtomicU64 = AtomicU64::new(0);
    let now = now_ms();
    let previous = LAST_MS
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |last| Some(now.max(last + 1)))
        .unwrap_or(0);
    format!("{:015}-{}", now.max(previous + 1), &uuid::Uuid::new_v4().simple().to_string()[..8])
}

/// Ids come from the webview: only what `new_id` produces, so they can never point outside the log folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// How long to keep agent calls, from the "Keep query history" setting: `None` = do not log, `Some(None)` = forever.
pub fn retention(data_dir: &Path) -> Option<Option<u64>> {
    let keep = std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|settings| settings.get("historyKeep").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "30".to_string());
    match keep.as_str() {
        "off" => None,
        "forever" => Some(None),
        days => Some(Some(days.parse::<u64>().unwrap_or(30) * DAY_MS)),
    }
}

fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)
}

/// Record one call (the result first, so an entry the app can see always has its rows), then drop old calls.
pub fn record(data_dir: &Path, mut entry: Entry, table: Option<Table>) -> Result<(), String> {
    let Some(max_age) = retention(data_dir) else { return Ok(()) };
    let dir = dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    entry.sql = cut(&entry.sql, MAX_SQL_CHARS);
    entry.output = cut(&entry.output, MAX_OUTPUT_CHARS);
    if let Some(table) = &table {
        entry.rows = Some(table.rows.len());
        entry.truncated = table.truncated;
        let json = serde_json::to_string(table).map_err(|e| e.to_string())?;
        write_atomic(&dir.join(format!("{}.result.json", entry.id)), &json).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(format!("{}.json", entry.id)), &json).map_err(|e| e.to_string())?;

    prune(&dir, max_age, now_ms());
    Ok(())
}

/// Ids of the logged calls, oldest first.
fn ids(dir: &Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else { return vec![] };
    let mut ids: Vec<String> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
        .filter(|stem| !stem.ends_with(".result") && valid_id(stem))
        .collect();
    ids.sort();
    ids
}

fn at_of(id: &str) -> u64 {
    id.split('-').next().and_then(|ms| ms.parse().ok()).unwrap_or(0)
}

fn remove(dir: &Path, id: &str) {
    let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.result.json")));
}

fn prune(dir: &Path, max_age: Option<u64>, now: u64) {
    let ids = ids(dir);
    let extra = ids.len().saturating_sub(MAX_ENTRIES);
    for (index, id) in ids.iter().enumerate() {
        let too_old = max_age.is_some_and(|age| now.saturating_sub(at_of(id)) > age);
        if index < extra || too_old {
            remove(dir, id);
        }
    }
}

/// Every logged call, newest first.
pub fn list(data_dir: &Path) -> Vec<Entry> {
    let dir = dir(data_dir);
    let mut entries: Vec<Entry> = ids(&dir)
        .iter()
        .rev()
        .filter_map(|id| std::fs::read_to_string(dir.join(format!("{id}.json"))).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    entries.truncate(MAX_ENTRIES);
    entries
}

/// Id of the newest call (a directory listing only, for the "new agent calls" badge).
pub fn latest(data_dir: &Path) -> Option<String> {
    ids(&dir(data_dir)).pop()
}

pub fn result(data_dir: &Path, id: &str) -> Result<Option<Table>, String> {
    if !valid_id(id) {
        return Err(format!("Invalid id: {id}"));
    }
    let path = dir(data_dir).join(format!("{id}.result.json"));
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

pub fn clear(data_dir: &Path) -> Result<(), String> {
    let dir = dir(data_dir);
    for id in ids(&dir) {
        remove(&dir, &id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sauron-agent-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(id: &str) -> Entry {
        Entry {
            id: id.to_string(),
            at: at_of(id),
            client: "test".into(),
            tool: "query".into(),
            connection_id: "c1".into(),
            connection_name: "Local".into(),
            sql: "select 1".into(),
            ms: 3,
            status: "ok".into(),
            output: String::new(),
            rows: None,
            truncated: false,
        }
    }

    #[test]
    fn ids_made_in_quick_succession_keep_their_order() {
        let ids: Vec<String> = (0..200).map(|_| new_id()).collect();
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]), "{ids:?}");
    }

    #[test]
    fn records_lists_newest_first_and_reads_results() {
        let data = temp_dir();
        let table = Table { columns: vec![serde_json::json!({ "name": "a", "type": "number" })], rows: vec![vec![Some("1".into())], vec![None]], truncated: true, message: None };
        let (first, second) = (new_id(), new_id());
        record(&data, entry(&first), Some(table.clone())).unwrap();
        record(&data, entry(&second), None).unwrap();

        let entries = list(&data);
        assert_eq!(entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), [second.as_str(), first.as_str()]);
        assert_eq!((entries[1].rows, entries[1].truncated), (Some(2), true));
        assert_eq!(result(&data, &first).unwrap(), Some(table));
        assert_eq!(result(&data, &second).unwrap(), None);
        assert_eq!(latest(&data), Some(second));
        assert!(result(&data, "../settings").is_err());

        clear(&data).unwrap();
        assert!(list(&data).is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn follows_the_history_setting() {
        let data = temp_dir();
        std::fs::write(data.join("settings.json"), r#"{"historyKeep":"off"}"#).unwrap();
        record(&data, entry(&new_id()), None).unwrap();
        assert!(list(&data).is_empty());

        std::fs::write(data.join("settings.json"), r#"{"historyKeep":"7"}"#).unwrap();
        assert_eq!(retention(&data), Some(Some(7 * DAY_MS)));
        let old = format!("{:015}-aaaaaaaa", now_ms() - 8 * DAY_MS);
        record(&data, entry(&old), None).unwrap();
        record(&data, entry(&new_id()), None).unwrap();
        assert_eq!(list(&data).len(), 1, "the 8 day old call is dropped");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn keeps_at_most_max_entries() {
        let dir = temp_dir();
        for n in 0..MAX_ENTRIES + 3 {
            std::fs::write(dir.join(format!("{n:015}-aaaaaaaa.json")), "{}").unwrap();
        }
        prune(&dir, None, now_ms());
        let left = ids(&dir);
        assert_eq!(left.len(), MAX_ENTRIES);
        assert_eq!(left[0], format!("{:015}-aaaaaaaa", 3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_text_is_cut_on_a_char_boundary() {
        assert_eq!(cut("äöü", 2), "äö…");
        assert_eq!(cut("abc", 3), "abc");
    }
}
