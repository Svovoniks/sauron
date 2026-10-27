import { useMemo, useState } from "react";
import { agentSummary, filterAgentEntries, TOOL_LABEL, type AgentEntry, type AgentFilter } from "../lib/agentLog";
import { dayLabel, formatDuration, timeLabel } from "../lib/history";
import { CheckIcon, CopyIcon, EditIcon, InfoIcon, SearchIcon, ShieldIcon, TableIcon, WarningIcon } from "./icons";

interface AgentPanelProps {
  entries: AgentEntry[];
  activeConnectionId: string | null;
  onOpenResult: (entry: AgentEntry) => void;
  onEdit: (entry: AgentEntry) => void;
  onCopy: (text: string) => void;
  onClear: () => void;
  onSetup: () => void;
}

const STATUS_ICON = { ok: <CheckIcon />, error: <WarningIcon />, blocked: <ShieldIcon size={13} /> } as const;
const STATUS_TITLE = { ok: "Succeeded", error: "Failed", blocked: "Refused: writes are not allowed" } as const;

/** Every call an AI agent made through `sauron --mcp`, with what it ran and what it got back. */
export function AgentPanel(props: AgentPanelProps) {
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const visible = useMemo(
    () => filterAgentEntries(props.entries, filter, query, props.activeConnectionId),
    [props.entries, filter, query, props.activeConnectionId],
  );
  let lastDay = "";

  return (
    <div className="history-panel agent-panel">
      <div className="panel-tools">
        <label className="panel-search">
          <SearchIcon />
          <input aria-label="Search agent activity" onChange={(event) => setQuery(event.target.value)} placeholder="Search agent activity" spellCheck={false} value={query} />
        </label>
        <div className="chips" role="group" aria-label="Agent activity filter">
          {(
            [
              ["all", "All"],
              ["queries", "Queries"],
              ["problems", "Errors & refused"],
              ["connection", "This connection"],
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
          const open = expanded === entry.id;
          const status = entry.status in STATUS_ICON ? entry.status : "error";
          const toggle = () => setExpanded(open ? null : entry.id);
          return (
            <div key={entry.id}>
              {header}
              <div className={`h-item ${open ? "active" : ""}`} onClick={toggle} onKeyDown={(event) => event.key === "Enter" && toggle()} role="button" tabIndex={0}>
                <div className={`h-status ${status}`} title={STATUS_TITLE[status]}>
                  {STATUS_ICON[status]}
                </div>
                <div className="h-main">
                  <div className={`h-sql ${open ? "full" : ""}`}>{agentSummary(entry)}</div>
                  {!open && entry.status !== "ok" && entry.output ? <div className="h-err">{entry.output.split("\n")[0]}</div> : null}
                  <div className="h-meta">
                    {entry.tool !== "query" ? <span className="h-tool">{TOOL_LABEL[entry.tool] ?? entry.tool}</span> : null}
                    {entry.connection_name ? <span className="h-conn">{entry.connection_name}</span> : null}
                    <span>{timeLabel(entry.at)}</span>
                    <span>· {formatDuration(entry.ms)}</span>
                    {entry.rows !== null ? (
                      <span>
                        · {entry.rows.toLocaleString("en-US")}
                        {entry.truncated ? "+" : ""} {entry.rows === 1 ? "row" : "rows"}
                      </span>
                    ) : null}
                    {entry.client ? <span>· {entry.client}</span> : null}
                  </div>
                  {open ? (
                    <div className="agent-detail" onClick={(event) => event.stopPropagation()}>
                      {entry.rows !== null ? (
                        <button className="btn agent-open" onClick={() => props.onOpenResult(entry)} type="button">
                          <TableIcon size={13} /> Open the {entry.rows.toLocaleString("en-US")} row{entry.rows === 1 ? "" : "s"} it got
                        </button>
                      ) : (
                        <>
                          <div className="agent-detail-label">{entry.status === "ok" ? "What the agent got" : entry.status === "blocked" ? "Refused, the agent was told" : "Error the agent got"}</div>
                          <pre className={`agent-output ${entry.status}`}>{entry.output || "(nothing)"}</pre>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
                {entry.sql ? (
                  <div className="h-actions">
                    {entry.tool === "query" ? (
                      <button aria-label="Open in a new tab" onClick={(event) => { event.stopPropagation(); props.onEdit(entry); }} title="Open the SQL in a new tab" type="button">
                        <EditIcon />
                      </button>
                    ) : null}
                    <button aria-label="Copy SQL" onClick={(event) => { event.stopPropagation(); props.onCopy(entry.sql); }} title="Copy SQL" type="button">
                      <CopyIcon />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {visible.length === 0 ? (
          <div className="sidebar-empty">
            {props.entries.length === 0 ? (
              <>
                <b>No agent activity yet</b>
                <span>When an AI agent uses Sauron through MCP, every query it runs and the result it got show up here, live.</span>
                <button className="btn" onClick={props.onSetup} type="button">
                  Set up an agent
                </button>
              </>
            ) : (
              <span>No calls match.</span>
            )}
          </div>
        ) : null}
      </div>
      <div className="panel-foot">
        <InfoIcon size={12} />
        <span>Last 500 calls, kept like query history.</span>
        <span className="sp" />
        {props.entries.length > 0 ? (
          <button onClick={props.onClear} type="button">
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
