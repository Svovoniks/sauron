import type { ConnStatus } from "../hooks/useConnectionStatus";
import { comboText } from "../lib/settings";
import { formatDuration } from "../lib/history";
import type { Connection } from "../types/app";
import type { TabRun } from "../types/workspace";
import { ClockIcon, GearIcon, InfoIcon } from "./icons";

interface StatusBarProps {
  connection: Connection | null;
  status: ConnStatus;
  run: TabRun | null;
  rowLimit: number;
  settingsShortcut: string;
  onOpenSettings: (section?: "results" | "connections") => void;
}

export function StatusBar({ connection, status, run, rowLimit, settingsShortcut, onOpenSettings }: StatusBarProps) {
  const last = run && run.status === "done" && !run.error && !run.meta ? run.sets[run.sets.length - 1] : null;
  const lastText = last?.result
    ? last.result.columns.length > 0
      ? `${last.result.rows.length.toLocaleString("en-US")}${last.result.truncated ? "+" : ""} row${last.result.rows.length === 1 && !last.result.truncated ? "" : "s"} · ${formatDuration(last.elapsedMs)}`
      : `${last.result.message ?? "done"} · ${formatDuration(last.elapsedMs)}`
    : null;
  const finished = run?.finishedAt ? new Date(run.finishedAt).toTimeString().slice(0, 5) : null;

  return (
    <div className="status-bar" role="status">
      {connection ? (
        <>
          <span className="item">
            <span className={`conn-dot ${status.state}`} />
            {connection.name || "Unnamed"}
          </span>
          {status.version ? <span className="item">{status.version}</span> : <span className="item">{connection.db_type === "postgres" ? "Postgres" : "ClickHouse"}</span>}
          <span className="item" title="Per-statement timeout of this connection">
            <ClockIcon size={12} />
            {connection.timeout_secs > 0 ? `timeout ${connection.timeout_secs} s` : "no timeout"}
          </span>
        </>
      ) : (
        <span className="item">Not connected</span>
      )}
      {lastText ? <span className="item">{lastText}</span> : null}
      {finished && lastText ? (
        <span className="item rec">
          <InfoIcon size={12} />
          last run {finished}
        </span>
      ) : null}
      <span className="sp" />
      <button className="item" onClick={() => onOpenSettings("results")} title="Change the row limit" type="button">
        Row limit <b>{rowLimit.toLocaleString("en-US")}</b>
      </button>
      <button aria-label="Settings" className="item" onClick={() => onOpenSettings()} title={`Settings (${comboText(settingsShortcut)})`} type="button">
        <GearIcon size={13} />
        <kbd>{comboText(settingsShortcut)}</kbd>
      </button>
    </div>
  );
}
