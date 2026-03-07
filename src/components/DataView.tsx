import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

interface QueryOutput {
  title: string;
  text: string;
}

interface DataViewProps {
  records: any[];
  recordColumns: string[];
  selectedRecord: any | null;
  isLoading: boolean;
  queryError: Error | null;
  queryOutput: QueryOutput | null;
  recordsTableRef: RefObject<HTMLDivElement>;
  onSelectRecord: (record: any) => void;
  onSaveResult: () => void;
  onCloseDetail: () => void;
  prettyPrintJson: (value: any) => string;
  getValueType: (value: any) => string;
}

export function DataView({
  records,
  recordColumns,
  selectedRecord,
  isLoading,
  queryError,
  queryOutput,
  recordsTableRef,
  onSelectRecord,
  onSaveResult,
  onCloseDetail,
  prettyPrintJson,
  getValueType,
}: DataViewProps) {
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isSearching = isSearchVisible && normalizedSearchQuery.length > 0;
  const isDetailViewOpen = Boolean(selectedRecord);

  const filteredRecords = useMemo(() => {
    if (isDetailViewOpen || !isSearching) return records;

    return records.filter((record) =>
      Object.entries(record).some(([key, value]) => {
        if (key.toLowerCase().includes(normalizedSearchQuery)) return true;
        return prettyPrintJson(value).toLowerCase().includes(normalizedSearchQuery);
      }),
    );
  }, [isDetailViewOpen, isSearching, normalizedSearchQuery, prettyPrintJson, records]);

  const detailEntries = useMemo(() => {
    if (!selectedRecord) return [];

    const allEntries = Object.entries(selectedRecord);
    if (!isSearching) return allEntries;

    return allEntries.filter(([key, value]) => {
      if (key.toLowerCase().includes(normalizedSearchQuery)) return true;
      return prettyPrintJson(value).toLowerCase().includes(normalizedSearchQuery);
    });
  }, [isSearching, normalizedSearchQuery, prettyPrintJson, selectedRecord]);

  const tableRows = isDetailViewOpen ? records : filteredRecords;
  const displayedRecordCount = isDetailViewOpen ? records.length : filteredRecords.length;

  useEffect(() => {
    const openSearch = () => {
      setIsSearchVisible(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };

    const closeSearch = () => {
      setSearchQuery("");
      setIsSearchVisible(false);
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        openSearch();
        return;
      }

      if (!isSearchVisible || event.key !== "Escape") return;

      event.preventDefault();
      event.stopPropagation();
      if (searchQuery) {
        setSearchQuery("");
      } else {
        closeSearch();
      }
    };

    window.addEventListener("keydown", handleKeydown, true);
    return () => window.removeEventListener("keydown", handleKeydown, true);
  }, [isSearchVisible, searchQuery]);

  return (
    <div className="content-area">
      {isSearchVisible && (
        <div className="floating-search">
          <div aria-hidden="true" className="search-input-icon">
            <svg fill="none" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="2" />
              <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
            </svg>
          </div>
          <input
            aria-label={isDetailViewOpen ? "Search in record details" : "Search in query results"}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            className="results-search-input"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={isDetailViewOpen ? "Search in details..." : "Search in results..."}
            ref={searchInputRef}
            spellCheck={false}
            type="search"
            value={searchQuery}
          />
          <span className="search-shortcut-hint" aria-hidden="true">
            {navigator.userAgent.includes("Mac") ? "⌘F" : "Ctrl+F"}
          </span>
          <button
            aria-label="Close search"
            className="close-search-input"
            onClick={() => {
              setSearchQuery("");
              setIsSearchVisible(false);
            }}
            type="button"
          >
            <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
            </svg>
          </button>
        </div>
      )}
      <div className="data-view">
        <div className={`table-section ${selectedRecord ? "with-detail" : ""}`}>
          <div className="table-header">
            <h3>Query Results</h3>
            <div className="table-header-tools">
              {records.length > 0 && (
                <button className="button save-button" onClick={onSaveResult} type="button">Save Results</button>
              )}
              {records.length > 0 && (
                <span className="record-count">{displayedRecordCount} records</span>
              )}
            </div>
          </div>

          {isLoading ? (
            <div className="loading-state"><div className="spinner"></div><p>Executing query...</p></div>
          ) : queryOutput ? (
            <div className="command-output-state">
              <svg aria-hidden="true" className="command-output-icon" fill="none" viewBox="0 0 24 24">
                <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <h4>{queryOutput.title}</h4>
              <pre>{queryOutput.text}</pre>
            </div>
          ) : queryError ? (
            <div className="error-state">
              <svg aria-hidden="true" className="error-icon" fill="none" viewBox="0 0 24 24">
                <path
                  d="M12 3 2.6 19.5h18.8L12 3Z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
                <path d="M12 9v5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
                <circle cx="12" cy="16.5" fill="currentColor" r="1" />
              </svg>
              <h4>Query Error</h4>
              <p>{queryError.message}</p>
            </div>
          ) : (
            <div className="records-table" ref={recordsTableRef}>
              <table>
                <thead><tr>{records.length > 0 ? recordColumns.map((column) => <th key={column}>{column}</th>) : <th>No Data</th>}</tr></thead>
                <tbody>
                  {tableRows.length > 0 ? (
                    tableRows.map((record, index) => (
                      <tr className={`record-row ${selectedRecord === record ? "active" : ""}`} key={index} onClick={() => onSelectRecord(record)}>
                        {Object.values(record).map((value, valueIndex) => (
                          <td className="truncate" key={`${index}-${valueIndex}`} title={String(value)}>{String(value)}</td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="no-data" colSpan={100}>
                        <div className="empty-table">
                          <p>{isSearching && !isDetailViewOpen ? "No matching records found" : "No records found"}</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={`detail-view ${selectedRecord ? "visible" : ""}`}>
          <div className="detail-header">
            <h4>Record Details</h4>
            <button className="close-detail" onClick={onCloseDetail} type="button">X</button>
          </div>
          {selectedRecord ? (
            <div className="detail-content">
              {detailEntries.length > 0 ? detailEntries.map(([key, value]) => {
                const valueType = getValueType(value);
                return (
                  <div className="detail-item" key={key}>
                    <div className="detail-key"><span className="key-name">{key}</span><span className={`key-type ${valueType}`}>{valueType}</span></div>
                    <div className="value-container">
                      <pre className={`value-content ${valueType}`}>{prettyPrintJson(value)}</pre>
                      <button
                        aria-label="Copy value"
                        className="copy-button"
                        onClick={() => navigator.clipboard.writeText(String(value))}
                        title="Copy value"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                          <rect
                            height="13"
                            rx="2"
                            ry="2"
                            stroke="currentColor"
                            strokeWidth="2"
                            width="13"
                            x="9"
                            y="9"
                          />
                          <rect
                            height="13"
                            rx="2"
                            ry="2"
                            stroke="currentColor"
                            strokeWidth="2"
                            width="13"
                            x="2"
                            y="2"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              }) : (
                <div className="detail-placeholder"><p>No matching fields in this record</p></div>
              )}
            </div>
          ) : (
            <div className="detail-placeholder"><p>Select a record to view details</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
