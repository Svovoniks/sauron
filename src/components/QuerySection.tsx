import type { RefObject } from "react";

interface QuerySectionProps {
  editorContainerRef: RefObject<HTMLDivElement>;
  isLoading: boolean;
  isCommandQuery: boolean;
  onSaveQuery: () => void;
  onOpenFile: () => void;
  onAbortQuery: () => void;
  onExecuteQuery: () => void;
}

export function QuerySection({
  editorContainerRef,
  isLoading,
  isCommandQuery,
  onSaveQuery,
  onOpenFile,
  onAbortQuery,
  onExecuteQuery,
}: QuerySectionProps) {
  return (
    <div className="query-section">
      <div className="query-input-container">
        <div className="query-header">
          <div className="query-title-group">
            <span className="query-label">{isCommandQuery ? "\\ Command (\\? for help)" : "SQL Query"}</span>
          </div>
          <div className="query-header-tools">
            <button className="query-file-button" disabled={isLoading} onClick={onOpenFile} title="Load a .sql file into the editor" type="button">
              Open SQL file…
            </button>
            <span className="query-hint">Ctrl+Enter to execute</span>
          </div>
        </div>
        <div className="query-editor" ref={editorContainerRef}></div>
      </div>
      <div className="query-actions">
        <button className="button save-button" onClick={onSaveQuery} type="button">
          Save
        </button>
        {isLoading ? (
          <button className="button cancel-button" onClick={onAbortQuery} type="button">
            Abort
          </button>
        ) : (
          <button className="button execute-button" onClick={onExecuteQuery} type="button">
            Execute
          </button>
        )}
      </div>
    </div>
  );
}
