import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { SavedQuery, SavedResult } from "../types/app";
import { GripIcon, RefreshIcon, TrashIcon } from "./icons";

export type SaveScope = "local" | "global";
type ItemType = "query" | "result";

interface SidebarProps {
  activeSaveScope: SaveScope;
  activeSidebarTab: "queries" | "results";
  savedQueries: SavedQuery[];
  savedResults: SavedResult[];
  /** Ids of the query / result last loaded into the editor / table (highlighted in the list). */
  activeQueryId: string | null;
  activeResultId: string | null;
  onSetSaveScope: (scope: SaveScope) => void;
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

interface SavedItemProps {
  type: ItemType;
  id: string;
  name: string;
  preview: string;
  active: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onOverwrite: () => void;
  overwriteTitle: string;
  onStartReorder: (event: MouseEvent<HTMLButtonElement>) => void;
  onReorderHover: () => void;
  onStopReorder: () => void;
}

function SavedItem({
  type,
  name,
  preview,
  active,
  dragging,
  onSelect,
  onDelete,
  onOverwrite,
  overwriteTitle,
  onStartReorder,
  onReorderHover,
  onStopReorder,
}: SavedItemProps): ReactNode {
  return (
    <div
      className={`query-item ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
      onMouseEnter={onReorderHover}
      onMouseUp={onStopReorder}
    >
      <button
        aria-label={`Reorder saved ${type}`}
        className={`drag-query drag-query-side ${dragging ? "active" : ""}`}
        onMouseDown={onStartReorder}
        title="Drag to reorder"
        type="button"
      >
        <GripIcon />
      </button>
      <div className="query-main">
        <button className="query-content query-select" onClick={onSelect} type="button">
          <span className="query-name">{name}</span>
          <span className="query-preview">{preview}</span>
        </button>
        <div className="query-actions">
          <button
            aria-label={`Delete saved ${type}`}
            className="delete-query"
            onClick={onDelete}
            title={`Delete saved ${type}`}
            type="button"
          >
            <TrashIcon />
          </button>
          <button
            aria-label={`Overwrite saved ${type}`}
            className="overwrite-query"
            onClick={onOverwrite}
            title={overwriteTitle}
            type="button"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  activeSaveScope,
  activeSidebarTab,
  savedQueries,
  savedResults,
  activeQueryId,
  activeResultId,
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
  const [draggingItem, setDraggingItem] = useState<{ id: string; type: ItemType } | null>(null);

  useEffect(() => {
    const handleMouseUp = () => setDraggingItem(null);
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const startReorder = (event: MouseEvent<HTMLButtonElement>, id: string, type: ItemType) => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingItem({ id, type });
  };

  const handleReorderHover = (targetId: string, targetType: ItemType) => {
    if (!draggingItem || draggingItem.type !== targetType || draggingItem.id === targetId) return;
    (targetType === "query" ? onReorderQuery : onReorderResult)(draggingItem.id, targetId);
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>Saved Stuff</h3>
        <div className="sidebar-toggle sidebar-scope-toggle">
          <button className={activeSaveScope === "local" ? "active" : ""} onClick={() => onSetSaveScope("local")} type="button">
            Local
          </button>
          <button className={activeSaveScope === "global" ? "active" : ""} onClick={() => onSetSaveScope("global")} type="button">
            Global
          </button>
        </div>
      </div>
      <div className="sidebar-controls">
        <div className="sidebar-toggle">
          <button className={activeSidebarTab === "queries" ? "active" : ""} onClick={() => onSetSidebarTab("queries")} type="button">
            Queries
          </button>
          <button className={activeSidebarTab === "results" ? "active" : ""} onClick={() => onSetSidebarTab("results")} type="button">
            Results
          </button>
        </div>
      </div>
      <div className="query-list">
        {activeSidebarTab === "queries"
          ? savedQueries.map((query) => (
              <SavedItem
                active={query.id === activeQueryId}
                dragging={draggingItem?.id === query.id}
                id={query.id}
                key={query.id}
                name={query.name}
                onDelete={() => onDeleteQuery(query)}
                onOverwrite={() => onOverwriteQuery(query)}
                onReorderHover={() => handleReorderHover(query.id, "query")}
                onSelect={() => onSelectQuery(query)}
                onStartReorder={(event) => startReorder(event, query.id, "query")}
                onStopReorder={() => setDraggingItem(null)}
                overwriteTitle="Overwrite with current query"
                preview={query.query.length > 50 ? `${query.query.substring(0, 50)}...` : query.query}
                type="query"
              />
            ))
          : savedResults.map((result) => (
              <SavedItem
                active={result.id === activeResultId}
                dragging={draggingItem?.id === result.id}
                id={result.id}
                key={result.id}
                name={result.name}
                onDelete={() => onDeleteResult(result)}
                onOverwrite={() => onOverwriteResult(result)}
                onReorderHover={() => handleReorderHover(result.id, "result")}
                onSelect={() => onSelectResult(result)}
                onStartReorder={(event) => startReorder(event, result.id, "result")}
                onStopReorder={() => setDraggingItem(null)}
                overwriteTitle="Overwrite with current query and results"
                preview={`${result.rows.length} records${result.truncated ? " (truncated)" : ""}`}
                type="result"
              />
            ))}
      </div>
    </div>
  );
}
