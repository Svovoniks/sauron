import { useEffect, useState } from "react";
import { describeError, errorSnippet, quickFix } from "../lib/errors";
import { formatDuration } from "../lib/history";
import type { Schema } from "../lib/schema";
import { comboText } from "../lib/settings";
import { SauronEye } from "./SauronEye";
import type { ResultSet, TabRun } from "../types/workspace";
import { BoltIcon, CheckIcon, ClockIcon, CopyIcon, InfoIcon, PlayIcon, PlugIcon, SparkleIcon, StopIcon, WarningIcon } from "./icons";

export interface ErrorActions {
  onJumpToError: (set: ResultSet) => void;
  onApplyFix: (set: ResultSet, from: string, to: string) => void;
  onExplain: (set: ResultSet) => void;
  onRunWithTimeout: (secs: number) => void;
  onRetry: () => void;
  onOpenSettings: (section: "connections" | "results" | "editor" | "psql") => void;
  onCopy: (text: string) => void;
}

interface ErrorCardProps {
  message: string;
  code: string | null;
  position: number | null;
  /** The statement that failed (for the snippet); null when the whole run failed. */
  set: ResultSet | null;
  timeoutSecs: number;
  connectionName: string;
  schema: Schema | null;
  actions: ErrorActions;
}

export function ErrorCard({ message, code, position, set, timeoutSecs, connectionName, schema, actions }: ErrorCardProps) {
  const view = describeError({ message, code, position }, timeoutSecs);
  const snippet = set ? errorSnippet(set.sql, position) : null;
  const fix = view.kind === "error" ? quickFix(message, schema) : null;
  const [showLong, setShowLong] = useState(false);
  const connectionFailed = view.kind === "error" && !code && /error connecting|connection refused|connection reset|timed out|no such host|lookup|unreachable|closed/i.test(message);

  const icon = view.kind === "timeout" ? <ClockIcon size={18} /> : connectionFailed ? <PlugIcon size={18} /> : view.kind === "cancelled" ? <StopIcon size={16} /> : <WarningIcon className="error-card-icon" />;

  return (
    <div className={`err-card ${view.kind}`} role="alert">
      <div className="err-head">
        <span className="err-icon">{icon}</span>
        <b>{connectionFailed ? `Could not reach ${connectionName || "the database"}` : view.title}</b>
        <span className="sp" />
        {view.code ? <code>{view.code.startsWith("CH ") ? view.code : `SQLSTATE ${view.code}`}</code> : null}
        <button aria-label="Copy error" className="err-copy" onClick={() => actions.onCopy(message)} title="Copy error" type="button">
          <CopyIcon />
        </button>
      </div>
      <div className="err-body">
        {view.detail ? <pre className={`err-detail ${showLong ? "" : "clamped"}`} onClick={() => setShowLong(true)}>{view.detail}</pre> : null}
        {connectionFailed ? <pre className="err-detail">{message}</pre> : null}
        {snippet ? (
          <div className="err-snip">
            <div>
              <span className="gl">{snippet.line}</span>
              {snippet.text}
            </div>
            <div className="ptr">
              <span className="gl" />
              {" ".repeat(snippet.column)}
              {"^".repeat(Math.min(snippet.length, 40))}
            </div>
          </div>
        ) : null}
        {fix && set ? (
          <div className="fix">
            <SparkleIcon size={16} />
            <span>
              Did you mean <b className="mono">{fix.to}</b>?
            </span>
            <span className="sp" />
            <button className="btn primary" onClick={() => actions.onApplyFix(set, fix.from, fix.to)} type="button">
              Replace and run
            </button>
          </div>
        ) : null}
        {view.kind === "timeout" ? (
          <div className="fix">
            <InfoIcon size={16} />
            <span>
              Try narrowing the date range, or check the plan with <b className="mono">explain</b>.
            </span>
            <span className="sp" />
            {set ? (
              <button className="btn" onClick={() => actions.onExplain(set)} type="button">
                Explain
              </button>
            ) : null}
          </div>
        ) : null}
        {connectionFailed ? (
          <div className="fix">
            <BoltIcon size={16} />
            <span>Check the host, port and TLS mode of this connection, then try again.</span>
            <span className="sp" />
            <button className="btn primary" onClick={actions.onRetry} type="button">
              Retry now
            </button>
          </div>
        ) : null}
        <div className="err-more">
          {snippet && set ? (
            <>
              <span className="muted">
                Line {snippet.line}, column {snippet.column + 1} ·
              </span>
              <button onClick={() => actions.onJumpToError(set)} type="button">
                Jump to line
              </button>
            </>
          ) : null}
          {view.kind === "timeout" ? (
            <>
              <button onClick={() => actions.onRunWithTimeout(300)} type="button">
                Run once with a 5 min timeout
              </button>
              <button onClick={() => actions.onOpenSettings("connections")} type="button">
                Change default timeout
              </button>
            </>
          ) : null}
          {view.kind === "readonly" ? (
            <button onClick={() => actions.onOpenSettings("connections")} type="button">
              About read-only connections
            </button>
          ) : null}
          {view.kind === "cancelled" ? (
            <button onClick={actions.onRetry} type="button">
              Run again
            </button>
          ) : null}
          <button onClick={() => actions.onCopy(message)} type="button">
            Copy full error
          </button>
        </div>
      </div>
    </div>
  );
}

