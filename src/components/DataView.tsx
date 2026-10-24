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
import { comboText, matchesCombo, type LoadingAnimation } from "../lib/settings";
import type { Schema } from "../lib/schema";
import type { Connection } from "../types/app";
import { MESSAGES, type QueryTab, type ResultSet, type TabRun } from "../types/workspace";
import { cellText, clipCell } from "../utils/format";
import { CheckIcon, CloseIcon, InfoIcon, SearchIcon } from "./icons";
import { RecordInspector } from "./RecordInspector";
import { DoneState, ErrorCard, MessagesView, NotRunState, RunningState, type ErrorActions } from "./ResultStates";
import { formatDuration } from "../lib/history";
import { TerminalIcon } from "./icons";

export interface DataViewActions extends ErrorActions {
  onSelectRow: (index: number) => void;
  onStepRecord: (delta: number) => void;
  onSaveResult: () => void;
  onCloseDetail: () => void;
  onLoadMore: () => void;
  onSelectSet: (index: number) => void;
  onCancel: () => void;
  onRerunHere: () => void;
  onDismissBanner: () => void;
  onRunRestored: () => void;
  onCopyLabelled: (text: string, label: string) => void;
}

interface DataViewProps {
  tab: QueryTab | null;
  run: TabRun | null;
  /** Connection the tab runs on. */
  connection: Connection | null;
  schema: Schema | null;
  /** Results on screen came from another connection than the tab's current one. */
  staleFrom: string | null;
  /** Shown after restoring a query from history. */
  restoredNote: string | null;
  selectedIndex: number | null;
  recordsTableRef: RefObject<HTMLDivElement>;
  canLoadMore: boolean;
  /** Table the rows came from (for "Copy as INSERT"). */
  tableName: string | null;
  executeShortcut: string;
  abortShortcut: string;
  /** Display preferences (Settings). */
  prefs: { nullText: string; rowNumbers: boolean; rowHeight: number; prettyJson: boolean; findShortcut: string; loadingAnimation: LoadingAnimation };
  actions: DataViewActions;
}

const HEADER_HEIGHT = 50;

const setSummary = (set: ResultSet): string => {
  if (set.error) return "failed";
  const result = set.result;
  if (!result) return "";
  if (result.columns.length > 0) return `${result.rows.length.toLocaleString("en-US")}${result.truncated ? "+" : ""} rows`;
  const affected = /^(\d[\d,]*) rows? (affected|written)/.exec(result.message ?? "");
  return affected ? `${affected[1]} ${affected[2]}` : "ok";
};

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

