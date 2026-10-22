import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { QueryResult } from "../types/app";
import { cellText, detailValue } from "../utils/format";
import { CheckIcon, CloseIcon, CopyIcon, SearchIcon, WarningIcon } from "./icons";


export interface MetaOutput {
  text: string;
}

interface DataViewProps {
  result: QueryResult | null;
  /** Name of the connection the result came from, shown when it differs from the active one. */
  resultSource: string | null;
  selectedIndex: number | null;
  isLoading: boolean;
  queryError: string | null;
  queryOutput: MetaOutput | null;
  recordsTableRef: RefObject<HTMLDivElement>;
  canLoadMore: boolean;
  onSelectRow: (index: number) => void;
  onSaveResult: () => void;
  onCloseDetail: () => void;
  onLoadMore: () => void;
}

/** Estimated row height in px; rows are single-line so this is exact in practice (measured anyway). */
const ROW_HEIGHT = 42;
const HEADER_HEIGHT = 50;

const renderHighlightedText = (text: string, searchTerm: string): ReactNode => {
  if (!searchTerm) return text;

  const normalizedText = text.toLowerCase();
  // Lower-casing can change the length of some characters; then offsets no longer line up.
  if (normalizedText.length !== text.length) return text;

  const segments: ReactNode[] = [];
  let currentIndex = 0;
  let matchIndex = normalizedText.indexOf(searchTerm);

  while (matchIndex !== -1) {
    if (matchIndex > currentIndex) segments.push(text.slice(currentIndex, matchIndex));

    const matchEnd = matchIndex + searchTerm.length;
    segments.push(
      <mark className="search-match-highlight" key={`${matchIndex}-${matchEnd}`}>
        {text.slice(matchIndex, matchEnd)}
      </mark>,
    );

    currentIndex = matchEnd;
    matchIndex = normalizedText.indexOf(searchTerm, currentIndex);
  }

  if (currentIndex < text.length) segments.push(text.slice(currentIndex));
  return segments;
};

function SearchHighlightedCell({ searchTerm, text }: { searchTerm: string; text: string }) {
  const cellRef = useRef<HTMLTableCellElement | null>(null);
  const [isMatchHidden, setIsMatchHidden] = useState(false);

  useLayoutEffect(() => {
    const cell = cellRef.current;

    if (!cell || !searchTerm || !text.toLowerCase().includes(searchTerm)) {
      setIsMatchHidden(false);
      return;
    }

    const measureMatchVisibility = () => {
      const textContent = cell.querySelector<HTMLElement>(".cell-text-content");
      const firstMatch = textContent?.querySelector<HTMLElement>(".search-match-highlight");
      if (!textContent || !firstMatch) {
        setIsMatchHidden(false);
        return;
      }

      const cellRect = cell.getBoundingClientRect();
      const textRect = textContent.getBoundingClientRect();
      const matchRect = firstMatch.getBoundingClientRect();
      const cellStyles = window.getComputedStyle(cell);
      const leftPadding = Number.parseFloat(cellStyles.paddingLeft) || 0;
      const rightPadding = Number.parseFloat(cellStyles.paddingRight) || 0;
      const visibleLeft = Math.max(cellRect.left + leftPadding, textRect.left);
      const visibleRight = Math.min(cellRect.right - rightPadding, textRect.right);
      const isOverflowing =
        cell.scrollWidth > cell.clientWidth + 1 || textContent.scrollWidth > textContent.clientWidth + 1;

      setIsMatchHidden(isOverflowing && (matchRect.left < visibleLeft || matchRect.right > visibleRight));
    };

    measureMatchVisibility();

    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(measureMatchVisibility);
    resizeObserver.observe(cell);
    resizeObserver.observe(cell.querySelector<HTMLElement>(".cell-text-content") ?? cell);

    return () => resizeObserver.disconnect();
  }, [isMatchHidden, searchTerm, text]);

  return (
    <td className={`truncate ${isMatchHidden ? "search-hidden-match" : ""}`} ref={cellRef} title={text.length > 500 ? text.slice(0, 500) + "…" : text}>
      <span className="cell-clip">
        <span className="cell-text-content">{renderHighlightedText(text, searchTerm)}</span>
        {isMatchHidden && (
          <span aria-hidden="true" className="hidden-match-ellipsis">
            <span className="search-match-highlight">...</span>
          </span>
        )}
      </span>
    </td>
  );
}

