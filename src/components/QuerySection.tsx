import type { RefObject } from "react";

type QueryMode = "sql" | "slash";

interface QuerySectionProps {
  editorContainerRef: RefObject<HTMLDivElement>;
  isLoading: boolean;
  showModeSwitch: boolean;
  queryMode: QueryMode;
  onSaveQuery: () => void;
  onAbortQuery: () => void;
  onExecuteQuery: () => void;
  onQueryModeChange: (mode: QueryMode) => void;
}

export function QuerySection({
  editorContainerRef,
  isLoading,
  showModeSwitch,
  queryMode,
  onSaveQuery,
  onAbortQuery,
  onExecuteQuery,
  onQueryModeChange,
}: QuerySectionProps) {
  return (
    <div className="query-section">
      <div className="query-input-container">
        <div className="query-header">
          <div className="query-title-group">
            <span className="query-label">{queryMode === "slash" ? "\\# Command" : "SQL Query"}</span>
            {showModeSwitch && (
              <div className={`query-mode-switch ${queryMode === "slash" ? "slash" : ""}`}>
                <button className={queryMode === "sql" ? "active" : ""} onClick={() => onQueryModeChange("sql")} type="button">
                  sql
                </button>
                <button className={queryMode === "slash" ? "active" : ""} onClick={() => onQueryModeChange("slash")} type="button">
                  \#
                </button>
              </div>
            )}
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
