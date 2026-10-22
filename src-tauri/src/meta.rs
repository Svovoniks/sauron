//! Native versions of the useful `psql` backslash commands (`\dt`, `\d table`, `\l`, ...).
//!
//! They are plain catalog queries run through the normal Postgres session, so they use the
//! connection's TLS / read-only / timeout / cancel settings, need no `psql` binary and cannot
//! reach the local machine. The output is laid out like psql's own (see `psql_format`).

use serde::Serialize;
use tokio_postgres::Client;

use crate::cancel::Guard;
use crate::model::{ConnectionParams, QueryResult};
use crate::postgres::{connect_session, query_table};
use crate::psql_format::{aligned_table, Column};

const MIN_SERVER_VERSION: i64 = 120_000;
const MAX_DESCRIBED: usize = 10;

/// What a backslash command prints: plain text, exactly as psql would.
#[derive(Serialize, Debug)]
pub struct MetaOutput {
    pub text: String,
}

// --- parsing -----------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Command {
    Help,
    Conninfo,
    Databases { plus: bool, pattern: Option<String> },
    Schemas { plus: bool, system: bool, pattern: Option<String> },
    /// `kinds` empty = every relation kind `\d` lists.
    Relations { kinds: Vec<char>, plus: bool, system: bool, pattern: Option<String> },
    Describe { plus: bool, pattern: String },
    Functions { plus: bool, system: bool, pattern: Option<String> },
    Roles { plus: bool, pattern: Option<String> },
    Extensions { pattern: Option<String> },
    Privileges { system: bool, pattern: Option<String> },
    FunctionSource(String),
    ViewSource(String),
}

pub fn parse(input: &str) -> Result<Command, String> {
    let text = input.trim();
    let Some(body) = text.strip_prefix('\\') else {
        return Err("A command must start with a backslash, e.g. \\dt".to_string());
    };
    if body.contains('\n') || body.contains('\r') {
        return Err("Only a single-line command can be run.".to_string());
    }

    let (token, rest) = match body.find(char::is_whitespace) {
        Some(i) => (&body[..i], body[i..].trim()),
        None => (body, ""),
    };

    let plus = token.contains('+');
    let mut name = token.replace('+', "");
    let mut system = false;
    while name.len() > 1 && name.ends_with('S') {
        name.pop();
        system = true;
    }

    let optional_pattern = || -> Result<Option<String>, String> { first_word(rest) };

    let relation_kinds = |name: &str| -> Option<Vec<char>> {
        let letters = name.strip_prefix('d')?;
        if letters.is_empty() || !letters.chars().all(|c| "tvmsiE".contains(c)) {
            return None;
        }
        Some(letters.chars().collect())
    };

    Ok(match name.as_str() {
        "?" => Command::Help,
        "conninfo" => Command::Conninfo,
        "l" | "list" => Command::Databases { plus, pattern: optional_pattern()? },
        "dn" => Command::Schemas { plus, system, pattern: optional_pattern()? },
        "df" => Command::Functions { plus, system, pattern: optional_pattern()? },
        "du" | "dg" => Command::Roles { plus, pattern: optional_pattern()? },
        "dx" => Command::Extensions { pattern: optional_pattern()? },
        "dp" | "z" => Command::Privileges { system, pattern: optional_pattern()? },
        "sf" | "sv" => {
            if rest.is_empty() {
                return Err(format!("\\{name} needs a name, e.g. \\{name} my_{}", if name == "sf" { "function" } else { "view" }));
            }
            if name == "sf" {
                Command::FunctionSource(rest.to_string())
            } else {
                Command::ViewSource(rest.to_string())
            }
        }
        "d" => match optional_pattern()? {
            Some(pattern) => Command::Describe { plus, pattern },
            None => Command::Relations { kinds: vec![], plus, system, pattern: None },
        },
        other => match relation_kinds(other) {
            Some(kinds) => Command::Relations { kinds, plus, system, pattern: optional_pattern()? },
            None => {
                return Err(format!(
                    "\\{token} is not supported. Type \\? to see the supported commands."
                ))
            }
        },
    })
}

/// First whitespace separated word, keeping quoted identifiers (`"My Table"`) together.
fn first_word(text: &str) -> Result<Option<String>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let mut in_quotes = false;
    let mut end = text.len();
    for (i, c) in text.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    if text[end..].trim().is_empty() {
        Ok(Some(text[..end].to_string()))
    } else {
        Err("Only one name or pattern is supported.".to_string())
    }
}

// --- name patterns -----------------------------------------------------------------------------

/// A psql style name pattern: `users`, `us*`, `public.u?ers`, `"Mixed Case"`.
#[derive(Debug, PartialEq)]
pub struct NamePattern {
    pub schema: Option<String>,
    pub name: String,
}

fn regex_escape(c: char, out: &mut String) {
    if "\\.+*?()|[]{}^$".contains(c) {
        out.push('\\');
    }
    out.push(c);
}

pub fn parse_pattern(input: &str) -> Result<NamePattern, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                chars.next();
                current.push('"');
            }
            '"' => in_quotes = !in_quotes,
            c if in_quotes => regex_escape(c, &mut current),
            '*' => current.push_str(".*"),
            '?' => current.push('.'),
            '.' => parts.push(std::mem::take(&mut current)),
            c => c.to_lowercase().for_each(|l| regex_escape(l, &mut current)),
        }
    }
    if in_quotes {
        return Err("Unterminated quoted name.".to_string());
    }
    parts.push(current);

    let part = |s: String| if s.is_empty() { ".*".to_string() } else { s };
    match parts.len() {
        1 => Ok(NamePattern { schema: None, name: part(parts.remove(0)) }),
        2 => {
            let name = part(parts.remove(1));
            Ok(NamePattern { schema: Some(part(parts.remove(0))), name })
        }
        _ => Err("Cross-database references are not supported (use schema.name).".to_string()),
    }
}

