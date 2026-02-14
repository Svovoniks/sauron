import type { RefObject } from "react";

interface QuerySectionProps {
  editorContainerRef: RefObject<HTMLDivElement>;
  isLoading: boolean;
  onSaveQuery: () => void;
  onAbortQuery: () => void;
  onExecuteQuery: () => void;
}

export function QuerySection({ editorContainerRef, isLoading, onSaveQuery, onAbortQuery, onExecuteQuery }: QuerySectionProps) {
  return (
    <div className="query-section">
      <div className="query-input-container">
        <div className="query-header"><span className="query-label">SQL Query</span><span className="query-hint">Ctrl+Enter to execute</span></div>
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
