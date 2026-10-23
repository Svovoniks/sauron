import { useMemo, useState } from "react";
import { dayLabel, formatDuration, timeLabel, type HistoryEntry } from "../lib/history";
import type { Connection } from "../types/app";
import { CheckIcon, EditIcon, InfoIcon, PlayIcon, SaveIcon, SearchIcon, StopIcon, WarningIcon } from "./icons";

type Filter = "all" | "connection" | "errors" | "saved";

interface HistoryPanelProps {
  entries: HistoryEntry[];
  connections: Connection[];
  activeConnectionId: string | null;
  /** Normalised SQL text of every saved query (the "Saved" filter and the filled save icon). */
  savedTexts: Set<string>;
  keepLabel: string;
  activeEntryId: string | null;
  onRestore: (entry: HistoryEntry) => void;
  onRerun: (entry: HistoryEntry) => void;
  onSave: (entry: HistoryEntry) => void;
  onOpenSettings: () => void;
}

export const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

const STATUS_ICON = { ok: <CheckIcon />, error: <WarningIcon />, cancelled: <StopIcon size={13} /> } as const;

export function HistoryPanel(props: HistoryPanelProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.entries.filter(
      (entry) =>
        (filter === "all" ||
          (filter === "errors" && entry.status === "error") ||
          (filter === "connection" && entry.connectionId === props.activeConnectionId) ||
          (filter === "saved" && props.savedTexts.has(normalizeSql(entry.sql)))) &&
        (!q || entry.sql.toLowerCase().includes(q) || (entry.error ?? "").toLowerCase().includes(q)),
    );
  }, [props.entries, props.activeConnectionId, props.savedTexts, filter, query]);

  const nameOf = (entry: HistoryEntry) => props.connections.find((c) => c.id === entry.connectionId)?.name ?? entry.connectionName ?? "";
  let lastDay = "";

  return (
    <div className="history-panel">
      <div className="panel-tools">
        <label className="panel-search">
          <SearchIcon />
          <input aria-label="Search history" onChange={(event) => setQuery(event.target.value)} placeholder="Search history" spellCheck={false} value={query} />
        </label>
        <div className="chips" role="group" aria-label="History filter">
          {(
            [
              ["all", "All"],
              ["connection", "This connection"],
              ["errors", "Errors"],
              ["saved", "Saved"],
            ] as const
          ).map(([id, label]) => (
            <button aria-pressed={filter === id} className={`chip ${filter === id ? "active" : ""}`} key={id} onClick={() => setFilter(id)} type="button">
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="history-list">
        {visible.map((entry) => {
          const day = dayLabel(entry.at);
          const header = day !== lastDay ? <div className="h-group">{(lastDay = day)}</div> : null;
          const saved = props.savedTexts.has(normalizeSql(entry.sql));
          return (
            <div key={entry.id}>
              {header}
              <div className={`h-item ${props.activeEntryId === entry.id ? "active" : ""}`} onClick={() => props.onRestore(entry)} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && props.onRestore(entry)}>
                <div className={`h-status ${entry.status}`}>{STATUS_ICON[entry.status]}</div>
                <div className="h-main">
                  <div className="h-sql">{entry.sql}</div>
                  {entry.error ? <div className="h-err">{entry.error.split("\n")[0]}</div> : null}
                  <div className="h-meta">
                    <span className="h-conn">{nameOf(entry)}</span>
                    <span>{timeLabel(entry.at)}</span>
                    <span>· {formatDuration(entry.ms)}</span>
                    {entry.rows !== null ? (
                      <span>
                        · {entry.rows.toLocaleString("en-US")}
                        {entry.truncated ? "+" : ""} {entry.affected ? "affected" : entry.rows === 1 ? "row" : "rows"}
                      </span>
                    ) : null}
                    {entry.status === "cancelled" ? <span>· cancelled</span> : null}
                  </div>
                </div>
                <div className="h-actions">
                  <button aria-label="Put in editor" onClick={(event) => { event.stopPropagation(); props.onRestore(entry); }} title="Put in editor" type="button">
                    <EditIcon />
                  </button>
                  <button aria-label="Run again" onClick={(event) => { event.stopPropagation(); props.onRerun(entry); }} title="Run again" type="button">
                    <PlayIcon size={12} />
                  </button>
                  <button aria-label="Save as query" className={saved ? "on" : ""} disabled={saved} onClick={(event) => { event.stopPropagation(); props.onSave(entry); }} title={saved ? "Already saved" : "Save as query"} type="button">
                    <SaveIcon />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {visible.length === 0 ? (
          <div className="sidebar-empty">
            {props.entries.length === 0 ? (
              <>
                <b>No history yet</b>
                <span>Every query you run shows up here, with its connection, time and duration. Results are never stored.</span>
              </>
            ) : (
              <span>No runs match.</span>
            )}
          </div>
        ) : null}
      </div>
      <div className="panel-foot">
        <InfoIcon size={12} />
        <span>{props.keepLabel}</span>
        <span className="sp" />
        <button onClick={props.onOpenSettings} type="button">
          Change
        </button>
      </div>
    </div>
  );
}