/// String literal that is correct whatever `standard_conforming_strings` is set to.
pub fn lit(s: &str) -> String {
    format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

fn anchored(regex: &str) -> String {
    lit(&format!("^({regex})$"))
}

/// WHERE conditions for the optional pattern argument, with psql's rules: an unqualified pattern
/// only matches what is visible on the search path; without a pattern system schemas are hidden.
fn conditions(
    pattern: &Option<String>,
    name_col: &str,
    schema_col: &str,
    visible: Option<&str>,
    visible_without_pattern: bool,
    system: bool,
) -> Result<Vec<String>, String> {
    let mut conds = Vec::new();
    match pattern {
        Some(text) => {
            let p = parse_pattern(text)?;
            conds.push(format!("{name_col} ~ {}", anchored(&p.name)));
            match (&p.schema, visible) {
                (Some(schema), _) => conds.push(format!("{schema_col} ~ {}", anchored(schema))),
                (None, Some(v)) => conds.push(v.to_string()),
                (None, None) => {}
            }
        }
        None => {
            if !system {
                conds.push(format!(
                    "{schema_col} <> 'pg_catalog' AND {schema_col} <> 'information_schema' AND {schema_col} !~ '^pg_toast'"
                ));
                if let (true, Some(v)) = (visible_without_pattern, visible) {
                    conds.push(v.to_string());
                }
            }
        }
    }
    Ok(conds)
}

fn where_clause(conds: &[String]) -> String {
    if conds.is_empty() {
        "true".to_string()
    } else {
        conds.join(" AND ")
    }
}

// --- list queries ------------------------------------------------------------------------------

const RELKIND_LABEL: &str = "CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' \
WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence' WHEN 't' THEN 'TOAST table' WHEN 'f' THEN 'foreign table' \
WHEN 'p' THEN 'partitioned table' WHEN 'I' THEN 'partitioned index' WHEN 'c' THEN 'composite type' END";

fn relations_sql(kinds: &[char], plus: bool, system: bool, pattern: &Option<String>) -> Result<String, String> {
    let mut relkinds: Vec<&str> = Vec::new();
    if kinds.is_empty() {
        relkinds.extend(["r", "p", "v", "m", "S", "f"]);
    }
    for k in kinds {
        match k {
            't' => relkinds.extend(["r", "p"]),
            'v' => relkinds.push("v"),
            'm' => relkinds.push("m"),
            'i' => relkinds.extend(["i", "I"]),
            's' => relkinds.push("S"),
            'E' => relkinds.push("f"),
            _ => {}
        }
    }
    let list = relkinds.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");

    let mut conds = vec![format!("c.relkind IN ({list})")];
    conds.extend(conditions(
        pattern,
        "c.relname",
        "n.nspname",
        Some("pg_table_is_visible(c.oid)"),
        true,
        system,
    )?);

    let mut columns = format!(
        "n.nspname AS \"Schema\", c.relname AS \"Name\", {RELKIND_LABEL} AS \"Type\", pg_get_userbyid(c.relowner) AS \"Owner\""
    );
    if kinds.contains(&'i') {
        columns.push_str(
            ", (SELECT t.relname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid WHERE i.indexrelid = c.oid) AS \"Table\"",
        );
    }
    if plus {
        columns.push_str(
            ", CASE c.relpersistence WHEN 'p' THEN 'permanent' WHEN 't' THEN 'temporary' WHEN 'u' THEN 'unlogged' END AS \"Persistence\", am.amname AS \"Access method\", \
pg_size_pretty(pg_table_size(c.oid)) AS \"Size\", obj_description(c.oid, 'pg_class') AS \"Description\"",
        );
    }
    let access_method = if plus { " LEFT JOIN pg_am am ON am.oid = c.relam" } else { "" };
    Ok(format!(
        "SELECT {columns} FROM pg_class c LEFT JOIN pg_namespace n ON n.oid = c.relnamespace{access_method} WHERE {} ORDER BY 1, 2",
        where_clause(&conds)
    ))
}

fn databases_sql(plus: bool, version: i64, pattern: &Option<String>) -> Result<String, String> {
    let conds = match pattern {
        Some(text) => vec![format!("d.datname ~ {}", anchored(&parse_pattern(text)?.name))],
        None => vec![],
    };
    let mut columns = "d.datname AS \"Name\", pg_get_userbyid(d.datdba) AS \"Owner\", pg_encoding_to_char(d.encoding) AS \"Encoding\"".to_string();
    // Same columns as psql: the locale provider / ICU columns exist from PostgreSQL 15 / 16 / 17 on.
    if version >= 150_000 {
        columns.push_str(", CASE d.datlocprovider WHEN 'b' THEN 'builtin' WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu' END AS \"Locale Provider\"");
    }
    columns.push_str(", d.datcollate AS \"Collate\", d.datctype AS \"Ctype\"");
    if version >= 170_000 {
        columns.push_str(", d.datlocale AS \"Locale\"");
    } else if version >= 150_000 {
        columns.push_str(", d.daticulocale AS \"ICU Locale\"");
    }
    if version >= 160_000 {
        columns.push_str(", d.daticurules AS \"ICU Rules\"");
    }
    columns.push_str(", array_to_string(d.datacl, E'\\n') AS \"Access privileges\"");
    let mut from = "pg_database d".to_string();
    if plus {
        columns.push_str(
            ", CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_size_pretty(pg_database_size(d.datname)) ELSE 'No Access' END AS \"Size\", \
t.spcname AS \"Tablespace\", shobj_description(d.oid, 'pg_database') AS \"Description\"",
        );
        from.push_str(" JOIN pg_tablespace t ON t.oid = d.dattablespace");
    }
    Ok(format!("SELECT {columns} FROM {from} WHERE {} ORDER BY 1", where_clause(&conds)))
}

fn schemas_sql(plus: bool, system: bool, pattern: &Option<String>) -> Result<String, String> {
    let mut conds = Vec::new();
    match pattern {
        Some(text) => conds.push(format!("n.nspname ~ {}", anchored(&parse_pattern(text)?.name))),
        None if !system => conds.push("n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'".to_string()),
        None => {}
    }
    let mut columns = "n.nspname AS \"Name\", pg_get_userbyid(n.nspowner) AS \"Owner\"".to_string();
    if plus {
        columns.push_str(
            ", array_to_string(n.nspacl, E'\\n') AS \"Access privileges\", obj_description(n.oid, 'pg_namespace') AS \"Description\"",
        );
    }
    Ok(format!("SELECT {columns} FROM pg_namespace n WHERE {} ORDER BY 1", where_clause(&conds)))
}

fn functions_sql(plus: bool, system: bool, pattern: &Option<String>) -> Result<String, String> {
    let conds = conditions(pattern, "p.proname", "n.nspname", Some("pg_function_is_visible(p.oid)"), false, system)?;
    let mut columns = "n.nspname AS \"Schema\", p.proname AS \"Name\", pg_get_function_result(p.oid) AS \"Result data type\", \
pg_get_function_arguments(p.oid) AS \"Argument data types\", \
CASE p.prokind WHEN 'a' THEN 'agg' WHEN 'w' THEN 'window' WHEN 'p' THEN 'proc' ELSE 'func' END AS \"Type\""
        .to_string();
    let mut from = "pg_proc p LEFT JOIN pg_namespace n ON n.oid = p.pronamespace".to_string();
    if plus {
        columns.push_str(
            ", CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' WHEN 'v' THEN 'volatile' END AS \"Volatility\", \
CASE p.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted' WHEN 'u' THEN 'unsafe' END AS \"Parallel\", \
pg_get_userbyid(p.proowner) AS \"Owner\", CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END AS \"Security\", \
CASE WHEN p.proleakproof THEN 'yes' ELSE 'no' END AS \"Leakproof?\", array_to_string(p.proacl, E'\\n') AS \"Access privileges\", \
l.lanname AS \"Language\", CASE WHEN l.lanname IN ('internal', 'c') THEN p.prosrc END AS \"Internal name\", \
obj_description(p.oid, 'pg_proc') AS \"Description\"",
        );
        from.push_str(" LEFT JOIN pg_language l ON l.oid = p.prolang");
    }
    Ok(format!("SELECT {columns} FROM {from} WHERE {} ORDER BY 1, 2, 4", where_clause(&conds)))
}

fn roles_sql(plus: bool, pattern: &Option<String>) -> Result<String, String> {
    let mut conds = vec!["r.rolname !~ '^pg_'".to_string()];
    if let Some(text) = pattern {
        conds.push(format!("r.rolname ~ {}", anchored(&parse_pattern(text)?.name)));
    }
    let mut columns = "r.rolname AS \"Role name\", concat_ws(', ', \
CASE WHEN r.rolsuper THEN 'Superuser' END, CASE WHEN NOT r.rolinherit THEN 'No inheritance' END, \
CASE WHEN r.rolcreaterole THEN 'Create role' END, CASE WHEN r.rolcreatedb THEN 'Create DB' END, \
CASE WHEN NOT r.rolcanlogin THEN 'Cannot login' END, CASE WHEN r.rolreplication THEN 'Replication' END, \
CASE WHEN r.rolbypassrls THEN 'Bypass RLS' END) AS \"Attributes\""
        .to_string();
    if plus {
        columns.push_str(", shobj_description(r.oid, 'pg_authid') AS \"Description\"");
    }
    Ok(format!("SELECT {columns} FROM pg_roles r WHERE {} ORDER BY 1", where_clause(&conds)))
}

fn extensions_sql(pattern: &Option<String>) -> Result<String, String> {
    let conds = match pattern {
        Some(text) => vec![format!("e.extname ~ {}", anchored(&parse_pattern(text)?.name))],
        None => vec![],
    };
    Ok(format!(
        "SELECT e.extname AS \"Name\", e.extversion AS \"Version\", (SELECT a.default_version FROM pg_available_extensions a WHERE a.name = e.extname) AS \"Default version\", n.nspname AS \"Schema\", c.description AS \"Description\" \
FROM pg_extension e LEFT JOIN pg_namespace n ON n.oid = e.extnamespace \
LEFT JOIN pg_description c ON c.objoid = e.oid AND c.classoid = 'pg_extension'::regclass WHERE {} ORDER BY 1",
        where_clause(&conds)
    ))
}

fn privileges_sql(system: bool, pattern: &Option<String>) -> Result<String, String> {
    let mut conds = vec!["c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')".to_string()];
    conds.extend(conditions(pattern, "c.relname", "n.nspname", Some("pg_table_is_visible(c.oid)"), true, system)?);
    Ok(format!(
        "SELECT n.nspname AS \"Schema\", c.relname AS \"Name\", {RELKIND_LABEL} AS \"Type\", \
array_to_string(c.relacl, E'\\n') AS \"Access privileges\", \
array_to_string(ARRAY(SELECT attname || E':\\n  ' || array_to_string(attacl, E'\\n  ') FROM pg_attribute a WHERE attrelid = c.oid AND NOT attisdropped AND attacl IS NOT NULL), E'\\n') AS \"Column privileges\", \
array_to_string(ARRAY(SELECT polname || CASE WHEN NOT polpermissive THEN E' (RESTRICTIVE)' ELSE '' END \
|| CASE WHEN polcmd != '*' THEN E' (' || polcmd::text || E'):' ELSE E':' END \
|| CASE WHEN polqual IS NOT NULL THEN E'\\n  (u): ' || pg_get_expr(polqual, polrelid) ELSE E'' END \
|| CASE WHEN polwithcheck IS NOT NULL THEN E'\\n  (c): ' || pg_get_expr(polwithcheck, polrelid) ELSE E'' END \
|| CASE WHEN polroles <> '{{0}}' THEN E'\\n  to: ' || array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (polroles) ORDER BY 1), E', ') ELSE E'' END \
FROM pg_policy pol WHERE polrelid = c.oid), E'\\n') AS \"Policies\" \
FROM pg_class c LEFT JOIN pg_namespace n ON n.oid = c.relnamespace WHERE {} ORDER BY 1, 2",
        where_clause(&conds)
    ))
}

// --- output ------------------------------------------------------------------------------------

fn result_table(title: Option<&str>, result: &QueryResult, row_count_footer: bool) -> String {
    let columns: Vec<Column> = result
        .columns
        .iter()
        .map(|c| Column::new(c.name.clone(), c.ui_type == "number"))
        .collect();
    aligned_table(title, &columns, &result.rows, row_count_footer)
}

/// A list command: `title`, the aligned table and `(N rows)`; `empty` replaces the table when nothing matched.
async fn list(
    client: &Client,
    sql: String,
    title: &str,
    empty: Option<String>,
    row_count_footer: bool,
    read_only: bool,
) -> Result<MetaOutput, String> {
    let result = query_table(client, &sql, read_only).await?;
    let text = match (&empty, result.rows.is_empty()) {
        (Some(message), true) => format!("{message}\n"),
        _ => format!("{}\n", result_table(Some(title), &result, row_count_footer)),
    };
    Ok(MetaOutput { text })
}

fn nothing_found(plural: &str, pattern: &Option<String>) -> String {
    match pattern {
        Some(p) => format!("Did not find any {plural} named \"{p}\"."),
        None => format!("Did not find any {plural}."),
    }
}

// --- describe ----------------------------------------------------------------------------------

fn kind_label(relkind: &str, persistence: &str) -> &'static str {
    match (relkind, persistence) {
        ("r", "u") => "Unlogged table",
        ("r", _) => "Table",
        ("p", "u") => "Unlogged partitioned table",
        ("p", _) => "Partitioned table",
        ("v", _) => "View",
        ("m", _) => "Materialized view",
        ("i", "u") => "Unlogged index",
        ("i", _) => "Index",
        ("I", _) => "Partitioned index",
        ("S", _) => "Sequence",
        ("f", _) => "Foreign table",
        ("t", _) => "TOAST table",
        ("c", _) => "Composite type",
        _ => "Relation",
    }
}

