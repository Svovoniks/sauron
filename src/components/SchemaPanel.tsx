import { useEffect, useMemo, useState } from "react";
import type { SchemaState } from "../hooks/useSchema";
import { formatBytes, formatCount, qualifiedName, quoteIdent, type SchemaTable } from "../lib/schema";
import { relativeTime } from "../lib/sql/analyze";
import type { Connection } from "../types/app";
import { ChevronRightIcon, ClockIcon, CopyIcon, DatabaseIcon, FunctionIcon, InfoIcon, KeyIcon, LinkIcon, PlayIcon, RefreshIcon, SearchIcon, TableIcon } from "./icons";

interface SchemaPanelProps {
  connection: Connection | null;
  state: SchemaState;
  onLoad: (force: boolean) => void;
  onInsert: (text: string) => void;
  onSelectAll: (table: SchemaTable) => void;
  onDescribe: (table: SchemaTable) => void;
  onCopy: (text: string) => void;
}

const KIND_LABEL = { table: "table", view: "view", matview: "mat. view", foreign: "foreign" } as const;

export function SchemaPanel({ connection, state, onLoad, onInsert, onSelectAll, onDescribe, onCopy }: SchemaPanelProps) {
  const { schema } = state;
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // First time the panel is shown for a connection: load.
  useEffect(() => {
    if (connection && (!schema || state.cached) && !state.loading && !state.error) onLoad(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);

  const defaultSchema = useMemo(() => {
    if (!schema) return "public";
    if (schema.dbType === "clickhouse") return connection?.database || schema.schemas[0] || "default";
    return schema.schemas.includes("public") ? "public" : (schema.schemas[0] ?? "public");
  }, [schema, connection?.database]);
  const current = selected && schema?.schemas.includes(selected) ? selected : defaultSchema;

  const q = query.trim().toLowerCase();
  const tables = useMemo(() => (schema?.tables ?? []).filter((t) => t.schema === current), [schema, current]);
  const functions = useMemo(() => (schema?.functions ?? []).filter((f) => f.schema === current), [schema, current]);

  const matches = (table: SchemaTable) => !q || table.name.toLowerCase().includes(q) || table.columns.some((c) => c.name.toLowerCase().includes(q));
  const tableGroups = (["table", "view", "matview", "foreign"] as const)
    .map((kind) => ({ kind, items: tables.filter((t) => t.kind === kind && matches(t)) }))
    .filter((g) => g.items.length > 0);
  const visibleFunctions = functions.filter((f) => !q || f.name.toLowerCase().includes(q));

  if (!connection) {
    return (
      <div className="schema-panel">
        <div className="sidebar-empty">
          <b>No connection</b>
          <span>Add a connection to browse its tables.</span>
        </div>
      </div>
    );
  }

  const toggle = (key: string) => setOpen((o) => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleSection = (key: string) => setCollapsed((o) => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const renderTable = (table: SchemaTable) => {
    const key = `${table.schema}.${table.name}`;
    const nameMatches = !q || table.name.toLowerCase().includes(q);
    const isOpen = open.has(key) || (q !== "" && !nameMatches);
    const columns = q && !nameMatches ? table.columns.filter((c) => c.name.toLowerCase().includes(q)) : table.columns;
    return (
      <div key={key}>
        <div className={`t-row ${table.kind !== "table" ? "view" : ""} ${isOpen ? "open" : ""}`} onClick={() => toggle(key)} onDoubleClick={() => onSelectAll(table)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && toggle(key)}>
          <span className="tw">
            <ChevronRightIcon size={12} />
          </span>
          <span className="ti">{table.kind === "table" ? <TableIcon /> : <InfoIcon />}</span>
          <span className="t-name">{table.name}</span>
          <span className="t-meta" title={`${table.rows !== null ? `~${table.rows.toLocaleString("en-US")} rows` : ""}${table.bytes ? ` · ${formatBytes(table.bytes)}` : ""}`}>
            {table.kind === "table" ? (table.rows !== null ? formatCount(table.rows) : "") : KIND_LABEL[table.kind]}
          </span>
          <span className="t-actions">
            <button aria-label={`Select from ${table.name}`} onClick={(e) => { e.stopPropagation(); onSelectAll(table); }} title="select * … limit 100" type="button">
              <PlayIcon size={11} />
            </button>
            <button aria-label={`Describe ${table.name}`} onClick={(e) => { e.stopPropagation(); onDescribe(table); }} title={schema?.dbType === "postgres" ? "Describe (\\d)" : "DESCRIBE TABLE"} type="button">
              <InfoIcon size={13} />
            </button>
            <button aria-label={`Copy name of ${table.name}`} onClick={(e) => { e.stopPropagation(); onCopy(qualifiedName(table, schema!.dbType, defaultSchema)); }} title="Copy name" type="button">
              <CopyIcon />
            </button>
          </span>
        </div>
        {isOpen && columns.length === 0 && state.columnsLoading ? (
          <div className="t-col muted">
            <span className="mini-spinner" /> loading columns…
          </div>
        ) : null}
        {isOpen
          ? columns.map((column) => (
              <div className="t-col" key={column.name} onClick={() => onInsert(quoteIdent(column.name, schema!.dbType))} title={`Click to insert · ${column.type}${column.nullable ? " · nullable" : " · not null"}`} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onInsert(quoteIdent(column.name, schema!.dbType))}>
                <span className={`k ${column.key}`}>{column.key === "pk" ? <KeyIcon size={11} /> : column.key === "fk" ? <LinkIcon size={11} /> : null}</span>
                <span className="t-col-name">{column.name}</span>
                {column.nullable ? <span className="nn">null</span> : null}
                <span className="ct">{column.type}</span>
              </div>
            ))
          : null}
      </div>
    );
  };

  const SECTION: Record<string, string> = { table: "Tables", view: "Views", matview: "Materialized views", foreign: "Foreign tables" };

  return (
    <div className="schema-panel">
      <div className="panel-tools">
        <div className="schema-select-row">
          <select aria-label={schema?.dbType === "clickhouse" ? "Database" : "Schema"} disabled={!schema} onChange={(e) => setSelected(e.target.value)} value={current}>
            {(schema?.schemas.length ? schema.schemas : [current]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button aria-label="Reload schema" className="panel-icon-button" disabled={state.loading} onClick={() => onLoad(true)} title="Reload schema" type="button">
            <RefreshIcon />
          </button>
        </div>
        <label className="panel-search">
          <SearchIcon />
          <input aria-label="Find table or column" onChange={(event) => setQuery(event.target.value)} placeholder="Find table or column" spellCheck={false} value={query} />
        </label>
      </div>
      <div className="tree">
        {state.loading && !schema ? (
          <div className="sidebar-empty">
            <span className="mini-spinner" />
            <span>Reading the catalog…</span>
          </div>
        ) : null}
        {state.error ? (
          <div className="sidebar-empty error">
            <b>Could not load the schema</b>
            <span>{state.error.split("\n")[0]}</span>
            <button className="chip" onClick={() => onLoad(true)} type="button">
              Try again
            </button>
          </div>
        ) : null}
        {schema && tables.length === 0 && functions.length === 0 ? (
          <div className="sidebar-empty">
            <b>Nothing here</b>
            <span>No tables or views in “{current}”.</span>
          </div>
        ) : null}
        {tableGroups.map(({ kind, items }) => (
          <div key={kind}>
            <div className="t-sec" onClick={() => toggleSection(kind)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && toggleSection(kind)}>
              <span className={`tw ${collapsed.has(kind) ? "" : "open"}`}>
                <ChevronRightIcon size={11} />
              </span>
              {SECTION[kind]}
              <span className="n">{items.length}</span>
            </div>
            {collapsed.has(kind) ? null : items.map(renderTable)}
          </div>
        ))}
        {visibleFunctions.length > 0 ? (
          <div>
            <div className="t-sec" onClick={() => toggleSection("fn")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && toggleSection("fn")}>
              <span className={`tw ${collapsed.has("fn") ? "" : "open"}`}>
                <ChevronRightIcon size={11} />
              </span>
              Functions
              <span className="n">{visibleFunctions.length}</span>
            </div>
            {collapsed.has("fn")
              ? null
              : visibleFunctions.map((fn) => (
                  <div className="t-row fn" key={`${fn.name}(${fn.args})`} onClick={() => onInsert(`${fn.name}(`)} title={`${fn.name}(${fn.args}) → ${fn.returns}`} role="button" tabIndex={0}>
                    <span className="tw" />
                    <span className="ti">
                      <FunctionIcon />
                    </span>
                    <span className="t-name">{fn.name}({fn.args.length > 18 ? "…" : fn.args})</span>
                    <span className="t-meta">→ {fn.returns}</span>
                  </div>
                ))}
          </div>
        ) : null}
      </div>
      <div className="panel-foot">
        {schema ? (
          <>
            <ClockIcon size={12} />
            <span>
              {state.loading ? (state.columnsLoading ? "Reading columns…" : state.cached ? "Refreshing…" : "Reading…") : `Loaded ${relativeTime(schema.loadedAt)}`} · {connection.database || connection.host}
            </span>
          </>
        ) : (
          <>
            <DatabaseIcon size={12} />
            <span>{connection.name || "Unnamed"}</span>
          </>
        )}
      </div>
    </div>
  );
}