interface RunningStateProps {
  run: TabRun;
  timeoutSecs: number;
  onCancel: () => void;
  abortShortcut: string;
}

/** The watching eye + elapsed time while a query runs. After a few seconds it says so and offers Cancel. */
export function RunningState({ run, timeoutSecs, onCancel, abortShortcut }: RunningStateProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = now - run.startedAt;
  return (
    <div className="running-state">
      <div className="slow-info">
        <span className="mini-spinner" />
        <span>
          Running on <b>{run.connectionName}</b> for <b className="tabular">{(elapsed / 1000).toFixed(1)} s</b>
        </span>
        <span className="sp" />
        {timeoutSecs > 0 ? <span>timeout {timeoutSecs} s</span> : <span>no timeout</span>}
      </div>
      <div className="skel">
        {/* Laid over the top of the scene, not above it, so the animation never moves when this appears. */}
        {elapsed > 3000 ? (
          <div className="banner info slow-banner">
            <InfoIcon size={16} />
            <span>Still running. Results appear as soon as the server sends them.</span>
            <span className="sp" />
            <button className="btn" onClick={onCancel} title={comboText(abortShortcut)} type="button">
              Cancel
            </button>
          </div>
        ) : null}
        <SauronEye />
      </div>
    </div>
  );
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** The "Messages" tab: one line per statement. */
export function MessagesView({ run }: { run: TabRun }) {
  const lines = run.sets.map((set, i) => {
    const at = (run.finishedAt ?? run.startedAt) - run.sets.slice(i + 1).reduce((s, x) => s + x.elapsedMs, 0);
    const result = set.result;
    const text = set.error ? set.error.message.split("\n")[0] : result ? (result.columns.length > 0 ? `${set.label.toUpperCase()} ${result.rows.length.toLocaleString("en-US")}${result.truncated ? "+" : ""}` : (result.message ?? "Statement executed")) : "";
    return (
      <div className={set.error ? "bad" : ""} key={i}>
        [{clock(at)}] statement {i + 1}: <b>{text}</b> · {formatDuration(set.elapsedMs)}
      </div>
    );
  });
  const failed = run.sets.some((s) => s.error);
  return (
    <div className="messages-view">
      {lines}
      <div>
        [{clock(run.finishedAt ?? run.startedAt)}] {failed ? "stopped at the first error" : "done"} · {run.sets.length} statement{run.sets.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

export function NotRunState({ name, connectionName, shortcut }: { name: string; connectionName: string | null; shortcut: string }) {
  return (
    <div className="placeholder-state">
      <PlayIcon size={28} />
      <b>Not run yet in this session</b>
      <span>
        Press <kbd>{comboText(shortcut)}</kbd> to run “{name}”{connectionName ? ` on ${connectionName}` : ""}.
      </span>
    </div>
  );
}

export function DoneState({ message, elapsedMs }: { message: string; elapsedMs: number }) {
  return (
    <div className="done-state">
      <CheckIcon className="command-output-icon" />
      <h4>Done</h4>
      <pre>{message}</pre>
      <span className="muted">{formatDuration(elapsedMs)}</span>
    </div>
  );
}