async fn scalar(client: &Client, sql: &str, read_only: bool) -> Result<Option<String>, String> {
    let result = query_table(client, sql, read_only).await?;
    Ok(result.rows.into_iter().next().and_then(|row| row.into_iter().next()).flatten())
}

fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn flag(row: &[Option<String>], i: usize) -> bool {
    cell(row, i) == "true"
}

/// `Heading:` followed by indented lines, psql's footer style.
fn footer_block(out: &mut String, heading: &str, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    out.push_str(heading);
    out.push_str(":\n");
    for line in lines {
        out.push_str("    ");
        out.push_str(line);
        out.push('\n');
    }
}

fn columns_sql(oid: u32, kind: &str, plus: bool, version: i64) -> String {
    let mut extra = String::new();
    if plus {
        let compression = if version >= 140_000 && matches!(kind, "r" | "p" | "m") {
            ", CASE a.attcompression WHEN 'p' THEN 'pglz' WHEN 'l' THEN 'lz4' END AS \"Compression\""
        } else {
            ""
        };
        extra.push_str(
            ", CASE a.attstorage WHEN 'p' THEN 'plain' WHEN 'e' THEN 'external' WHEN 'm' THEN 'main' WHEN 'x' THEN 'extended' END AS \"Storage\"",
        );
        extra.push_str(compression);
        if matches!(kind, "r" | "p" | "m" | "f") {
            extra.push_str(
                ", CASE WHEN a.attstattarget IS NOT NULL AND a.attstattarget >= 0 THEN a.attstattarget::text END AS \"Stats target\"",
            );
        }
        extra.push_str(", col_description(a.attrelid, a.attnum) AS \"Description\"");
    }
    format!(
        "SELECT a.attname AS \"Column\", format_type(a.atttypid, a.atttypmod) AS \"Type\", \
(SELECT c.collname FROM pg_collation c, pg_type t WHERE c.oid = a.attcollation AND t.oid = a.atttypid AND a.attcollation <> t.typcollation) AS \"Collation\", \
CASE WHEN a.attnotnull THEN 'not null' END AS \"Nullable\", \
CASE WHEN a.attidentity = 'a' THEN 'generated always as identity' \
WHEN a.attidentity = 'd' THEN 'generated by default as identity' \
WHEN a.attgenerated = 's' THEN 'generated always as (' || pg_get_expr(ad.adbin, ad.adrelid, true) || ') stored' \
WHEN a.attgenerated = 'v' THEN 'generated always as (' || pg_get_expr(ad.adbin, ad.adrelid, true) || ') virtual' \
ELSE pg_get_expr(ad.adbin, ad.adrelid, true) END AS \"Default\"{extra} \
FROM pg_attribute a LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum \
WHERE a.attrelid = {oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
    )
}

