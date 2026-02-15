import { useEffect, useState, type MouseEvent } from "react";
import type { SavedQuery, SavedResult } from "../types/app";

interface SidebarProps {
  activeSaveScope: "local" | "global";
  activeSidebarTab: "queries" | "results";
  savedQueries: SavedQuery[];
  savedResults: SavedResult[];
  onSetSaveScope: (scope: "local" | "global") => void;
  onSetSidebarTab: (tab: "queries" | "results") => void;
  onSelectQuery: (query: SavedQuery) => void;
  onSelectResult: (result: SavedResult) => void;
  onDeleteQuery: (query: SavedQuery) => void;
  onDeleteResult: (result: SavedResult) => void;
  onOverwriteQuery: (query: SavedQuery) => void;
  onOverwriteResult: (result: SavedResult) => void;
  onReorderQuery: (fromId: string, toId: string) => void;
  onReorderResult: (fromId: string, toId: string) => void;
}

export function Sidebar({
  activeSaveScope,
  activeSidebarTab,
  savedQueries,
  savedResults,
  onSetSaveScope,
  onSetSidebarTab,
  onSelectQuery,
  onSelectResult,
  onDeleteQuery,
  onDeleteResult,
  onOverwriteQuery,
  onOverwriteResult,
  onReorderQuery,
  onReorderResult,
}: SidebarProps) {
  const [draggingItem, setDraggingItem] = useState<{ id: string; type: "query" | "result" } | null>(null);

  useEffect(() => {
    const handleMouseUp = () => setDraggingItem(null);
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const startReorder = (event: MouseEvent<HTMLButtonElement>, itemId: string, itemType: "query" | "result") => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingItem({ id: itemId, type: itemType });
  };

  const handleReorderHover = (targetItemId: string, targetItemType: "query" | "result") => {
    if (!draggingItem || draggingItem.type !== targetItemType || draggingItem.id === targetItemId) return;

    if (targetItemType === "query") {
      onReorderQuery(draggingItem.id, targetItemId);
    } else {
      onReorderResult(draggingItem.id, targetItemId);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>Saved Stuff</h3>
        <div className="sidebar-toggle sidebar-scope-toggle">
          <button className={activeSaveScope === "local" ? "active" : ""} onClick={() => onSetSaveScope("local")} type="button">Local</button>
          <button className={activeSaveScope === "global" ? "active" : ""} onClick={() => onSetSaveScope("global")} type="button">Global</button>
        </div>
      </div>
      <div className="sidebar-controls">
        <div className="sidebar-toggle">
          <button className={activeSidebarTab === "queries" ? "active" : ""} onClick={() => onSetSidebarTab("queries")} type="button">Queries</button>
          <button className={activeSidebarTab === "results" ? "active" : ""} onClick={() => onSetSidebarTab("results")} type="button">Results</button>
        </div>
      </div>
      <div className="query-list">
        {activeSidebarTab === "queries"
          ? savedQueries.map((query) => (
              <div
                className={`query-item ${query.active ? "active" : ""} ${draggingItem?.id === query.id ? "dragging" : ""}`}
                key={query.id}
                onClick={() => onSelectQuery(query)}
                onMouseEnter={() => handleReorderHover(query.id, "query")}
                onMouseUp={() => setDraggingItem(null)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === "Enter" && onSelectQuery(query)}
              >
                <div className="query-content">
                  <span className="query-name">{query.name}</span>
                  <span className="query-preview">{`${query.query.substring(0, 50)}...`}</span>
                </div>
                <div className="query-actions">
                  <button
                    aria-label="Reorder saved query"
                    className={`drag-query ${draggingItem?.id === query.id ? "active" : ""}`}
                    onMouseDown={(event) => startReorder(event, query.id, "query")}
                    title="Drag to reorder"
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
                    </svg>
                  </button>
                  <button
                    aria-label="Delete saved query"
                    className="delete-query"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteQuery(query);
                    }}
                    title="Delete saved query"
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                      <path d="M3 6h18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M8 6V4h8v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M19 6v14H5V6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  </button>
                  <button
                    aria-label="Overwrite saved query"
                    className="overwrite-query"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOverwriteQuery(query);
                    }}
                    title="Overwrite with current query"
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M21 3v6h-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          : savedResults.map((result) => (
              <div
                className={`query-item ${result.active ? "active" : ""} ${draggingItem?.id === result.id ? "dragging" : ""}`}
                key={result.id}
                onClick={() => onSelectResult(result)}
                onMouseEnter={() => handleReorderHover(result.id, "result")}
                onMouseUp={() => setDraggingItem(null)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === "Enter" && onSelectResult(result)}
              >
                <div className="query-content">
                  <span className="query-name">{result.name}</span>
                  <span className="query-preview">{`${result.records.length} records`}</span>
                </div>
                <div className="query-actions">
                  <button
                    aria-label="Reorder saved result"
                    className={`drag-query ${draggingItem?.id === result.id ? "active" : ""}`}
                    onMouseDown={(event) => startReorder(event, result.id, "result")}
                    title="Drag to reorder"
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
                    </svg>
                  </button>
                  <button
                    aria-label="Delete saved result"
                    className="delete-query"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteResult(result);
                    }}
                    title="Delete saved result"
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                      <path d="M3 6h18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M8 6V4h8v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M19 6v14H5V6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  </button>
                  <button
                    aria-label="Overwrite saved result"
                    className="overwrite-query"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOverwriteResult(result);
                    }}
                    title="Overwrite with current query and results"
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      <path d="M21 3v6h-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
      </div>
    </div>
  );
}
