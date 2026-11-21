//! Kafka connections: read the messages of a topic, send one, describe a topic, list the topics.
//!
//! There is no SQL for Kafka. A query tab on a Kafka connection holds a form, and the form travels as JSON, the
//! same text the tab, the history and saved queries keep: {"kafka":1,"mode":"read","topic":"orders",...}. It is
//! run through execute_script like a one-statement script, so cancel, history and the result grid work unchanged.
//!
//! Reading never joins a consumer group and never commits offsets: every partition is fetched directly, so a real
//! consumer of the topic is never affected. Sending is refused on read-only connections.
//!
//! Kafka has no index: partition, offset and time decide where reading starts, and every other filter is checked
//! on each message while reading. A scan stops at the limit, at the connection timeout or after MAX_SCANNED
//! messages, and the result says how far it got.

use std::collections::{BTreeMap, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, TimeZone, Utc};
use rskafka::client::error::Error as KafkaError;
use rskafka::client::partition::{Compression, OffsetAt, PartitionClient, UnknownTopicHandling};
use rskafka::client::{Client, ClientBuilder, Credentials, SaslConfig};
use rskafka::record::{Record, RecordAndOffset};
use rskafka::BackoffConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;

use crate::cancel::Guard;
use crate::model::{ColumnMeta, ConnectionParams, QueryResult, SaslMechanism, StatementError, StatementOutcome};

/// A scan stops after this many messages, so a filter on a huge topic always ends.
pub const MAX_SCANNED: u64 = 5_000_000;
/// Giving up on an unreachable cluster: connecting, logging in and the first metadata request.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A connected client is reused for this long, so the next read does not log in again.
const CLIENT_TTL: Duration = Duration::from_secs(300);
/// Bytes asked for in one fetch request.
const FETCH_BYTES: i32 = 4 * 1024 * 1024;
/// Partitions read at the same time.
const PARALLEL_PARTITIONS: usize = 16;
/// Messages read per step when reading backwards: a filter that matches rarely makes the steps grow.
const FIRST_WINDOW: i64 = 500;
const MAX_WINDOW: i64 = 50_000;