struct Relation {
    oid: u32,
    schema: String,
    name: String,
    relkind: String,
    persistence: String,
    is_partition: bool,
}

async fn describe_sequence(client: &Client, rel: &Relation, title: &str, ro: bool) -> Result<String, String> {
    let sequence = query_table(
        client,
        &format!(
            "SELECT s.data_type::text AS \"Type\", s.start_value AS \"Start\", s.min_value AS \"Minimum\", s.max_value AS \"Maximum\", \
s.increment_by AS \"Increment\", CASE WHEN s.cycle THEN 'yes' ELSE 'no' END AS \"Cycles?\", s.cache_size AS \"Cache\" \
FROM pg_sequences s WHERE s.schemaname = {} AND s.sequencename = {}",
            lit(&rel.schema),
            lit(&rel.name)
        ),
        ro,
    )
    .await?;
    let mut out = result_table(Some(title), &sequence, false);

    let owner = query_table(
        client,
        &format!(
            "SELECT d.deptype::text, n.nspname || '.' || t.relname || '.' || a.attname FROM pg_depend d \
JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace \
JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
WHERE d.classid = 'pg_class'::regclass AND d.objid = {} AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')",
            rel.oid
        ),
        ro,
    )
    .await?;
    if let Some(row) = owner.rows.first() {
        let label = if cell(row, 0) == "i" { "Sequence for identity column" } else { "Owned by" };
        out.push_str(&format!("{label}: {}\n", cell(row, 1)));
    }
    Ok(out)
}

async fn describe_index(client: &Client, rel: &Relation, title: &str, plus: bool, ro: bool) -> Result<String, String> {
    let extra = if plus {
        ", CASE a.attstorage WHEN 'p' THEN 'plain' WHEN 'e' THEN 'external' WHEN 'm' THEN 'main' WHEN 'x' THEN 'extended' END AS \"Storage\", \
CASE WHEN a.attstattarget IS NOT NULL AND a.attstattarget >= 0 THEN a.attstattarget::text END AS \"Stats target\""
    } else {
        ""
    };
    let columns = query_table(
        client,
        &format!(
            "SELECT a.attname AS \"Column\", format_type(a.atttypid, a.atttypmod) AS \"Type\", \
CASE WHEN a.attnum <= i.indnkeyatts THEN 'yes' ELSE 'no' END AS \"Key?\", \
pg_get_indexdef(a.attrelid, a.attnum, true) AS \"Definition\"{extra} \
FROM pg_attribute a JOIN pg_index i ON i.indexrelid = a.attrelid \
WHERE a.attrelid = {} AND a.attnum > 0 ORDER BY a.attnum",
            rel.oid
        ),
        ro,
    )
    .await?;
    let mut out = result_table(Some(title), &columns, false);

    let info = query_table(
        client,
        &format!(
            "SELECT i.indisprimary, i.indisunique, am.amname, pg_get_expr(i.indpred, i.indrelid, true), i.indisvalid, i.indrelid::regclass::text \
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam WHERE i.indexrelid = {}",
            rel.oid
        ),
        ro,
    )
    .await?;
    if let Some(row) = info.rows.first() {
        let mut parts: Vec<String> = Vec::new();
        if flag(row, 0) {
            parts.push("primary key".into());
        } else if flag(row, 1) {
            parts.push("unique".into());
        }
        parts.push(cell(row, 2));
        parts.push(format!("for table \"{}\"", cell(row, 5)));
        let predicate = cell(row, 3);
        if !predicate.is_empty() {
            parts.push(format!("predicate ({predicate})"));
        }
        if !flag(row, 4) {
            parts.push("invalid".into());
        }
        out.push_str(&parts.join(", "));
        out.push('\n');
    }
    Ok(out)
}