export function DataView({
  result,
  resultSource,
  selectedIndex,
  isLoading,
  queryError,
  queryOutput,
  recordsTableRef,
  canLoadMore,
  onSelectRow,
  onSaveResult,
  onCloseDetail,
  onLoadMore,
}: DataViewProps) {
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const columns = result?.columns ?? [];
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const hasColumns = columns.length > 0;

  const typedSearch = isSearchVisible ? searchQuery.trim().toLowerCase() : "";
  const searchTerm = useDeferredValue(typedSearch);
  const isSearching = searchTerm.length > 0;
  const isDetailViewOpen = selectedIndex !== null && selectedIndex < rows.length;

  // One lowercase string per row, built only when a search is actually used.
  const searchIndex = useMemo(
    () => (isSearching ? rows.map((row) => row.map((cell) => cellText(cell).toLowerCase()).join("\u0000")) : null),
    [isSearching, rows],
  );

  /** Indexes (into result.rows) of the rows to show; null = all rows. */
  const visibleRows = useMemo(() => {
    if (isDetailViewOpen || !searchIndex) return null;
    if (columns.some((column) => column.name.toLowerCase().includes(searchTerm))) return null;
    const matches: number[] = [];
    searchIndex.forEach((text, index) => text.includes(searchTerm) && matches.push(index));
    return matches;
  }, [columns, isDetailViewOpen, searchIndex, searchTerm]);

  const rowCount = visibleRows ? visibleRows.length : rows.length;

  const detailEntries = useMemo(() => {
    if (!isDetailViewOpen || selectedIndex === null) return [];
    const row = rows[selectedIndex];
    const entries = columns.map((column, index) => ({ column, value: row[index] ?? null }));
    if (!isSearching) return entries;
    return entries.filter(
      ({ column, value }) =>
        column.name.toLowerCase().includes(searchTerm) || cellText(value).toLowerCase().includes(searchTerm),
    );
  }, [columns, isDetailViewOpen, isSearching, rows, searchTerm, selectedIndex]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => recordsTableRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollPaddingStart: HEADER_HEIGHT,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

  // Keep the selected row in view when it changes (j / k / arrows).
  useEffect(() => {
    if (selectedIndex === null) return;
    const position = visibleRows ? visibleRows.indexOf(selectedIndex) : selectedIndex;
    if (position >= 0) virtualizer.scrollToIndex(position, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  // New result or new search => start at the top.
  useEffect(() => {
    recordsTableRef.current?.scrollTo({ top: 0 });
  }, [result, searchTerm, recordsTableRef]);

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
      closeSearch();
    };

    window.addEventListener("keydown", handleKeydown, true);
    return () => window.removeEventListener("keydown", handleKeydown, true);
  }, [isSearchVisible]);

  const displayedCount = isDetailViewOpen ? rows.length : rowCount;
  const showTable = result !== null && hasColumns;

  return (
    <div className="content-area">
      {isSearchVisible && (
        <div className="floating-search">
          <div aria-hidden="true" className="search-input-icon">
            <SearchIcon />
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
          <span aria-hidden="true" className="search-shortcut-hint">
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
            <CloseIcon />
          </button>
        </div>
      )}
      <div className="data-view">
        <div className={`table-section ${isDetailViewOpen ? "with-detail" : ""}`}>
          <div className="table-header">
            <h3>
              Query Results
              {resultSource ? <span className="result-source">from {resultSource}</span> : null}
            </h3>
            <div className="table-header-tools">
              {showTable && rows.length > 0 && (
                <button className="button save-button" onClick={onSaveResult} type="button">
                  Save Results
                </button>
              )}
              {showTable && (
                <span className="record-count">
                  {displayedCount.toLocaleString()} record{displayedCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>

          {showTable && result.truncated && !isLoading && (
            <div className="truncation-banner" role="status">
              <span>
                Showing the first {rows.length.toLocaleString()} rows. There are more.
              </span>
              {canLoadMore && (
                <button className="button save-button" onClick={onLoadMore} type="button">
                  Load more
                </button>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Executing query...</p>
            </div>
          ) : queryOutput ? (
            <div className="command-output-state">
              <CheckIcon className="command-output-icon" />
              <h4>Meta Command Output</h4>
              <pre>{queryOutput.text}</pre>
            </div>
          ) : queryError ? (
            <div className="error-state">
              <WarningIcon className="error-icon" />
              <h4>Query Error</h4>
              <p>{queryError}</p>
            </div>
          ) : result && !hasColumns ? (
            <div className="command-output-state">
              <CheckIcon className="command-output-icon" />
              <h4>Done</h4>
              <pre>{result.message ?? "Statement executed"}</pre>
            </div>
          ) : (
            <div className="records-table" ref={recordsTableRef}>
              <table>
                <thead>
                  <tr>
                    {hasColumns ? (
                      columns.map((column, index) => <th key={index}>{renderHighlightedText(column.name, searchTerm)}</th>)
                    ) : (
                      <th>No Data</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rowCount > 0 ? (
                    <>
                      {paddingTop > 0 && (
                        <tr aria-hidden="true" className="virtual-spacer" style={{ height: paddingTop }}>
                          <td colSpan={columns.length} />
                        </tr>
                      )}
                      {virtualItems.map((item) => {
                        const rowIndex = visibleRows ? visibleRows[item.index] : item.index;
                        const row = rows[rowIndex];
                        return (
                          <tr
                            className={`record-row ${selectedIndex === rowIndex ? "active" : ""}`}
                            data-index={item.index}
                            key={rowIndex}
                            onClick={() => onSelectRow(rowIndex)}
                            ref={virtualizer.measureElement}
                          >
                            {columns.map((_, cellIndex) => (
                              <SearchHighlightedCell
                                key={cellIndex}
                                searchTerm={searchTerm}
                                text={cellText(row[cellIndex] ?? null)}
                              />
                            ))}
                          </tr>
                        );
                      })}
                      {paddingBottom > 0 && (
                        <tr aria-hidden="true" className="virtual-spacer" style={{ height: paddingBottom }}>
                          <td colSpan={columns.length} />
                        </tr>
                      )}
                    </>
                  ) : (
                    <tr>
                      <td className="no-data" colSpan={Math.max(columns.length, 1)}>
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

        <div className={`detail-view ${isDetailViewOpen ? "visible" : ""}`}>
          <div className="detail-header">
            <h4>Record Details</h4>
            <button aria-label="Close details" className="close-detail" onClick={onCloseDetail} type="button">
              X
            </button>
          </div>
          {isDetailViewOpen ? (
            <div className="detail-content">
              {detailEntries.length > 0 ? (
                detailEntries.map(({ column, value }, index) => {
                  const detail = detailValue(column.type, value);

                  return (
                    <div className="detail-item" key={index}>
                      <div className="detail-key">
                        <span className="key-name">{renderHighlightedText(column.name, searchTerm)}</span>
                        <span className={`key-type ${detail.kind}`}>{detail.label}</span>
                      </div>
                      <div className="value-container">
                        <pre className={`value-content ${detail.kind}`}>{renderHighlightedText(detail.text, searchTerm)}</pre>
                        <button
                          aria-label="Copy value"
                          className="copy-button"
                          onClick={() => navigator.clipboard.writeText(detail.copyText)}
                          title="Copy value"
                          type="button"
                        >
                          <CopyIcon />
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="detail-placeholder">
                  <p>No matching fields in this record</p>
                </div>
              )}
            </div>
          ) : (
            <div className="detail-placeholder">
              <p>Select a record to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
