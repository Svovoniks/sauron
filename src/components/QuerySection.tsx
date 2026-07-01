import type { RefObject } from "react";

interface CommandAvailability {
  status: "checking" | "available" | "unavailable";
  label: string;
  detail: string;
}

interface QuerySectionProps {
  editorContainerRef: RefObject<HTMLDivElement>;
  commandAvailability: CommandAvailability;
  isLoading: boolean;
  isCommandQuery: boolean;
  onSaveQuery: () => void;
  onAbortQuery: () => void;
  onExecuteQuery: () => void;
}

export function QuerySection({
  editorContainerRef,
  commandAvailability,
  isLoading,
  isCommandQuery,
  onSaveQuery,
  onAbortQuery,
  onExecuteQuery,
}: QuerySectionProps) {
  return (
    <div className="query-section">
      <div className="query-input-container">
        <div className="query-header">
          <div className="query-title-group">
            <span className="query-label">{isCommandQuery ? "\\# Command" : "SQL Query"}</span>
            {isCommandQuery ? (
              <span
                aria-label={`${commandAvailability.label}: ${commandAvailability.detail}`}
                className={`command-availability ${commandAvailability.status}`}
                title={commandAvailability.detail}
              >
                <span className="command-availability-dot" aria-hidden="true"></span>
                {commandAvailability.label}
              </span>
            ) : null}
          </div>
          <span className="query-hint">Ctrl+Enter to execute</span>
        </div>
        <div className="query-editor" ref={editorContainerRef}></div>
      </div>
      <div className="query-actions">
        <button className="button save-button" onClick={onSaveQuery} type="button">Save</button>
        {isLoading ? (
          <button className="button cancel-button" onClick={onAbortQuery} type="button">Abort</button>
        ) : (
          <button className="button execute-button" onClick={onExecuteQuery} disabled={isLoading} type="button">Execute</button>
        )}
      </div>
    </div>
  );
}