async fn describe_relation(client: &Client, rel: &Relation, plus: bool, version: i64, ro: bool) -> Result<String, String> {
    let title = format!("{} \"{}.{}\"", kind_label(&rel.relkind, &rel.persistence), rel.schema, rel.name);
    let oid = rel.oid;
    let kind = rel.relkind.as_str();

    match kind {
        "S" => return describe_sequence(client, rel, &title, ro).await,
        "i" | "I" => return describe_index(client, rel, &title, plus, ro).await,
        _ => {}
    }

    let columns = query_table(client, &columns_sql(oid, kind, plus, version), ro).await?;
    let mut out = result_table(Some(&title), &columns, false);

    if rel.is_partition {
        let parent = query_table(
            client,
            &format!(
                "SELECT i.inhparent::regclass::text, pg_get_expr(c.relpartbound, c.oid, true) \
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhrelid = {oid}"
            ),
            ro,
        )
        .await?;
        if let Some(row) = parent.rows.first() {
            out.push_str(&format!("Partition of: {} {}\n", cell(row, 0), cell(row, 1)));
        }
    }
    if kind == "p" {
        if let Some(key) = scalar(client, &format!("SELECT pg_get_partkeydef({oid})"), ro).await? {
            out.push_str(&format!("Partition key: {key}\n"));
        }
    }

    if plus && matches!(kind, "v" | "m") {
        if let Some(def) = scalar(client, &format!("SELECT pg_get_viewdef({oid}, true)"), ro).await? {
            out.push_str("View definition:\n");
            out.push_str(&def);
            out.push('\n');
        }
    }

    if matches!(kind, "r" | "p" | "m") {
        let indexes = query_table(
            client,
            &format!(
                "SELECT c2.relname, i.indisprimary, i.indisunique, i.indisexclusion, i.indisvalid, \
pg_get_indexdef(i.indexrelid, 0, true), pg_get_constraintdef(con.oid, true), con.contype::text, \
COALESCE(con.condeferrable, false), COALESCE(con.condeferred, false) \
FROM pg_index i JOIN pg_class c2 ON c2.oid = i.indexrelid \
LEFT JOIN pg_constraint con ON con.conrelid = i.indrelid AND con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x') \
WHERE i.indrelid = {oid} ORDER BY i.indisprimary DESC, c2.relname"
            ),
            ro,
        )
        .await?;
        let lines: Vec<String> = indexes
            .rows
            .iter()
            .map(|r| {
                let mut line = format!("\"{}\" ", cell(r, 0));
                if flag(r, 3) {
                    line.push_str(&cell(r, 6));
                } else {
                    if flag(r, 1) {
                        line.push_str("PRIMARY KEY, ");
                    } else if flag(r, 2) {
                        line.push_str(if cell(r, 7) == "u" { "UNIQUE CONSTRAINT, " } else { "UNIQUE, " });
                    }
                    let def = cell(r, 5);
                    line.push_str(def.split_once(" USING ").map_or(def.as_str(), |(_, rest)| rest));
                }
                if !flag(r, 4) {
                    line.push_str(" INVALID");
                }
                if flag(r, 8) {
                    line.push_str(" DEFERRABLE");
                }
                if flag(r, 9) {
                    line.push_str(" INITIALLY DEFERRED");
                }
                line
            })
            .collect();
        footer_block(&mut out, "Indexes", &lines);
    }

    if matches!(kind, "r" | "p" | "f") {
        for (contype, heading) in [("c", "Check constraints"), ("f", "Foreign-key constraints")] {
            let constraints = query_table(
                client,
                &format!(
                    "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = {oid} AND contype = '{contype}' ORDER BY 1"
                ),
                ro,
            )
            .await?;
            let lines: Vec<String> = constraints.rows.iter().map(|r| format!("\"{}\" {}", cell(r, 0), cell(r, 1))).collect();
            footer_block(&mut out, heading, &lines);
        }
    }

    if matches!(kind, "r" | "p") {
        let referenced = query_table(
            client,
            &format!(
                "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid, true) FROM pg_constraint \
WHERE confrelid = {oid} AND contype = 'f' ORDER BY 1, 2"
            ),
            ro,
        )
        .await?;
        let lines: Vec<String> = referenced
            .rows
            .iter()
            .map(|r| format!("TABLE \"{}\" CONSTRAINT \"{}\" {}", cell(r, 0), cell(r, 1), cell(r, 2)))
            .collect();
        footer_block(&mut out, "Referenced by", &lines);
    }

    if plus && version >= 180_000 && matches!(kind, "r" | "p" | "f") {
        let not_null = query_table(
            client,
            &format!(
                "SELECT c.conname, a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] \
WHERE c.conrelid = {oid} AND c.contype = 'n' ORDER BY a.attnum"
            ),
            ro,
        )
        .await?;
        let lines: Vec<String> = not_null.rows.iter().map(|r| format!("\"{}\" NOT NULL \"{}\"", cell(r, 0), cell(r, 1))).collect();
        footer_block(&mut out, "Not-null constraints", &lines);
    }

    if matches!(kind, "r" | "p" | "v" | "f") {
        let triggers = query_table(
            client,
            &format!(
                "SELECT t.tgenabled::text, pg_get_triggerdef(t.oid, true) FROM pg_trigger t \
WHERE t.tgrelid = {oid} AND NOT t.tgisinternal ORDER BY t.tgname"
            ),
            ro,
        )
        .await?;
        for (state, heading) in [
            ("O", "Triggers"),
            ("D", "Disabled user triggers"),
            ("A", "Triggers firing always"),
            ("R", "Triggers firing on replica only"),
        ] {
            let lines: Vec<String> = triggers
                .rows
                .iter()
                .filter(|r| cell(r, 0) == state)
                .map(|r| {
                    let def = cell(r, 1);
                    def.strip_prefix("CREATE TRIGGER ")
                        .or_else(|| def.strip_prefix("CREATE CONSTRAINT TRIGGER "))
                        .unwrap_or(&def)
                        .to_string()
                })
                .collect();
            footer_block(&mut out, heading, &lines);
        }
    }

    if kind == "p" {
        let partitions = query_table(
            client,
            &format!(
                "SELECT c.oid::regclass::text, pg_get_expr(c.relpartbound, c.oid, true) FROM pg_inherits i \
JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = {oid} ORDER BY 1 LIMIT 500"
            ),
            ro,
        )
        .await?;
        let count = partitions.rows.len();
        if plus {
            for (n, r) in partitions.rows.iter().enumerate() {
                let prefix = if n == 0 { "Partitions: " } else { "            " };
                let comma = if n + 1 < count { "," } else { "" };
                out.push_str(&format!("{prefix}{} {}{comma}\n", cell(r, 0), cell(r, 1)));
            }
        } else if count > 0 {
            out.push_str(&format!("Number of partitions: {count} (Use \\d+ to list them.)\n"));
        }
    }

    if plus && matches!(kind, "r" | "p" | "m") {
        if let Some(am) = scalar(
            client,
            &format!("SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.oid = {oid}"),
            ro,
        )
        .await?
        {
            out.push_str(&format!("Access method: {am}\n"));
        }
    }

    Ok(out)
}

async fn describe(client: &Client, pattern: &str, plus: bool, version: i64, read_only: bool) -> Result<MetaOutput, String> {
    let conds = conditions(
        &Some(pattern.to_string()),
        "c.relname",
        "n.nspname",
        Some("pg_table_is_visible(c.oid)"),
        true,
        true,
    )?;
    let found = query_table(
        client,
        &format!(
            "SELECT c.oid::text, n.nspname, c.relname, c.relkind::text, c.relpersistence::text, c.relispartition FROM pg_class c \
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace WHERE {} ORDER BY 2, 3 LIMIT {}",
            where_clause(&conds),
            MAX_DESCRIBED + 1
        ),
        read_only,
    )
    .await?;

    if found.rows.is_empty() {
        return Err(format!(
            "Did not find any relation named \"{pattern}\". Names are looked up on the search path; use schema.name or \\dt *.{pattern}* to search every schema."
        ));
    }

    let mut blocks = Vec::new();
    for row in found.rows.iter().take(MAX_DESCRIBED) {
        let rel = Relation {
            oid: cell(row, 0).parse().map_err(|_| "Unexpected catalog result".to_string())?,
            schema: cell(row, 1),
            name: cell(row, 2),
            relkind: cell(row, 3),
            persistence: cell(row, 4),
            is_partition: flag(row, 5),
        };
        blocks.push(describe_relation(client, &rel, plus, version, read_only).await?);
    }
    let mut text = blocks.join("\n");
    text.push('\n');
    if found.rows.len() > MAX_DESCRIBED {
        text.push_str(&format!("Only the first {MAX_DESCRIBED} matches are shown. Use a more specific name.\n"));
    }
    Ok(MetaOutput { text })
}

