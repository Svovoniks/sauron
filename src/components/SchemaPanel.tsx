import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SchemaState } from "../hooks/useSchema";
import { formatBytes, formatCount, qualifiedName, quoteIdent, type SchemaColumn, type SchemaFunction, type SchemaTable } from "../lib/schema";
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

/** One line of the tree. The tree is flattened and virtualized: a database can have thousands of tables, and every re-render of the app used to walk all of them. */
type TreeRow =
  | { type: "section"; key: string; label: string; count: number; collapsed: boolean }
  | { type: "table"; key: string; table: SchemaTable; open: boolean }
  | { type: "loading"; key: string }
  | { type: "column"; key: string; column: SchemaColumn }
  | { type: "function"; key: string; fn: SchemaFunction };

const SECTION: Record<string, string> = { table: "Tables", view: "Views", matview: "Materialized views", foreign: "Foreign tables" };
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

  const treeRows = useMemo(() => {
    const matches = (table: SchemaTable) => !q || table.name.toLowerCase().includes(q) || table.columns.some((c) => c.name.toLowerCase().includes(q));
    const out: TreeRow[] = [];
    for (const kind of ["table", "view", "matview", "foreign"] as const) {
      const items = tables.filter((t) => t.kind === kind && matches(t));
      if (items.length === 0) continue;
      const isCollapsed = collapsed.has(kind);
      out.push({ type: "section", key: `sec-${kind}`, label: SECTION[kind], count: items.length, collapsed: isCollapsed });
      if (isCollapsed) continue;
      for (const table of items) {
        const key = `${table.schema}.${table.name}`;
        const nameMatches = !q || table.name.toLowerCase().includes(q);
        const isOpen = open.has(key) || (q !== "" && !nameMatches);
        out.push({ type: "table", key, table, open: isOpen });
        if (!isOpen) continue;
        const columns = q && !nameMatches ? table.columns.filter((c) => c.name.toLowerCase().includes(q)) : table.columns;
        if (columns.length === 0 && state.columnsLoading) out.push({ type: "loading", key: `${key}#loading` });
        for (const column of columns) out.push({ type: "column", key: `${key}#${column.name}`, column });
      }
    }
    const visibleFunctions = functions.filter((f) => !q || f.name.toLowerCase().includes(q));
    if (visibleFunctions.length > 0) {
      const isCollapsed = collapsed.has("fn");
      out.push({ type: "section", key: "sec-fn", label: "Functions", count: visibleFunctions.length, collapsed: isCollapsed });
      if (!isCollapsed) for (const fn of visibleFunctions) out.push({ type: "function", key: `${fn.name}(${fn.args})`, fn });
    }
    return out;
  }, [tables, functions, q, open, collapsed, state.columnsLoading]);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: (index) => (treeRows[index]?.type === "column" ? 24 : treeRows[index]?.type === "section" ? 26 : 28),
    getItemKey: (index) => treeRows[index]?.key ?? index,
    overscan: 14,
  });

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

  const renderRow = (row: TreeRow) => {
    switch (row.type) {
      case "section": {
        const toggleKey = row.key.slice(4);
        return (
          <div className="t-sec" onClick={() => toggleSection(toggleKey)} onKeyDown={(e) => e.key === "Enter" && toggleSection(toggleKey)} role="button" tabIndex={0}>
            <span className={`tw ${row.collapsed ? "" : "open"}`}>
              <ChevronRightIcon size={11} />
            </span>
            {row.label}
            <span className="n">{row.count}</span>
          </div>
        );
      }
      case "table": {
        const { table } = row;
        return (
          <div className={`t-row ${table.kind !== "table" ? "view" : ""} ${row.open ? "open" : ""}`} onClick={() => toggle(row.key)} onDoubleClick={() => onSelectAll(table)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && toggle(row.key)}>
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
        );
      }
      case "loading":
        return (
          <div className="t-col muted">
            <span className="mini-spinner" /> loading columns…
          </div>
        );
      case "column": {
        const { column } = row;
        return (
          <div className="t-col" onClick={() => onInsert(quoteIdent(column.name, schema!.dbType))} title={`Click to insert · ${column.type}${column.nullable ? " · nullable" : " · not null"}`} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onInsert(quoteIdent(column.name, schema!.dbType))}>
            <span className={`k ${column.key}`}>{column.key === "pk" ? <KeyIcon size={11} /> : column.key === "fk" ? <LinkIcon size={11} /> : null}</span>
            <span className="t-col-name">{column.name}</span>
            {column.nullable ? <span className="nn">null</span> : null}
            <span className="ct">{column.type}</span>
          </div>
        );
      }
      case "function": {
        const { fn } = row;
        return (
          <div className="t-row fn" onClick={() => onInsert(`${fn.name}(`)} title={`${fn.name}(${fn.args}) → ${fn.returns}`} role="button" tabIndex={0}>
            <span className="tw" />
            <span className="ti">
              <FunctionIcon />
            </span>
            <span className="t-name">{fn.name}({fn.args.length > 18 ? "…" : fn.args})</span>
            <span className="t-meta">→ {fn.returns}</span>
          </div>
        );
      }
    }
  };

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
      <div className="tree" ref={treeRef}>
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
        {treeRows.length > 0 ? (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div data-index={item.index} key={item.key} ref={virtualizer.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
                {renderRow(treeRows[item.index])}
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