function SearchHighlightedCell({ searchTerm, text, full }: { searchTerm: string; text: string; full: string }) {
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
    <td className={`truncate ${isMatchHidden ? "search-hidden-match" : ""}`} ref={cellRef} title={full.length > 500 ? full.slice(0, 500) + "…" : full}>
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
  tab,
  run,
  connection,
  schema,
  staleFrom,
  restoredNote,
  selectedIndex,
  recordsTableRef,
  canLoadMore,
  tableName,
  executeShortcut,
  abortShortcut,
  prefs,
  actions,
}: DataViewProps) {
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const sets = run?.sets ?? [];
  const activeIndex = run ? (run.activeSet === MESSAGES ? MESSAGES : Math.min(run.activeSet, sets.length - 1)) : 0;
  const activeSet: ResultSet | null = run && activeIndex >= 0 ? (sets[activeIndex] ?? null) : null;
  const result = activeSet?.result ?? null;
  const showMessages = run?.activeSet === MESSAGES && sets.length > 0;
  const timeoutSecs = run?.timeoutSecs ?? connection?.timeout_secs ?? 0;

  const columns = result?.columns ?? [];
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const hasColumns = columns.length > 0;
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  // A new result invalidates the pin.
  useEffect(() => setPinnedIndex(null), [result]);

  const typedSearch = isSearchVisible ? searchQuery.trim().toLowerCase() : "";
  const searchTerm = useDeferredValue(typedSearch);
  const isSearching = searchTerm.length > 0;
  const isDetailViewOpen = selectedIndex !== null && selectedIndex < rows.length;

  // One lowercase string per row, built only when a search is actually used.
  const searchIndex = useMemo(
    () => (isSearching ? rows.map((row) => row.map((cell) => cellText(cell, prefs.nullText).toLowerCase()).join("\u0000")) : null),
    [isSearching, prefs.nullText, rows],
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
        column.name.toLowerCase().includes(searchTerm) || cellText(value, prefs.nullText).toLowerCase().includes(searchTerm),
    );
  }, [columns, isDetailViewOpen, isSearching, prefs.nullText, rows, searchTerm, selectedIndex]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => recordsTableRef.current,
    estimateSize: () => prefs.rowHeight,
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
      // A dialog or the palette is open: leave Escape (and the find shortcut) to it.
      if (document.querySelector(".modal-backdrop")) return;
      if (matchesCombo(event, prefs.findShortcut)) {
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
  }, [isSearchVisible, prefs.findShortcut]);

  const displayedCount = isDetailViewOpen ? rows.length : rowCount;
  const showTable = result !== null && hasColumns;
  const isRunning = run?.status === "running";

  const closeSearch = () => {
    setSearchQuery("");
    setIsSearchVisible(false);
  };

  const renderBody = () => {
    if (!tab || !run) return <NotRunState connectionName={connection?.name ?? null} name={tab?.name ?? "this tab"} shortcut={executeShortcut} />;
    if (isRunning) return <RunningState abortShortcut={abortShortcut} animation={prefs.loadingAnimation} onCancel={actions.onCancel} run={run} timeoutSecs={timeoutSecs} />;
    if (run.error) {
      return (
        <ErrorCard actions={actions} code={null} connectionName={run.connectionName} message={run.error} position={null} schema={schema} set={null} timeoutSecs={timeoutSecs} />
      );
    }
    if (run.meta) {
      return (
        <div className="command-output-state">
          <CheckIcon className="command-output-icon" />
          <h4>Meta Command Output</h4>
          <pre>{run.meta.text}</pre>
        </div>
      );
    }
    if (showMessages) return <MessagesView run={run} />;
    if (activeSet?.error) {
      return (
        <ErrorCard
          actions={actions}
          code={activeSet.error.code}
          connectionName={run.connectionName}
          message={activeSet.error.message}
          position={activeSet.error.position}
          schema={schema}
          set={activeSet}
          timeoutSecs={timeoutSecs}
        />
      );
    }
    if (result && !hasColumns) return <DoneState elapsedMs={activeSet?.elapsedMs ?? 0} message={result.message ?? "Statement executed"} />;
    if (!result) return <NotRunState connectionName={connection?.name ?? null} name={tab.name} shortcut={executeShortcut} />;
    return (
      <div className="records-table" ref={recordsTableRef}>
        <table>
          <thead>
            <tr>
              {prefs.rowNumbers ? <th className="row-number">#</th> : null}
              {columns.map((column, index) => (
                <th key={index}>{renderHighlightedText(column.name, searchTerm)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowCount > 0 ? (
              <>
                {paddingTop > 0 && (
                  <tr aria-hidden="true" className="virtual-spacer" style={{ height: paddingTop }}>
                    <td colSpan={columns.length + 1} />
                  </tr>
                )}
                {virtualItems.map((item) => {
                  const rowIndex = visibleRows ? visibleRows[item.index] : item.index;
                  const row = rows[rowIndex];
                  return (
                    <tr
                      className={`record-row ${selectedIndex === rowIndex ? "active" : ""} ${pinnedIndex === rowIndex ? "pinned" : ""} ${item.index % 2 ? "odd" : ""}`}
                      data-index={item.index}
                      key={rowIndex}
                      onClick={() => actions.onSelectRow(rowIndex)}
                      ref={virtualizer.measureElement}
                    >
                      {prefs.rowNumbers ? <td className="row-number">{item.index + 1}</td> : null}
                      {columns.map((_, cellIndex) => {
                        const full = cellText(row[cellIndex] ?? null, prefs.nullText);
                        return <SearchHighlightedCell full={full} key={cellIndex} searchTerm={searchTerm} text={clipCell(full)} />;
                      })}
                    </tr>
                  );
                })}
                {paddingBottom > 0 && (
                  <tr aria-hidden="true" className="virtual-spacer" style={{ height: paddingBottom }}>
                    <td colSpan={columns.length + 1} />
                  </tr>
                )}
              </>
            ) : (
              <tr>
                <td className="no-data" colSpan={Math.max(columns.length, 1) + 1}>
                  <div className="empty-table">
                    <p>{isSearching && !isDetailViewOpen ? "No matching records found" : "No records found"}</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  const statusLine = run && !isRunning && activeSet && !activeSet.error && !showMessages ? formatDuration(activeSet.elapsedMs) : null;

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
            {comboText(prefs.findShortcut)}
          </span>
          <button aria-label="Close search" className="close-search-input" onClick={closeSearch} type="button">
            <CloseIcon />
          </button>
        </div>
      )}
      <div className="data-view">
        <div className={`table-section ${isDetailViewOpen ? "with-detail" : ""}`}>
          <div className="table-header">
            <h3>
              Query Results
              {run?.savedResultName ? <span className="result-source">saved result “{run.savedResultName}”</span> : null}
            </h3>
            <div className="table-header-tools">
              {showTable && rows.length > 0 && (
                <button className="button save-button" onClick={actions.onSaveResult} type="button">
                  Save Results
                </button>
              )}
              {statusLine ? <span className="run-time">{statusLine}</span> : null}
              {showTable && (
                <span className="record-count">
                  {displayedCount.toLocaleString()} record{displayedCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>

          {sets.length > 1 && !isRunning ? (
            <div className="rsets" role="tablist">
              {sets.map((set, index) => (
                <button aria-selected={activeIndex === index} className={`rset ${activeIndex === index ? "active" : ""} ${set.error ? "failed" : ""}`} key={index} onClick={() => actions.onSelectSet(index)} role="tab" type="button">
                  <span className="n">{index + 1}</span>
                  {set.label}
                  <span className="muted">{setSummary(set)}</span>
                </button>
              ))}
              <button aria-selected={activeIndex === MESSAGES} className={`rset ${activeIndex === MESSAGES ? "active" : ""}`} onClick={() => actions.onSelectSet(MESSAGES)} role="tab" type="button">
                <TerminalIcon size={12} />
                Messages
              </button>
            </div>
          ) : null}

          {staleFrom && !isRunning && connection ? (
            <div className="banner info">
              <InfoIcon size={14} />
              <span>
                These results came from <b>{staleFrom}</b>, not the active connection.
              </span>
              <span className="sp" />
              <button className="btn" onClick={actions.onRerunHere} type="button">
                Run on {connection.name || "this connection"}
              </button>
            </div>
          ) : null}

          {restoredNote ? (
            <div className="banner subtle">
              <InfoIcon size={14} />
              <span>{restoredNote}</span>
              <span className="sp" />
              <button className="btn" onClick={actions.onRunRestored} type="button">
                Run again
              </button>
              <button aria-label="Dismiss" className="banner-x" onClick={actions.onDismissBanner} type="button">
                <CloseIcon />
              </button>
            </div>
          ) : null}

          {showTable && result.truncated && !isRunning && (
            <div className="banner warn" role="status">
              <InfoIcon size={14} />
              <span>
                <b>Showing the first {rows.length.toLocaleString()} rows.</b> <span className="muted">Search and sorting only see these rows.</span>
              </span>
              <span className="sp" />
              {canLoadMore && (
                <button className="btn" onClick={actions.onLoadMore} type="button">
                  Load more
                </button>
              )}
              <button className="btn ghost" onClick={() => actions.onOpenSettings("results")} type="button">
                Change limit
              </button>
            </div>
          )}

          {isRunning ? <div className="progress"><i /></div> : null}
          {renderBody()}
        </div>

        <div className={`detail-view inspector-shell ${isDetailViewOpen ? "visible" : ""}`}>
          {isDetailViewOpen && selectedIndex !== null ? (
            <RecordInspector
              columns={columns}
              onClose={actions.onCloseDetail}
              onCopy={actions.onCopyLabelled}
              onFilterValue={(text) => {
                actions.onCloseDetail();
                setSearchQuery(text);
                setIsSearchVisible(true);
              }}
              onPin={() => setPinnedIndex((current) => (current === selectedIndex ? null : selectedIndex))}
              onStep={actions.onStepRecord}
              pinnedIndex={pinnedIndex}
              prefs={prefs}
              rows={rows}
              searchTerm={searchTerm}
              selectedIndex={selectedIndex}
              tableName={tableName}
              dialect={connection?.db_type ?? "postgres"}
            />
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