async fn conninfo(client: &Client, read_only: bool) -> Result<MetaOutput, String> {
    let info = query_table(
        client,
        "SELECT current_database(), session_user::text, host(inet_server_addr()), inet_server_port()::text, pg_backend_pid()::text, \
(SELECT s.ssl::text FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()), \
(SELECT s.version FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid() AND s.ssl), \
(SELECT s.cipher FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid() AND s.ssl), \
current_setting('is_superuser'), CASE WHEN pg_is_in_recovery() THEN 'on' ELSE 'off' END, \
(SELECT g.gss_authenticated::text FROM pg_stat_gssapi g WHERE g.pid = pg_backend_pid())",
        read_only,
    )
    .await?;
    let row = info.rows.first().cloned().unwrap_or_default();
    let some = |s: String| Some(s);

    let mut rows: Vec<Vec<Option<String>>> = vec![
        vec![some("Database".into()), some(cell(&row, 0))],
        vec![some("Client User".into()), some(cell(&row, 1))],
    ];
    let host = cell(&row, 2);
    if host.is_empty() {
        rows.push(vec![some("Host".into()), some("(local socket)".into())]);
    } else {
        rows.push(vec![some("Host".into()), some(host)]);
        rows.push(vec![some("Server Port".into()), some(cell(&row, 3))]);
    }
    rows.push(vec![some("Options".into()), None]);
    rows.push(vec![some("Protocol Version".into()), some("3.0".into())]);
    rows.push(vec![some("GSSAPI Authenticated".into()), some(cell(&row, 10))]);
    rows.push(vec![some("Backend PID".into()), some(cell(&row, 4))]);
    rows.push(vec![some("SSL Connection".into()), some(cell(&row, 5))]);
    if flag(&row, 5) {
        rows.push(vec![some("SSL Protocol".into()), some(cell(&row, 6))]);
        rows.push(vec![some("SSL Cipher".into()), some(cell(&row, 7))]);
    }
    rows.push(vec![some("Superuser".into()), some(cell(&row, 8))]);
    rows.push(vec![some("Hot Standby".into()), some(cell(&row, 9))]);

    let columns = [Column::new("Parameter", false), Column::new("Value", false)];
    Ok(MetaOutput { text: format!("{}\n", aligned_table(Some("Connection Information"), &columns, &rows, true)) })
}

fn help() -> MetaOutput {
    MetaOutput {
        text: "\
\\l[+] [pattern]         list databases
\\dn[S+] [pattern]       list schemas
\\d[S+]                  list tables, views, sequences (on the search path)
\\d[S+] name             describe a table / view / index / sequence: columns, indexes, constraints, triggers
\\dt \\dv \\dm \\di \\ds \\dE [+] [pattern]   list tables / views / materialized views / indexes / sequences / foreign tables
                        (they can be combined: \\dtv)
\\df[S+] [pattern]       list functions
\\du[+] [pattern]        list roles
\\dx [pattern]           list extensions
\\dp [pattern]           list access privileges of tables
\\sf name                show a function's source
\\sv name                show a view's definition
\\conninfo               show the current connection
\\?                      this help

Patterns: * matches anything, ? one character, schema.name qualifies, \"Quoted Name\" keeps its case.
Without a schema only names on the search path are matched: use \\dt *.* to list every schema.
+ adds sizes / descriptions, S includes system objects.
"
        .to_string(),
    }
}

// --- entry point -------------------------------------------------------------------------------

