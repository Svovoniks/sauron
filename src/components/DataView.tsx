import type { RefObject } from "react";

interface DataViewProps {
  records: any[];
  recordColumns: string[];
  selectedRecord: any | null;
  isLoading: boolean;
  queryError: Error | null;
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
  recordsTableRef,
  onSelectRecord,
  onSaveResult,
  onCloseDetail,
  prettyPrintJson,
  getValueType,
}: DataViewProps) {
  return (
    <div className="content-area">
      <div className="data-view">
        <div className={`table-section ${selectedRecord ? "with-detail" : ""}`}>
          <div className="table-header">
            <h3>Query Results</h3>
            {records.length > 0 && (
              <>
                <button className="button save-button" onClick={onSaveResult} type="button">Save Results</button>
                <span className="record-count">{records.length} records</span>
              </>
            )}
          </div>

          {isLoading ? (
            <div className="loading-state"><div className="spinner"></div><p>Executing query...</p></div>
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
                  {records.length > 0 ? (
                    records.map((record, index) => (
                      <tr className={`record-row ${selectedRecord === record ? "active" : ""}`} key={index} onClick={() => onSelectRecord(record)}>
                        {Object.values(record).map((value, valueIndex) => (
                          <td className="truncate" key={`${index}-${valueIndex}`} title={String(value)}>{String(value)}</td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={100} className="no-data"><div className="empty-table"><p>No records found</p></div></td></tr>
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
              {Object.entries(selectedRecord).map(([key, value]) => {
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
              })}
            </div>
          ) : (
            <div className="detail-placeholder"><p>Select a record to view details</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