// --- the form --------------------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Read,
    Send,
    /// Partitions of the topic with their first and last offsets.
    Describe,
    /// Every topic with its partition count (the schema panel).
    Topics,
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Start {
    /// From the end backwards: the latest messages first.
    #[default]
    Newest,
    /// From the start of retention forwards.
    Oldest,
    /// A time window, newest first.
    Time,
    /// One partition from an exact offset forwards.
    Offset,
    /// Every partition from the first message at or after since_ms forwards, like the Timestamp start offset of
    /// Redpanda Console.
    Timestamp,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Ne,
    Contains,
    NotContains,
    Exists,
    Gt,
    Lt,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Filter {
    /// key, value, value.some.path (a JSON field; numbers index arrays) or header.name
    pub field: String,
    pub op: Op,
    #[serde(default)]
    pub value: String,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadForm {
    pub from: Start,
    /// Empty: every partition.
    pub partitions: Vec<i32>,
    /// Time window: "15m", "1h", "6h", "24h", "7d" back from now, or "custom" for since_ms / until_ms.
    pub range: String,
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
    pub offset_partition: i32,
    pub offset: i64,
    pub filters: Vec<Filter>,
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Partitioner {
    /// sarama's default: FNV-1a of the key.
    #[default]
    Fnv,
    /// The Java client's default (also franz-go): murmur2 of the key.
    Murmur2,
    /// The partition field.
    Manual,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct Header {
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct SendForm {
    pub partitioner: Partitioner,
    pub partition: i32,
    pub key: String,
    pub value: String,
    pub headers: Vec<Header>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Form {
    pub mode: Mode,
    pub topic: String,
    pub read: ReadForm,
    pub send: SendForm,
}

impl Form {
    pub fn parse(text: &str) -> Result<Form, String> {
        let value: Value = serde_json::from_str(text.trim()).map_err(|_| NOT_A_FORM.to_string())?;
        if value.get("kafka").is_none() {
            return Err(NOT_A_FORM.to_string());
        }
        serde_json::from_value(value).map_err(|e| format!("The Kafka form is not valid: {e}"))
    }

    fn topic(&self) -> Result<&str, String> {
        let topic = self.topic.trim();
        if topic.is_empty() {
            Err("Pick a topic first.".to_string())
        } else {
            Ok(topic)
        }
    }
}

pub const READ_ONLY: &str = "This connection is read-only. Turn off read-only in the connection to send messages.";
const NOT_A_FORM: &str = "Kafka connections are read with the Read messages form, not with SQL.";

// --- entry point -----------------------------------------------------------------------------------

/// Runs each form (one per "statement") and reports it like a SQL statement. row_limit caps the messages returned.
pub async fn execute_script(
    conn: &ConnectionParams,
    password: &str,
    statements: &[String],
    row_limit: usize,
    guard: &Guard<'_>,
) -> Result<Vec<StatementOutcome>, String> {
    let mut outcomes = Vec::with_capacity(statements.len());
    for text in statements {
        let started = Instant::now();
        let result = guard.run(execute(conn, password, text, row_limit)).await;
        // A cancelled run fails as a whole, like the SQL connections.
        if let Err(message) = &result {
            if message == crate::model::CANCELLED {
                return Err(message.clone());
            }
        }
        let failed = result.is_err();
        let (result, error) = match result {
            Ok(result) => (Some(result), None),
            Err(message) => (None, Some(StatementError::from(message))),
        };
        outcomes.push(StatementOutcome {
            sql: text.clone(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            result,
            error,
        });
        if failed {
            break;
        }
    }
    Ok(outcomes)
}

/// Runs one form.
pub async fn execute(conn: &ConnectionParams, password: &str, text: &str, row_limit: usize) -> Result<QueryResult, String> {
    let form = Form::parse(text)?;
    if form.mode == Mode::Send && conn.read_only {
        return Err(READ_ONLY.to_string());
    }
    let deadline = (conn.timeout_secs > 0).then(|| Instant::now() + Duration::from_secs(conn.timeout_secs));
    let client = connect(conn, password).await?;
    let outcome = match form.mode {
        Mode::Topics => list_topics(&client).await,
        Mode::Describe => describe(&client, form.topic()?).await,
        Mode::Read => read(&client, &form, row_limit.max(1), deadline).await,
        Mode::Send => send(&client, &form).await,
    };
    // The next run connects again: a broken client must not be reused for five minutes.
    if outcome.is_err() {
        forget(conn, password).await;
    }
    outcome
}

// --- connecting -----------------------------------------------------------------------------------

struct Cached {
    client: Arc<Client>,
    at: Instant,
}

fn clients() -> &'static Mutex<HashMap<u64, Cached>> {
    static CLIENTS: OnceLock<Mutex<HashMap<u64, Cached>>> = OnceLock::new();
    CLIENTS.get_or_init(Default::default)
}

/// Everything that decides how the client connects; the password only as part of a hash.
fn client_key(conn: &ConnectionParams, password: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    (conn.host.trim(), conn.port.trim(), conn.username.trim(), conn.sasl_mechanism.label(), password).hash(&mut hasher);
    hasher.finish()
}

async fn forget(conn: &ConnectionParams, password: &str) {
    clients().lock().await.remove(&client_key(conn, password));
}

/// A connected client for the connection, reused for a few minutes.
pub async fn connect(conn: &ConnectionParams, password: &str) -> Result<Arc<Client>, String> {
    let key = client_key(conn, password);
    {
        let cache = clients().lock().await;
        if let Some(cached) = cache.get(&key).filter(|c| c.at.elapsed() < CLIENT_TTL) {
            return Ok(cached.client.clone());
        }
    }
    let client = Arc::new(build_client(conn, password).await?);
    let mut cache = clients().lock().await;
    cache.retain(|_, c| c.at.elapsed() < CLIENT_TTL);
    cache.insert(key, Cached { client: client.clone(), at: Instant::now() });
    Ok(client)
}

async fn build_client(conn: &ConnectionParams, password: &str) -> Result<Client, String> {
    let brokers = conn.kafka_brokers()?;
    let mut builder = ClientBuilder::new(brokers.clone()).client_id("sauron").backoff_config(BackoffConfig {
        init_backoff: Duration::from_millis(100),
        max_backoff: Duration::from_secs(1),
        base: 2.0,
        // Without a deadline the client retries an unreachable broker forever.
        deadline: Some(Duration::from_secs(10)),
    });
    let user = conn.username.trim();
    if !user.is_empty() {
        let credentials = Credentials::new(user.to_string(), password.to_string());
        builder = builder.sasl_config(match conn.sasl_mechanism {
            SaslMechanism::Plain => SaslConfig::Plain(credentials),
            SaslMechanism::ScramSha256 => SaslConfig::ScramSha256(credentials),
            SaslMechanism::ScramSha512 => SaslConfig::ScramSha512(credentials),
        });
    }
    match tokio::time::timeout(CONNECT_TIMEOUT, builder.build()).await {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(e)) => Err(format!("Could not connect to Kafka ({}): {}", brokers.join(", "), error_text(&e))),
        Err(_) => Err(format!(
            "Could not connect to Kafka ({}): timed out after {} s",
            brokers.join(", "),
            CONNECT_TIMEOUT.as_secs()
        )),
    }
}

/// The client's errors carry the whole request and response; the protocol error and the broker's message are enough.
fn error_text(error: &KafkaError) -> String {
    match error {
        KafkaError::ServerError { protocol_error, error_message, .. } => match error_message {
            Some(message) if !message.is_empty() => format!("{protocol_error}: {message}"),
            _ => protocol_error.to_string(),
        },
        other => other.to_string(),
    }
}

async fn topic_partitions(client: &Client, topic: &str) -> Result<Vec<i32>, String> {
    let topics = client.list_topics().await.map_err(|e| format!("Could not list the topics: {}", error_text(&e)))?;
    match topics.into_iter().find(|t| t.name == topic) {
        Some(found) => Ok(found.partitions.into_iter().collect()),
        None => Err(format!("Topic \"{topic}\" does not exist.")),
    }
}

async fn partition_client(client: &Client, topic: &str, partition: i32) -> Result<PartitionClient, String> {
    client
        .partition_client(topic, partition, UnknownTopicHandling::Error)
        .await
        .map_err(|e| format!("Partition {partition}: {}", error_text(&e)))
}

/// First and next offset of a partition (the next one is where a new message would go).
async fn watermarks(pc: &PartitionClient) -> Result<(i64, i64), String> {
    let low = pc.get_offset(OffsetAt::Earliest).await.map_err(|e| format!("Partition {}: {}", pc.partition(), error_text(&e)))?;
    let high = pc.get_offset(OffsetAt::Latest).await.map_err(|e| format!("Partition {}: {}", pc.partition(), error_text(&e)))?;
    Ok((low, high))
}

// --- topics and describe --------------------------------------------------------------------------

fn column(name: &str, ui_type: &str) -> ColumnMeta {
    ColumnMeta {
        name: name.to_string(),
        ui_type: ui_type.to_string(),
    }
}

async fn list_topics(client: &Client) -> Result<QueryResult, String> {
    let mut topics = client.list_topics().await.map_err(|e| format!("Could not list the topics: {}", error_text(&e)))?;
    topics.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(QueryResult {
        columns: vec![column("topic", "string"), column("partitions", "number")],
        rows: topics
            .into_iter()
            .map(|t| vec![Some(t.name), Some(t.partitions.len().to_string())])
            .collect(),
        truncated: false,
        message: None,
    })
}

async fn describe(client: &Arc<Client>, topic: &str) -> Result<QueryResult, String> {
    let partitions = topic_partitions(client, topic).await?;
    let mut tasks = JoinSet::new();
    let limit = Arc::new(Semaphore::new(PARALLEL_PARTITIONS));
    for partition in partitions {
        let (client, limit, topic) = (client.clone(), limit.clone(), topic.to_string());
        tasks.spawn(async move {
            let _permit = limit.acquire().await;
            let pc = partition_client(&client, &topic, partition).await?;
            let (low, high) = watermarks(&pc).await?;
            Ok::<_, String>((partition, low, high))
        });
    }
    let mut rows = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        rows.push(joined.map_err(|e| e.to_string())??);
    }
    rows.sort();
    let total: i64 = rows.iter().map(|(_, low, high)| high - low).sum();
    Ok(QueryResult {
        columns: vec![
            column("partition", "number"),
            column("first_offset", "number"),
            column("next_offset", "number"),
            column("messages", "number"),
        ],
        rows: rows
            .into_iter()
            .map(|(p, low, high)| vec![Some(p.to_string()), Some(low.to_string()), Some(high.to_string()), Some((high - low).to_string())])
            .collect(),
        truncated: false,
        message: Some(format!("{topic}: {} messages kept", group_digits(total))),
    })
}

// --- reading --------------------------------------------------------------------------------------

/// One message as shown in the grid.
struct Message {
    partition: i32,
    offset: i64,
    timestamp: DateTime<Utc>,
    key: Option<String>,
    value: Option<String>,
    headers: Option<String>,
}

/// What one partition read.
struct PartitionScan {
    matches: Vec<Message>,
    /// It stopped at the limit with messages left to read.
    more: bool,
}

/// Shared by every partition of one read.
struct Budget {
    scanned: AtomicU64,
    /// The time or message budget ran out.
    exhausted: AtomicBool,
    deadline: Option<Instant>,
}

impl Budget {
    fn spend(&self, messages: u64) -> bool {
        let total = self.scanned.fetch_add(messages, Ordering::Relaxed) + messages;
        if total >= MAX_SCANNED || self.deadline.is_some_and(|d| Instant::now() >= d) {
            self.exhausted.store(true, Ordering::Relaxed);
        }
        !self.exhausted.load(Ordering::Relaxed)
    }

    fn left(&self) -> bool {
        if self.deadline.is_some_and(|d| Instant::now() >= d) {
            self.exhausted.store(true, Ordering::Relaxed);
        }
        !self.exhausted.load(Ordering::Relaxed)
    }
}

/// Where to read in one partition and in which direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
    from: i64,
    to: i64,
    backwards: bool,
}

/// The time window of a read, in epoch ms; either end may be open.
fn window(read: &ReadForm, now_ms: i64) -> Result<(Option<i64>, Option<i64>), String> {
    let back = |ms: i64| Ok((Some(now_ms - ms), None));
    match read.range.as_str() {
        "15m" => back(15 * 60_000),
        "1h" => back(3_600_000),
        "6h" => back(6 * 3_600_000),
        "24h" | "" => back(24 * 3_600_000),
        "7d" => back(7 * 24 * 3_600_000),
        "custom" => {
            if read.since_ms.is_none() && read.until_ms.is_none() {
                return Err("Set the start or the end of the time range.".to_string());
            }
            if let (Some(since), Some(until)) = (read.since_ms, read.until_ms) {
                if since >= until {
                    return Err("The time range ends before it starts.".to_string());
                }
            }
            Ok((read.since_ms, read.until_ms))
        }
        other => Err(format!("Unknown time range \"{other}\".")),
    }
}

async fn read(client: &Arc<Client>, form: &Form, limit: usize, deadline: Option<Instant>) -> Result<QueryResult, String> {
    let topic = form.topic()?.to_string();
    let read = &form.read;
    let all = topic_partitions(client, &topic).await?;
    let partitions: Vec<i32> = match read.from {
        Start::Offset => {
            if !all.contains(&read.offset_partition) {
                return Err(format!("{topic} has no partition {} (it has {}).", read.offset_partition, all.len()));
            }
            vec![read.offset_partition]
        }
        _ if read.partitions.is_empty() => all.clone(),
        _ => {
            if let Some(missing) = read.partitions.iter().find(|p| !all.contains(p)) {
                return Err(format!("{topic} has no partition {missing} (it has {}).", all.len()));
            }
            read.partitions.clone()
        }
    };
    let time = match read.from {
        Start::Time => window(read, Utc::now().timestamp_millis())?,
        _ => (None, None),
    };
    // Where Timestamp seeks to. Messages after that point are all kept, even one with an older timestamp.
    let seek = match read.from {
        Start::Timestamp => Some(read.since_ms.ok_or("Set the time to start reading from.")?),
        _ => None,
    };
    let filters = Arc::new(read.filters.iter().map(Compiled::new).collect::<Result<Vec<_>, _>>()?);
    let budget = Arc::new(Budget {
        scanned: AtomicU64::new(0),
        exhausted: AtomicBool::new(false),
        deadline,
    });

    let mut tasks = JoinSet::new();
    let gate = Arc::new(Semaphore::new(PARALLEL_PARTITIONS));
    for &partition in &partitions {
        let (client, gate, topic, filters, budget) = (client.clone(), gate.clone(), topic.clone(), filters.clone(), budget.clone());
        let (from, offset) = (read.from, read.offset);
        tasks.spawn(async move {
            let _permit = gate.acquire().await;
            let pc = partition_client(&client, &topic, partition).await?;
            let (low, high) = watermarks(&pc).await?;
            let span = match from {
                Start::Newest => Span { from: low, to: high, backwards: true },
                Start::Oldest => Span { from: low, to: high, backwards: false },
                Start::Offset => Span { from: offset.clamp(low, high), to: high, backwards: false },
                Start::Timestamp => {
                    let start = offset_for_time(&pc, seek.unwrap_or_default(), high).await?;
                    Span { from: start.max(low), to: high, backwards: false }
                }
                Start::Time => {
                    let start = match time.0 {
                        Some(ms) => offset_for_time(&pc, ms, high).await?,
                        None => low,
                    };
                    let end = match time.1 {
                        Some(ms) => offset_for_time(&pc, ms, high).await?,
                        None => high,
                    };
                    Span { from: start.max(low), to: end.min(high), backwards: true }
                }
            };
            scan(&pc, span, time, &filters, limit, &budget).await
        });
    }
    let mut messages = Vec::new();
    let mut more = false;
    while let Some(joined) = tasks.join_next().await {
        let scan = joined.map_err(|e| e.to_string())??;
        more |= scan.more;
        messages.extend(scan.matches);
    }

    let backwards = matches!(read.from, Start::Newest | Start::Time);
    sort_messages(&mut messages, backwards);
    let matched = messages.len();
    more |= matched > limit;
    messages.truncate(limit);

    let scanned = budget.scanned.load(Ordering::Relaxed);
    let exhausted = budget.exhausted.load(Ordering::Relaxed);
    Ok(QueryResult {
        columns: vec![
            column("partition", "number"),
            column("offset", "number"),
            column("timestamp", "timestamp tz"),
            column("key", "string"),
            column("value", "json"),
            column("headers", "json"),
        ],
        rows: messages.into_iter().map(row).collect(),
        truncated: more,
        message: Some(scan_summary(scanned, partitions.len(), matched.min(limit), exhausted, deadline.is_some_and(|d| Instant::now() >= d))),
    })
}

/// The first offset at or after a time, or high when every message is older.
async fn offset_for_time(pc: &PartitionClient, ms: i64, high: i64) -> Result<i64, String> {
    let at = Utc.timestamp_millis_opt(ms).single().ok_or("Invalid time")?;
    let offset = pc
        .get_offset(OffsetAt::Timestamp(at))
        .await
        .map_err(|e| format!("Partition {}: {}", pc.partition(), error_text(&e)))?;
    Ok(if offset < 0 { high } else { offset })
}

/// Reads span of one partition and keeps the messages that pass the filters, up to limit.
async fn scan(
    pc: &PartitionClient,
    span: Span,
    time: (Option<i64>, Option<i64>),
    filters: &[Compiled],
    limit: usize,
    budget: &Budget,
) -> Result<PartitionScan, String> {
    let mut matches = Vec::new();
    let in_time = |m: &RecordAndOffset| {
        let ms = m.record.timestamp.timestamp_millis();
        time.0.is_none_or(|since| ms >= since) && time.1.is_none_or(|until| ms < until)
    };
    let keep = |records: Vec<RecordAndOffset>, matches: &mut Vec<Message>| -> bool {
        for record in records {
            if in_time(&record) {
                let message = message(pc.partition(), record);
                if filters.iter().all(|f| f.matches(&message)) {
                    matches.push(message);
                    if matches.len() >= limit {
                        return true;
                    }
                }
            }
        }
        false
    };

    if !span.backwards {
        let mut next = span.from;
        while next < span.to && budget.left() {
            let records = fetch(pc, next, span.to).await?;
            next = records.last().map_or(next + 1, |r| r.offset + 1);
            budget.spend(records.len() as u64);
            if keep(records, &mut matches) {
                return Ok(PartitionScan { matches, more: next < span.to });
            }
        }
        return Ok(PartitionScan { matches, more: false });
    }

    // Backwards: read a window before end forwards, then look at it newest first. Without filters exactly the
    // missing messages are read; with filters the window grows while nothing matches.
    let mut end = span.to;
    let mut size = if filters.is_empty() { limit as i64 } else { FIRST_WINDOW };
    while end > span.from && budget.left() {
        let start = (end - size).max(span.from);
        let mut window = Vec::new();
        let mut next = start;
        while next < end && budget.left() {
            let records = fetch(pc, next, end).await?;
            next = records.last().map_or(next + 1, |r| r.offset + 1);
            budget.spend(records.len() as u64);
            window.extend(records);
        }
        window.reverse();
        if keep(window, &mut matches) {
            return Ok(PartitionScan { matches, more: start > span.from });
        }
        end = start;
        size = if filters.is_empty() { (limit - matches.len()) as i64 } else { (size * 2).min(MAX_WINDOW) };
    }
    Ok(PartitionScan { matches, more: false })
}

/// The messages from offset on, without any at or after end.
async fn fetch(pc: &PartitionClient, offset: i64, end: i64) -> Result<Vec<RecordAndOffset>, String> {
    let fetched = tokio::time::timeout(Duration::from_secs(30), pc.fetch_records(offset, 1..FETCH_BYTES, 100)).await;
    let (mut records, _high) = match fetched {
        Ok(Ok(fetched)) => fetched,
        Ok(Err(e)) => return Err(format!("Partition {} at offset {offset}: {}", pc.partition(), error_text(&e))),
        Err(_) => return Err(format!("Partition {} at offset {offset}: no answer within 30 s", pc.partition())),
    };
    records.retain(|r| r.offset < end);
    Ok(records)
}

fn message(partition: i32, record: RecordAndOffset) -> Message {
    let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    let headers = (!record.record.headers.is_empty()).then(|| {
        let map: serde_json::Map<String, Value> = record
            .record
            .headers
            .into_iter()
            .map(|(name, value)| (name, Value::String(text(value))))
            .collect();
        Value::Object(map).to_string()
    });
    Message {
        partition,
        offset: record.offset,
        timestamp: record.record.timestamp,
        key: record.record.key.map(text),
        value: record.record.value.map(text),
        headers,
    }
}

fn row(m: Message) -> Vec<Option<String>> {
    vec![
        Some(m.partition.to_string()),
        Some(m.offset.to_string()),
        Some(format_time(m.timestamp)),
        m.key,
        m.value,
        m.headers,
    ]
}

/// Local time with the zone, the way the grid shows a Postgres timestamptz.
fn format_time(at: DateTime<Utc>) -> String {
    at.with_timezone(&Local).format("%Y-%m-%d %H:%M:%S%.3f%:z").to_string()
}

fn sort_messages(messages: &mut [Message], newest_first: bool) {
    messages.sort_by(|a, b| {
        let order = a.timestamp.cmp(&b.timestamp).then(a.partition.cmp(&b.partition)).then(a.offset.cmp(&b.offset));
        if newest_first {
            order.reverse()
        } else {
            order
        }
    });
}

fn scan_summary(scanned: u64, partitions: usize, matched: usize, exhausted: bool, timed_out: bool) -> String {
    let read = format!(
        "{} message{} in {partitions} partition{}",
        group_digits(scanned as i64),
        if scanned == 1 { "" } else { "s" },
        if partitions == 1 { "" } else { "s" }
    );
    if exhausted {
        let why = if timed_out { "at the connection timeout".to_string() } else { format!("after {} messages", group_digits(MAX_SCANNED as i64)) };
        format!("Stopped {why}: read {read}, {matched} matched. Narrow the time range or the partitions to search further.")
    } else {
        format!("Read {read}, {matched} matched")
    }
}

fn group_digits(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        out.insert(0, '-');
    }
    out
}

// --- filters --------------------------------------------------------------------------------------

enum Field {
    Key,
    Value,
    Json(Vec<String>),
    Header(String),
}

struct Compiled {
    field: Field,
    op: Op,
    value: String,
    lower: String,
    number: Option<f64>,
}

impl Compiled {
    fn new(filter: &Filter) -> Result<Compiled, String> {
        let name = filter.field.trim();
        let field = match name {
            "key" => Field::Key,
            "value" => Field::Value,
            _ if name.starts_with("value.") && name.len() > 6 => Field::Json(name[6..].split('.').map(str::to_string).collect()),
            _ if name.starts_with("header.") && name.len() > 7 => Field::Header(name[7..].to_string()),
            _ => return Err(format!("Unknown filter field \"{name}\": use key, value, value.<json path> or header.<name>.")),
        };
        Ok(Compiled {
            field,
            op: filter.op,
            value: filter.value.clone(),
            lower: filter.value.to_lowercase(),
            number: filter.value.trim().parse::<f64>().ok(),
        })
    }

    /// The field's text in a message, or None when the message does not have it.
    fn actual(&self, m: &Message) -> Option<(String, Option<f64>)> {
        match &self.field {
            Field::Key => m.key.clone().map(|k| (k, None)),
            Field::Value => m.value.clone().map(|v| (v, None)),
            Field::Header(name) => {
                let headers: Value = serde_json::from_str(m.headers.as_deref()?).ok()?;
                headers.get(name).and_then(Value::as_str).map(|v| (v.to_string(), None))
            }
            Field::Json(path) => {
                let value: Value = serde_json::from_str(m.value.as_deref()?).ok()?;
                let mut at = &value;
                for segment in path {
                    at = match at {
                        Value::Object(map) => map.get(segment)?,
                        Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
                        _ => return None,
                    };
                }
                Some(match at {
                    Value::String(s) => (s.clone(), None),
                    Value::Number(n) => (n.to_string(), n.as_f64()),
                    other => (other.to_string(), None),
                })
            }
        }
    }

    fn matches(&self, m: &Message) -> bool {
        let actual = self.actual(m);
        let number = |text: &str, parsed: Option<f64>| parsed.or_else(|| text.trim().parse::<f64>().ok());
        match (self.op, actual) {
            (Op::Exists, actual) => actual.is_some(),
            (Op::Ne, None) | (Op::NotContains, None) => true,
            (_, None) => false,
            (Op::Eq | Op::Ne, Some((text, parsed))) => {
                let equal = text == self.value || matches!((number(&text, parsed), self.number), (Some(a), Some(b)) if a == b);
                equal == (self.op == Op::Eq)
            }
            (Op::Contains, Some((text, _))) => text.to_lowercase().contains(&self.lower),
            (Op::NotContains, Some((text, _))) => !text.to_lowercase().contains(&self.lower),
            (Op::Gt | Op::Lt, Some((text, parsed))) => {
                let order = match (number(&text, parsed), self.number) {
                    (Some(a), Some(b)) => a.partial_cmp(&b),
                    _ => Some(text.as_str().cmp(self.value.as_str())),
                };
                order == Some(if self.op == Op::Gt { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less })
            }
        }
    }
}

// --- sending --------------------------------------------------------------------------------------

/// sarama's HashPartitioner (its default): FNV-1a of the key as an int32, modulo, sign dropped.
pub fn fnv_partition(key: &[u8], partitions: i32) -> i32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in key {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    ((hash as i32) % partitions).abs()
}

/// The Java client's murmur2, as Kafka's Utils.murmur2 computes it.
pub fn murmur2(data: &[u8]) -> i32 {
    const M: u32 = 0x5bd1_e995;
    let mut h: u32 = 0x9747_b28c ^ data.len() as u32;
    let (chunks, rest) = data.as_chunks::<4>();
    for chunk in chunks {
        let mut k = u32::from_le_bytes(*chunk);
        k = k.wrapping_mul(M);
        k ^= k >> 24;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
    }
    if rest.len() >= 3 {
        h ^= u32::from(rest[2]) << 16;
    }
    if rest.len() >= 2 {
        h ^= u32::from(rest[1]) << 8;
    }
    if !rest.is_empty() {
        h ^= u32::from(rest[0]);
        h = h.wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h as i32
}

/// The Java client's default partitioner for a keyed message.
pub fn murmur2_partition(key: &[u8], partitions: i32) -> i32 {
    (murmur2(key) & 0x7fff_ffff) % partitions
}

/// Which partition a message goes to. A message without a key goes to a random one, like both clients do.
fn pick_partition(send: &SendForm, partitions: &[i32]) -> Result<i32, String> {
    let count = partitions.len() as i32;
    if send.partitioner == Partitioner::Manual {
        return if partitions.contains(&send.partition) {
            Ok(send.partition)
        } else {
            Err(format!("The topic has no partition {} (it has {count}).", send.partition))
        };
    }
    let key = send.key.as_bytes();
    if key.is_empty() {
        let random = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
        return Ok((random % count as u32) as i32);
    }
    Ok(match send.partitioner {
        Partitioner::Murmur2 => murmur2_partition(key, count),
        _ => fnv_partition(key, count),
    })
}

async fn send(client: &Client, form: &Form) -> Result<QueryResult, String> {
    let topic = form.topic()?;
    let send = &form.send;
    let mut partitions = topic_partitions(client, topic).await?;
    partitions.sort();
    let partition = pick_partition(send, &partitions)?;
    let mut headers = BTreeMap::new();
    for header in &send.headers {
        let name = header.name.trim();
        if !name.is_empty() {
            headers.insert(name.to_string(), header.value.clone().into_bytes());
        }
    }
    let timestamp = Utc::now();
    let record = Record {
        key: (!send.key.is_empty()).then(|| send.key.clone().into_bytes()),
        value: Some(send.value.clone().into_bytes()),
        headers,
        timestamp,
    };
    let pc = partition_client(client, topic, partition).await?;
    let offsets = pc
        .produce(vec![record], Compression::NoCompression)
        .await
        .map_err(|e| format!("Could not send to {topic} partition {partition}: {}", error_text(&e)))?;
    let offset = offsets.first().copied().ok_or("The broker did not confirm the message")?;
    Ok(QueryResult {
        columns: vec![
            column("topic", "string"),
            column("partition", "number"),
            column("offset", "number"),
            column("timestamp", "timestamp tz"),
            column("key", "string"),
        ],
        rows: vec![vec![
            Some(topic.to_string()),
            Some(partition.to_string()),
            Some(offset.to_string()),
            Some(format_time(timestamp)),
            (!send.key.is_empty()).then(|| send.key.clone()),
        ]],
        truncated: false,
        message: Some(format!("Sent to {topic}, partition {partition}, offset {offset}")),
    })
}

/// For "Test connection": how the client logged in, and how many topics it sees.
pub async fn probe(conn: &ConnectionParams, password: &str) -> Result<usize, String> {
    forget(conn, password).await;
    let client = connect(conn, password).await?;
    let topics = client.list_topics().await.map_err(|e| format!("Could not list the topics: {}", error_text(&e)))?;
    Ok(topics.len())
}

/// A Kafka form as JSON (used by the MCP tools, which take the form's fields as arguments).
pub fn form_text(mode: &str, topic: &str, read: Value, send: Value) -> String {
    json!({ "kafka": 1, "mode": mode, "topic": topic, "read": read, "send": send }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(key: Option<&str>, value: Option<&str>, headers: Option<&str>) -> Message {
        Message {
            partition: 0,
            offset: 0,
            timestamp: Utc::now(),
            key: key.map(str::to_string),
            value: value.map(str::to_string),
            headers: headers.map(str::to_string),
        }
    }

    fn filter(field: &str, op: Op, value: &str) -> Compiled {
        Compiled::new(&Filter {
            field: field.to_string(),
            op,
            value: value.to_string(),
        })
        .unwrap()
    }

    #[test]
    fn fnv_matches_sarama() {
        // FNV-1a 32 reference values
        let fnv = |s: &str| {
            let mut hash: u32 = 0x811c_9dc5;
            for b in s.bytes() {
                hash ^= u32::from(b);
                hash = hash.wrapping_mul(0x0100_0193);
            }
            hash
        };
        assert_eq!(fnv(""), 0x811c_9dc5);
        assert_eq!(fnv("a"), 0xe40c_292c);
        assert_eq!(fnv("foobar"), 0xbf9c_f968);
        // 0xbf9cf968 as int32 is -1080231576; Go's % keeps the sign and sarama drops it.
        assert_eq!(fnv_partition(b"foobar", 10), 6);
        assert_eq!(fnv_partition(b"a", 3), ((0xe40c_292cu32 as i32) % 3).abs());
        for key in ["order-1", "x", "a-long-key-with-many-bytes"] {
            let p = fnv_partition(key.as_bytes(), 7);
            assert!((0..7).contains(&p));
        }
    }

    #[test]
    fn murmur2_matches_kafka() {
        // Kafka's UtilsTest.testMurmur2
        assert_eq!(murmur2(b"21"), -973932308);
        assert_eq!(murmur2(b"foobar"), -790332482);
        assert_eq!(murmur2(b"a-little-bit-long-string"), -985981536);
        assert_eq!(murmur2(b"a-little-bit-longer-string"), -1486304829);
        assert_eq!(murmur2(b"lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8"), -58897971);
        assert_eq!(murmur2(b"abc"), 479470107);
        assert_eq!(murmur2_partition(b"foobar", 3), ((-790332482i32 & 0x7fff_ffff) % 3));
    }

    #[test]
    fn manual_partition_must_exist() {
        let send = SendForm {
            partitioner: Partitioner::Manual,
            partition: 5,
            ..Default::default()
        };
        assert!(pick_partition(&send, &[0, 1, 2]).unwrap_err().contains("no partition 5"));
        let send = SendForm {
            partitioner: Partitioner::Manual,
            partition: 2,
            ..Default::default()
        };
        assert_eq!(pick_partition(&send, &[0, 1, 2]).unwrap(), 2);
        let keyless = SendForm::default();
        assert!((0..3).contains(&pick_partition(&keyless, &[0, 1, 2]).unwrap()));
    }

    #[test]
    fn forms_parse_with_defaults() {
        let form = Form::parse(r#"{"kafka":1,"topic":"t"}"#).unwrap();
        assert_eq!(form.mode, Mode::Read);
        assert_eq!(form.read.from, Start::Newest);
        assert_eq!(form.send.partitioner, Partitioner::Fnv);
        let form = Form::parse(
            r#"{"kafka":1,"mode":"read","topic":"t","read":{"from":"time","range":"custom","sinceMs":1,"untilMs":2,
                "filters":[{"field":"value.a.0","op":"not_contains","value":"x"}]}}"#,
        )
        .unwrap();
        assert_eq!(form.read.from, Start::Time);
        assert_eq!(form.read.since_ms, Some(1));
        assert_eq!(form.read.filters[0].op, Op::NotContains);
        let form = Form::parse(r#"{"kafka":1,"topic":"t","read":{"from":"timestamp","sinceMs":1761984446000}}"#).unwrap();
        assert_eq!(form.read.from, Start::Timestamp);
        assert_eq!(form.read.since_ms, Some(1_761_984_446_000));
        assert_eq!(Form::parse("select 1").unwrap_err(), NOT_A_FORM);
        assert_eq!(Form::parse(r#"{"a":1}"#).unwrap_err(), NOT_A_FORM);
    }

    #[test]
    fn time_windows() {
        let read = |range: &str, since: Option<i64>, until: Option<i64>| ReadForm {
            range: range.to_string(),
            since_ms: since,
            until_ms: until,
            ..Default::default()
        };
        assert_eq!(window(&read("1h", None, None), 10_000_000).unwrap(), (Some(6_400_000), None));
        assert_eq!(window(&read("custom", Some(5), None), 0).unwrap(), (Some(5), None));
        assert!(window(&read("custom", None, None), 0).is_err());
        assert!(window(&read("custom", Some(5), Some(5)), 0).is_err());
    }

    #[test]
    fn filters_match_fields() {
        let m = msg(Some("order-77"), Some(r#"{"status":"failed","amount":12.5,"items":[{"sku":"A1"}],"ok":false}"#), Some(r#"{"trace-id":"abc"}"#));
        assert!(filter("value.status", Op::Eq, "failed").matches(&m));
        assert!(!filter("value.status", Op::Eq, "FAILED").matches(&m));
        assert!(filter("value.status", Op::Ne, "done").matches(&m));
        assert!(filter("value.amount", Op::Gt, "10").matches(&m));
        assert!(filter("value.amount", Op::Eq, "12.50").matches(&m));
        assert!(filter("value.items.0.sku", Op::Eq, "A1").matches(&m));
        assert!(filter("value.ok", Op::Eq, "false").matches(&m));
        assert!(filter("value.missing", Op::Ne, "x").matches(&m));
        assert!(!filter("value.missing", Op::Exists, "").matches(&m));
        assert!(filter("key", Op::Contains, "ORDER").matches(&m));
        assert!(filter("value", Op::NotContains, "deadbeef").matches(&m));
        assert!(filter("header.trace-id", Op::Eq, "abc").matches(&m));
        assert!(!filter("header.other", Op::Exists, "").matches(&m));
        // a value that is not JSON has no fields
        let plain = msg(None, Some("hello"), None);
        assert!(!filter("value.a", Op::Exists, "").matches(&plain));
        assert!(filter("value", Op::Eq, "hello").matches(&plain));
        assert!(!filter("key", Op::Exists, "").matches(&plain));
        assert!(Compiled::new(&Filter { field: "partition".into(), op: Op::Eq, value: String::new() }).is_err());
    }

    #[test]
    fn newest_first_ordering_and_summary() {
        let at = |ms: i64, partition: i32, offset: i64| Message {
            partition,
            offset,
            timestamp: Utc.timestamp_millis_opt(ms).unwrap(),
            key: None,
            value: None,
            headers: None,
        };
        let mut list = vec![at(1, 0, 10), at(3, 1, 5), at(2, 0, 11)];
        sort_messages(&mut list, true);
        assert_eq!(list.iter().map(|m| m.offset).collect::<Vec<_>>(), vec![5, 11, 10]);
        sort_messages(&mut list, false);
        assert_eq!(list.iter().map(|m| m.offset).collect::<Vec<_>>(), vec![10, 11, 5]);
        assert_eq!(scan_summary(212_480, 3, 4, false, false), "Read 212,480 messages in 3 partitions, 4 matched");
        assert!(scan_summary(5_000_000, 1, 0, true, false).starts_with("Stopped after 5,000,000 messages"));
        assert!(scan_summary(10, 1, 0, true, true).starts_with("Stopped at the connection timeout"));
        assert_eq!(group_digits(-1234), "-1,234");
    }

    /// Against a real cluster: KAFKA_BROKERS=host:9092 cargo test kafka::tests::live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live() {
        let brokers = std::env::var("KAFKA_BROKERS").expect("KAFKA_BROKERS");
        let (host, port) = brokers.rsplit_once(':').unwrap();
        let conn: ConnectionParams = serde_json::from_value(json!({
            "id": "live", "host": host, "port": port, "username": "", "database": "", "db_type": "kafka",
            "read_only": true, "timeout_secs": 30,
        }))
        .unwrap();
        let topics = execute(&conn, "", r#"{"kafka":1,"mode":"topics"}"#, 10_000).await.unwrap();
        println!("{} topics", topics.rows.len());
        // The first topic that has messages, unless one is given.
        let mut topic = std::env::var("KAFKA_TOPIC").unwrap_or_default();
        for row in topics.rows.iter().take(400) {
            if !topic.is_empty() {
                break;
            }
            let name = row[0].clone().unwrap();
            let described = execute(&conn, "", &form_text("describe", &name, json!({}), json!({})), 100).await.unwrap();
            let kept: i64 = described.rows.iter().filter_map(|r| r[3].as_deref()?.parse::<i64>().ok()).sum();
            if kept > 100_000 && !name.starts_with('_') {
                println!("{name}: {:?}", described.message);
                topic = name;
            }
        }
        let started = Instant::now();
        let time = execute(&conn, "", &form_text("read", &topic, json!({ "from": "time", "range": "24h" }), json!({})), 20).await.unwrap();
        println!("time 24h: {:?} rows {} in {:?}", time.message, time.rows.len(), started.elapsed());
        let an_hour_ago = Utc::now().timestamp_millis() - 3_600_000;
        let from_time = execute(&conn, "", &form_text("read", &topic, json!({ "from": "timestamp", "sinceMs": an_hour_ago }), json!({})), 5).await.unwrap();
        println!("from an hour ago: {:?} {:?}", from_time.message, from_time.rows.first().map(|r| r[2].clone()));
        assert!(from_time.rows.iter().all(|r| r[2].is_some()));
        let oldest = execute(&conn, "", &form_text("read", &topic, json!({ "from": "oldest" }), json!({})), 3).await.unwrap();
        println!("oldest: {:?} {:?}", oldest.message, oldest.rows.first());
        let filtered = execute(
            &conn,
            "",
            &form_text("read", &topic, json!({ "from": "newest", "filters": [{ "field": "value", "op": "contains", "value": "zzzz-no-such-text" }] }), json!({})),
            5,
        )
        .await
        .unwrap();
        println!("filtered: {:?}", filtered.message);
        let newest = execute(&conn, "", &form_text("read", &topic, json!({ "from": "newest" }), json!({})), 5).await.unwrap();
        println!("{:?} {:?}", newest.message, newest.rows.first());
        let refused = execute(&conn, "", &form_text("send", &topic, json!({}), json!({ "value": "{}" })), 1).await;
        assert!(refused.unwrap_err().contains("read-only"));
    }
}