pub async fn execute(
    conn: &ConnectionParams,
    password: &str,
    text: &str,
    guard: &Guard<'_>,
) -> Result<MetaOutput, String> {
    let command = parse(text)?;
    if command == Command::Help {
        return Ok(help());
    }

    guard
        .run(async {
            let client = connect_session(conn, password, guard).await?;
            let ro = conn.read_only;

            let version = scalar(&client, "SELECT current_setting('server_version_num')::int", ro)
                .await?
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            if version < MIN_SERVER_VERSION {
                return Err("These commands need PostgreSQL 12 or newer. Run a SQL query against the catalogs instead.".to_string());
            }

            match command {
                Command::Help => Ok(help()),
                Command::Conninfo => conninfo(&client, ro).await,
                Command::Databases { plus, pattern } => {
                    list(&client, databases_sql(plus, version, &pattern)?, "List of databases", None, true, ro).await
                }
                Command::Schemas { plus, system, pattern } => {
                    list(&client, schemas_sql(plus, system, &pattern)?, "List of schemas", None, true, ro).await
                }
                Command::Relations { kinds, plus, system, pattern } => {
                    let (title, plural) = match kinds.as_slice() {
                        ['t'] => ("List of tables", "tables"),
                        ['v'] => ("List of views", "views"),
                        ['m'] => ("List of materialized views", "materialized views"),
                        ['i'] => ("List of indexes", "indexes"),
                        ['s'] => ("List of sequences", "sequences"),
                        ['E'] => ("List of foreign tables", "foreign tables"),
                        _ => ("List of relations", "relations"),
                    };
                    let empty = Some(nothing_found(plural, &pattern));
                    list(&client, relations_sql(&kinds, plus, system, &pattern)?, title, empty, true, ro).await
                }
                Command::Functions { plus, system, pattern } => {
                    list(&client, functions_sql(plus, system, &pattern)?, "List of functions", None, true, ro).await
                }
                Command::Roles { plus, pattern } => list(&client, roles_sql(plus, &pattern)?, "List of roles", None, false, ro).await,
                Command::Extensions { pattern } => {
                    list(&client, extensions_sql(&pattern)?, "List of installed extensions", None, true, ro).await
                }
                Command::Privileges { system, pattern } => {
                    let empty = Some(nothing_found("relations", &pattern));
                    list(&client, privileges_sql(system, &pattern)?, "Access privileges", empty, true, ro).await
                }
                Command::Describe { plus, pattern } => describe(&client, &pattern, plus, version, ro).await,
                Command::FunctionSource(name) => {
                    let cast = if name.contains('(') { "regprocedure" } else { "regproc" };
                    let source = scalar(&client, &format!("SELECT pg_get_functiondef({}::{cast}::oid)", lit(&name)), ro)
                        .await?
                        .unwrap_or_default();
                    Ok(MetaOutput { text: format!("{source}\n") })
                }
                Command::ViewSource(name) => {
                    let source = scalar(
                        &client,
                        &format!(
                            "SELECT 'CREATE OR REPLACE VIEW ' || {l}::regclass::text || E' AS\\n' || pg_get_viewdef({l}::regclass, true)",
                            l = lit(&name)
                        ),
                        ro,
                    )
                    .await?
                    .unwrap_or_default();
                    // psql prints view source without the trailing semicolon
                    let source = source.trim_end().trim_end_matches(';').to_string();
                    Ok(MetaOutput { text: format!("{source}\n") })
                }
            }
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_parsed_with_modifiers() {
        assert_eq!(parse("\\dt").unwrap(), Command::Relations { kinds: vec!['t'], plus: false, system: false, pattern: None });
        assert_eq!(parse("  \\dt+ public.*").unwrap(), Command::Relations { kinds: vec!['t'], plus: true, system: false, pattern: Some("public.*".into()) });
        assert_eq!(parse("\\dtvS+ x").unwrap(), Command::Relations { kinds: vec!['t', 'v'], plus: true, system: true, pattern: Some("x".into()) });
        assert_eq!(parse("\\d").unwrap(), Command::Relations { kinds: vec![], plus: false, system: false, pattern: None });
        assert_eq!(parse("\\d+ users").unwrap(), Command::Describe { plus: true, pattern: "users".into() });
        assert_eq!(parse("\\d \"My Table\"").unwrap(), Command::Describe { plus: false, pattern: "\"My Table\"".into() });
        assert_eq!(parse("\\l").unwrap(), Command::Databases { plus: false, pattern: None });
        assert_eq!(parse("\\dS").unwrap(), Command::Relations { kinds: vec![], plus: false, system: true, pattern: None });
        assert_eq!(parse("\\sf my_func(int, text)").unwrap(), Command::FunctionSource("my_func(int, text)".into()));
        assert_eq!(parse("\\?").unwrap(), Command::Help);
        assert_eq!(parse("\\conninfo").unwrap(), Command::Conninfo);
    }

    #[test]
    fn unsupported_and_dangerous_commands_are_rejected() {
        for bad in ["\\! ls", "\\i file.sql", "\\o out", "\\copy t to x", "\\g", "\\set a b", "\\cd /", "\\c other", "\\dt a b", "\\dt\n\\! ls", "select 1", "\\", "\\sf", "\\timing", "\\x"] {
            assert!(parse(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn patterns_follow_psql_rules() {
        assert_eq!(parse_pattern("users").unwrap(), NamePattern { schema: None, name: "users".into() });
        assert_eq!(parse_pattern("Users").unwrap().name, "users"); // folded to lower case
        assert_eq!(parse_pattern("\"Users\"").unwrap().name, "Users"); // quotes keep case
        assert_eq!(parse_pattern("us*").unwrap().name, "us.*");
        assert_eq!(parse_pattern("u?er").unwrap().name, "u.er");
        let p = parse_pattern("public.us*").unwrap();
        assert_eq!((p.schema.as_deref(), p.name.as_str()), (Some("public"), "us.*"));
        assert_eq!(parse_pattern("\"a.b\"").unwrap(), NamePattern { schema: None, name: "a\\.b".into() });
        assert_eq!(parse_pattern("a+b(c)").unwrap().name, "a\\+b\\(c\\)"); // regex characters are literal
        assert_eq!(parse_pattern("\"say \"\"hi\"\"\"").unwrap().name, "say \"hi\"");
        assert!(parse_pattern("\"open").is_err());
        assert!(parse_pattern("a.b.c.d").is_err());
        assert_eq!(parse_pattern("s.").unwrap().name, ".*");
    }

    #[test]
    fn literals_cannot_break_out() {
        assert_eq!(lit("a'b"), "E'a''b'");
        assert_eq!(lit("a\\"), "E'a\\\\'");
        let sql = relations_sql(&['t'], false, false, &Some("x'; drop table t; --".into())).unwrap();
        assert!(sql.contains("E'^(x''; drop table t; --)$'"), "{sql}");
    }

    #[test]
    fn default_listing_hides_system_schemas_and_uses_the_search_path() {
        let sql = relations_sql(&['t'], false, false, &None).unwrap();
        assert!(sql.contains("pg_table_is_visible(c.oid)"));
        assert!(sql.contains("<> 'pg_catalog'"));
        let sql = relations_sql(&['t'], false, true, &None).unwrap();
        assert!(!sql.contains("pg_catalog"));
        let sql = relations_sql(&['t'], false, false, &Some("public.*".into())).unwrap();
        assert!(sql.contains("n.nspname ~ E'^(public)$'"));
        assert!(!sql.contains("pg_table_is_visible"));
    }
}

/// Integration test against a real server. Skipped unless `SAURON_TEST_PG_PORT` is set
/// (see postgres.rs). Creates and drops a schema called `sauron_meta`.
#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::cancel::Registry;
    use crate::postgres;

    fn conn(read_only: bool) -> Option<ConnectionParams> {
        let port = std::env::var("SAURON_TEST_PG_PORT").ok()?;
        Some(
            serde_json::from_value(serde_json::json!({
                "id": "test", "host": "127.0.0.1", "port": port,
                "username": std::env::var("SAURON_TEST_PG_USER").unwrap_or_else(|_| "postgres".into()),
                "database": std::env::var("SAURON_TEST_PG_DB").unwrap_or_else(|_| "postgres".into()),
                "db_type": "postgres", "ssl_mode": "disable", "read_only": read_only, "timeout_secs": 0,
            }))
            .unwrap(),
        )
    }

    async fn sql(c: &ConnectionParams, statements: &[&str]) {
        let registry = Registry::default();
        let guard = registry.begin();
        let statements: Vec<String> = statements.iter().map(|s| s.to_string()).collect();
        postgres::execute(c, "", &statements, 100, &guard).await.unwrap();
    }

    async fn run(c: &ConnectionParams, text: &str) -> String {
        let registry = Registry::default();
        let guard = registry.begin();
        execute(c, "", text, &guard).await.unwrap_or_else(|e| panic!("{text}: {e}")).text
    }

    async fn run_err(c: &ConnectionParams, text: &str) -> String {
        let registry = Registry::default();
        let guard = registry.begin();
        execute(c, "", text, &guard).await.expect_err(text)
    }

    #[track_caller]
    fn has(text: &str, needle: &str) {
        assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
    }

    #[track_caller]
    fn lacks(text: &str, needle: &str) {
        assert!(!text.contains(needle), "unexpected {needle:?} in:\n{text}");
    }

    #[tokio::test]
    async fn catalog_commands_work_against_a_real_server() {
        let Some(rw) = conn(false) else { return };
        let ro = conn(true).unwrap();

        sql(&rw, &["drop schema if exists sauron_meta cascade"]).await;
        sql(
            &rw,
            &[
                "create schema sauron_meta",
                "create table sauron_meta.parent(id bigint generated always as identity primary key, name text not null unique, created timestamptz default now())",
                "create table sauron_meta.child(id serial primary key, parent_id bigint not null references sauron_meta.parent(id), qty int check (qty > 0), gen int generated always as (qty * 2) stored)",
                "create index child_qty_idx on sauron_meta.child (qty) where qty > 10",
                "create view sauron_meta.v as select id, name from sauron_meta.parent",
                "create materialized view sauron_meta.mv as select 1 as x",
                "create function sauron_meta.f(a int) returns int language sql as 'select a + 1'",
                "create function sauron_meta.trg() returns trigger language plpgsql as 'begin return new; end'",
                "create trigger child_trg before insert on sauron_meta.child for each row execute function sauron_meta.trg()",
                "create table sauron_meta.part(id int, d date) partition by range (d)",
                "create table sauron_meta.part_2024 partition of sauron_meta.part for values from ('2024-01-01') to ('2025-01-01')",
                "comment on table sauron_meta.parent is 'the parent'",
                "create table sauron_meta.\"Mixed Case\"(a int)",
            ],
        )
        .await;

        // --- lists: psql layout ---
        let t = run(&ro, "\\dt sauron_meta.ch*").await;
        assert!(t.starts_with("  "), "title is centered:\n{t}");
        has(&t, "List of tables");
        has(&t, "   Schema    | Name  | Type  | Owner\n-------------+-------+-------+--------\n sauron_meta | child | table | sauron\n(1 row)\n");
        has(&t, "-+-");
        has(&t, "| table | ");
        has(&t, "(1 row)");
        let t = run(&ro, "\\dt sauron_meta.*").await;
        for name in ["parent", "child", "part", "part_2024", "Mixed Case"] {
            has(&t, name);
        }
        lacks(&t, " v ");
        has(&run(&ro, "\\dt sauron_meta.\"Mixed Case\"").await, "Mixed Case");
        has(&run(&ro, "\\dt sauron_meta.PARENT").await, "parent"); // case folded
        // not on the search path => hidden, like psql
        lacks(&run(&ro, "\\dt").await, "sauron_meta");
        lacks(&run(&ro, "\\d").await, "sauron_meta");
        assert_eq!(run(&ro, "\\dt sauron_meta.nothing*").await, "Did not find any tables named \"sauron_meta.nothing*\".\n");
        has(&run(&ro, "\\dv sauron_meta.*").await, "| view ");
        has(&run(&ro, "\\dm sauron_meta.*").await, "| materialized view ");
        let t = run(&ro, "\\dtv sauron_meta.p*").await;
        has(&t, "(3 rows)"); // parent, part, part_2024
        let idx = run(&ro, "\\di sauron_meta.child*").await;
        has(&idx, "child_qty_idx");
        has(&idx, "| Table");
        let seq = run(&ro, "\\ds sauron_meta.*").await;
        has(&seq, "child_id_seq");
        has(&seq, "parent_id_seq");
        let plus = run(&ro, "\\dt+ sauron_meta.parent").await;
        has(&plus, "the parent");
        has(&plus, "Size");

        has(&run(&ro, "\\dn").await, "sauron_meta");
        lacks(&run(&ro, "\\dn").await, "pg_catalog");
        has(&run(&ro, "\\dnS").await, "pg_catalog");
        has(&run(&ro, "\\l").await, "List of databases");
        has(&run(&ro, "\\l+").await, "Tablespace");
        has(&run(&ro, "\\du").await, "List of roles");
        lacks(&run(&ro, "\\du").await, "Member of");
        has(&run(&ro, "\\dx").await, "plpgsql");
        has(&run(&ro, "\\dp sauron_meta.parent").await, "Access privileges");
        let f = run(&ro, "\\df sauron_meta.f").await;
        has(&f, "| integer          | a integer           | func");
        let info = run(&ro, "\\conninfo").await;
        has(&info, "Connection Information");
        has(&info, "Client User          | sauron");

        // --- describe: psql layout ---
        let child = run(&ro, "\\d sauron_meta.child").await;
        has(&child, "Table \"sauron_meta.child\"");
        has(&child, " Column ");
        has(&child, "| not null |");
        has(&child, "nextval('sauron_meta.child_id_seq'::regclass)");
        has(&child, "qty * 2");
        has(&child, "Indexes:\n    \"child_pkey\" PRIMARY KEY, btree (id)\n    \"child_qty_idx\" btree (qty) WHERE qty > 10\n");
        has(&child, "Check constraints:\n    \"child_qty_check\" CHECK (qty > 0)\n");
        has(&child, "Foreign-key constraints:\n    \"child_parent_id_fkey\" FOREIGN KEY (parent_id) REFERENCES sauron_meta.parent(id)\n");
        has(&child, "Triggers:\n    child_trg BEFORE INSERT ON sauron_meta.child FOR EACH ROW EXECUTE FUNCTION sauron_meta.trg()\n");
        lacks(&child, "(4 rows)"); // describe has no row-count footer

        let parent = run(&ro, "\\d+ sauron_meta.parent").await;
        has(&parent, "\"parent_name_key\" UNIQUE CONSTRAINT, btree (name)");
        has(&parent, "Referenced by:\n    TABLE \"sauron_meta.child\" CONSTRAINT \"child_parent_id_fkey\" FOREIGN KEY (parent_id) REFERENCES sauron_meta.parent(id)\n");
        has(&parent, "Storage");
        has(&parent, "Access method: heap");
        has(&parent, "generated always as identity");

        let view = run(&ro, "\\d+ sauron_meta.v").await;
        has(&view, "View \"sauron_meta.v\"");
        has(&view, "View definition:\n SELECT ");
        has(&view, "\n   FROM sauron_meta.parent;\n");
        let part = run(&ro, "\\d sauron_meta.part").await;
        has(&part, "Partitioned table \"sauron_meta.part\"");
        has(&part, "Partition key: RANGE (d)");
        has(&part, "Number of partitions: 1 (Use \\d+ to list them.)");
        has(&run(&ro, "\\d+ sauron_meta.part").await, "Partitions: sauron_meta.part_2024 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')");
        has(&run(&ro, "\\d sauron_meta.part_2024").await, "Partition of: sauron_meta.part FOR VALUES FROM");
        let sequence = run(&ro, "\\d sauron_meta.child_id_seq").await;
        has(&sequence, "Sequence \"sauron_meta.child_id_seq\"");
        has(&sequence, "| Cycles? | Cache");
        has(&sequence, "Owned by: sauron_meta.child.id");
        has(&run(&ro, "\\d sauron_meta.parent_id_seq").await, "Sequence for identity column: sauron_meta.parent.id");
        let index = run(&ro, "\\d sauron_meta.child_qty_idx").await;
        has(&index, "Index \"sauron_meta.child_qty_idx\"");
        has(&index, "| Key? |");
        has(&index, "btree, for table \"sauron_meta.child\", predicate (qty > 10)");
        has(&run(&ro, "\\d sauron_meta.parent_pkey").await, "primary key, btree, for table \"sauron_meta.parent\"");
        // several matches are separated by a blank line
        let many = run(&ro, "\\d sauron_meta.pa*").await;
        has(&many, "Table \"sauron_meta.parent\"");
        has(&many, "Partitioned table \"sauron_meta.part\"");
        has(&many, "\n\n");

        let err = run_err(&ro, "\\d sauron_meta.nope").await;
        has(&err, "Did not find any relation");

        // --- source ---
        has(&run(&ro, "\\sf sauron_meta.f").await, "CREATE OR REPLACE FUNCTION sauron_meta.f");
        has(&run(&ro, "\\sf sauron_meta.f(integer)").await, "CREATE OR REPLACE FUNCTION");
        has(&run(&ro, "\\sv sauron_meta.v").await, "CREATE OR REPLACE VIEW sauron_meta.v AS");

        // --- safety ---
        // a hostile pattern is just a pattern: nothing is dropped
        run(&ro, "\\dt sauron_meta.x';drop").await;
        run_err(&ro, "\\d \"x'; drop table sauron_meta.parent; --\"").await;
        has(&run(&ro, "\\dt sauron_meta.parent").await, "parent");
        assert!(run_err(&ro, "\\! ls").await.contains("not supported"));

        sql(&rw, &["drop schema sauron_meta cascade"]).await;
    }
}

/// Prints our output for the commands in `SAURON_DUMP_CMDS` (one per line, `||`-separated) so it can be
/// diffed against real psql: `SAURON_TEST_PG_PORT=.. SAURON_DUMP_CMDS='\dt||\d t' cargo test dump -- --ignored --nocapture`
#[cfg(test)]
mod dump {
    use super::*;
    use crate::cancel::Registry;

    #[tokio::test]
    #[ignore]
    async fn dump_for_comparison() {
        let (Ok(port), Ok(commands)) = (std::env::var("SAURON_TEST_PG_PORT"), std::env::var("SAURON_DUMP_CMDS")) else { return };
        let conn: ConnectionParams = serde_json::from_value(serde_json::json!({
            "id": "x", "host": "127.0.0.1", "port": port,
            "username": std::env::var("SAURON_TEST_PG_USER").unwrap_or_else(|_| "postgres".into()),
            "database": "postgres", "db_type": "postgres", "ssl_mode": "disable", "read_only": true, "timeout_secs": 0,
        }))
        .unwrap();
        for command in commands.split("||") {
            let registry = Registry::default();
            let guard = registry.begin();
            let out = execute(&conn, "", command, &guard).await.map(|o| o.text).unwrap_or_else(|e| format!("ERROR: {e}\n"));
            println!("@@@ {command}\n{out}@@@END");
        }
    }
}
