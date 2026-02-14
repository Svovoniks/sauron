import type { SavedQuery, SavedResult } from "../types/app";

interface SidebarProps {
  activeSidebarTab: "queries" | "results";
  savedQueries: SavedQuery[];
  savedResults: SavedResult[];
  onSetSidebarTab: (tab: "queries" | "results") => void;
  onSelectQuery: (query: SavedQuery) => void;
  onSelectResult: (result: SavedResult) => void;
  onDeleteQuery: (query: SavedQuery) => void;
  onDeleteResult: (result: SavedResult) => void;
}

export function Sidebar({
  activeSidebarTab,
  savedQueries,
  savedResults,
  onSetSidebarTab,
  onSelectQuery,
  onSelectResult,
  onDeleteQuery,
  onDeleteResult,
}: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>Saved Stuff</h3>
        <div className="sidebar-toggle">
          <button className={activeSidebarTab === "queries" ? "active" : ""} onClick={() => onSetSidebarTab("queries")} type="button">Queries</button>
          <button className={activeSidebarTab === "results" ? "active" : ""} onClick={() => onSetSidebarTab("results")} type="button">Results</button>
        </div>
      </div>
      <div className="query-list">
        {activeSidebarTab === "queries"
          ? savedQueries.map((query) => (
              <div
                className={`query-item ${query.active ? "active" : ""}`}
                key={query.id}
                onClick={() => onSelectQuery(query)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === "Enter" && onSelectQuery(query)}
              >
                <div className="query-content">
                  <span className="query-name">{query.name}</span>
                  <span className="query-preview">{`${query.query.substring(0, 50)}...`}</span>
                </div>
                <button
                  className="delete-query"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteQuery(query);
                  }}
                  type="button"
                >
                  X
                </button>
              </div>
            ))
          : savedResults.map((result) => (
              <div
                className={`query-item ${result.active ? "active" : ""}`}
                key={result.id}
                onClick={() => onSelectResult(result)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === "Enter" && onSelectResult(result)}
              >
                <div className="query-content">
                  <span className="query-name">{result.name}</span>
                  <span className="query-preview">{`${result.records.length} records`}</span>
                </div>
                <button
                  className="delete-query"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteResult(result);
                  }}
                  type="button"
                >
                  X
                </button>
              </div>
            ))}
      </div>
    </div>
  );
}
