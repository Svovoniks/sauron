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
              </div>
            ))}
      </div>
    </div>
  );
}
