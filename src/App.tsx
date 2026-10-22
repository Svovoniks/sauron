import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConfirmModal } from "./components/ConfirmModal";
import { ConnectionModal } from "./components/ConnectionModal";
import { ConnectionTabs } from "./components/ConnectionTabs";
import { DataView } from "./components/DataView";
import { ExportModal } from "./components/ExportModal";
import { Notices } from "./components/Notices";
import { QuerySection } from "./components/QuerySection";
import { SaveNameModal } from "./components/SaveNameModal";
import { Sidebar, type SaveScope } from "./components/Sidebar";
import { useAppData } from "./hooks/useAppData";
import { useLayoutResize } from "./hooks/useLayoutResize";
import { useNotices } from "./hooks/useNotices";
import { useQueryRunner } from "./hooks/useQueryRunner";
import { useSqlEditor } from "./hooks/useSqlEditor";
import { itemsOf } from "./lib/appDataOps";
import { isMetaCommand, MAX_ROW_LIMIT } from "./lib/db/query";
import { normalizeBackup } from "./lib/normalize";
import { splitSqlStatements } from "./lib/sql/splitStatements";
import { getPassword, hasPassword } from "./lib/secrets";
import {
  emptyDraft,
  GLOBAL_SCOPE,
  type Connection,
  type ConnectionDraft,
  type SavedQuery,
  type SavedResult,
} from "./types/app";

type PendingDelete =
  | { type: "connection"; item: Connection }
  | { type: "query"; item: SavedQuery; scope: string }
  | { type: "result"; item: SavedResult; scope: string };

interface ConnectionModalState {
  draft: ConnectionDraft;
  isEditing: boolean;
  hasSavedPassword: boolean | null;
}

/** A bigger file would make the editor sluggish; run huge dumps with psql. */
const MAX_SQL_FILE_CHARS = 5_000_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function App() {
  const { notices, notify, dismiss } = useNotices();
  const appData = useAppData(notify);
  const { data } = appData;
  const runner = useQueryRunner();
  const layout = useLayoutResize();
  const recordsTableRef = useRef<HTMLDivElement | null>(null);

  const [queryText, setQueryText] = useState("SELECT 1");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [activeSaveScope, setActiveSaveScope] = useState<SaveScope>("local");
  const [activeSidebarTab, setActiveSidebarTab] = useState<"queries" | "results">("queries");
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);

  const [connectionModal, setConnectionModal] = useState<ConnectionModalState | null>(null);
  const [showSaveQueryModal, setShowSaveQueryModal] = useState(false);
  const [showSaveResultModal, setShowSaveResultModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const activeConnection = useMemo(
    () => data.connections.find((connection) => connection.id === data.activeConnectionId) ?? null,
    [data.activeConnectionId, data.connections],
  );

  /** Storage scope of the list shown in the sidebar (null = local list without a connection). */
  const sidebarScope = activeSaveScope === "global" ? GLOBAL_SCOPE : (activeConnection?.id ?? null);
  const savedQueries = sidebarScope ? itemsOf(data, "queries", sidebarScope) : [];
  const savedResults = sidebarScope ? itemsOf(data, "results", sidebarScope) : [];

  const modalOpen = Boolean(connectionModal || showSaveQueryModal || showSaveResultModal || showExportModal || pendingDelete);
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

  // --- running queries ----------------------------------------------------------------------
  const executeQuery = () => {
    // The single guard for every way of starting a query (button, window shortcut, editor shortcut).
    if (modalOpenRef.current || runner.isLoading) return;
    if (!activeConnection) {
      runner.reportError("No active connection selected.");
      return;
    }
    setSelectedIndex(null);
    runner.run(activeConnection, queryText);
  };

  const loadMore = () => {
    const last = runner.lastRun;
    if (!last || runner.isLoading) return;
    setSelectedIndex(null);
    runner.run(last.connection, last.sql, Math.min(last.rowLimit * 10, MAX_ROW_LIMIT));
  };

  const executeRef = useRef(executeQuery);
  executeRef.current = executeQuery;

  const { editorRef, editorContainerRef, replaceText } = useSqlEditor(
    queryText,
    activeConnection?.db_type ?? "postgres",
    setQueryText,
    () => executeRef.current(),
  );

  const rowCount = runner.result?.rows.length ?? 0;
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInputTarget = Boolean(
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
      );

      if (event.ctrlKey && event.key === "Enter") {
        if (isTextInputTarget) return;
        event.preventDefault();
        executeRef.current();
        return;
      }

      if (modalOpenRef.current || isTextInputTarget) return;

      if (event.key === "Escape") {
        setSelectedIndex(null);
        return;
      }

      if (selectedIndex === null || rowCount === 0 || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setSelectedIndex((selectedIndex + 1) % rowCount);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setSelectedIndex((selectedIndex - 1 + rowCount) % rowCount);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [rowCount, selectedIndex]);

  // --- connections --------------------------------------------------------------------------
  const addConnection = () => setConnectionModal({ draft: emptyDraft(), isEditing: false, hasSavedPassword: null });

  const editConnection = (connection: Connection) => {
    setConnectionModal({ draft: { ...connection, password: "" }, isEditing: true, hasSavedPassword: null });
    hasPassword(connection.id)
      .then((saved) => setConnectionModal((current) => (current ? { ...current, hasSavedPassword: saved } : current)))
      .catch(() => undefined);
  };

  const saveConnection = async (draft: ConnectionDraft) => {
    if (await appData.saveConnection(draft)) setConnectionModal(null);
  };

  const selectTab = (connection: Connection) => {
    if (connection.id === data.activeConnectionId) return;
    // A running query belongs to the previous connection.
    if (runner.isLoading) runner.abort();
    appData.selectConnection(connection.id);
  };

  // --- saved queries & results ----------------------------------------------------------------
  const saveQueryConfirmed = (name: string) => {
    if (!sidebarScope) {
      notify("error", "Select a connection first, or switch to Global.");
      return;
    }
    appData.addQuery(sidebarScope, { id: crypto.randomUUID(), name, query: queryText });
    setShowSaveQueryModal(false);
  };

  /** Local results are filed under the connection that produced them. */
  const resultScope = activeSaveScope === "global" ? GLOBAL_SCOPE : (runner.resultConnectionId ?? activeConnection?.id ?? null);

  const saveResultConfirmed = (name: string) => {
    const result = runner.result;
    if (!result || !resultScope) return;
    appData.addResult(resultScope, {
      id: crypto.randomUUID(),
      name,
      query: runner.lastRun?.sql ?? queryText,
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
    });
    setShowSaveResultModal(false);
  };

  const overwriteQuery = (query: SavedQuery) => {
    if (sidebarScope) appData.overwriteQuery(sidebarScope, query.id, queryText);
  };

  const overwriteResult = (saved: SavedResult) => {
    const result = runner.result;
    if (!sidebarScope) return;
    if (!result || result.columns.length === 0) {
      notify("error", "There is no result to save. Run a query first.");
      return;
    }
    appData.overwriteResult(sidebarScope, saved.id, {
      query: runner.lastRun?.sql ?? queryText,
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
    });
  };

  const selectQuery = (query: SavedQuery) => {
    setActiveQueryId(query.id);
    setQueryText(query.query);
    editorRef.current?.setValue(query.query);
  };

  const selectResult = (saved: SavedResult) => {
    setActiveResultId(saved.id);
    setSelectedIndex(null);
    runner.showSavedResult(
      { columns: saved.columns, rows: saved.rows, truncated: saved.truncated, message: null },
      sidebarScope === GLOBAL_SCOPE ? null : sidebarScope,
    );
    setQueryText(saved.query);
    editorRef.current?.setValue(saved.query);
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === "connection") {
      if (runner.isLoading && pendingDelete.item.id === data.activeConnectionId) runner.abort();
      appData.deleteConnection(pendingDelete.item.id);
    } else if (pendingDelete.type === "query") {
      appData.removeQuery(pendingDelete.scope, pendingDelete.item.id);
    } else {
      appData.removeResult(pendingDelete.scope, pendingDelete.item.id);
    }
    setPendingDelete(null);
  };

  const deleteModalText = (() => {
    if (!pendingDelete) return { title: "", message: "" };
    if (pendingDelete.type === "connection") {
      return {
        title: "Delete Connection",
        message: `Are you sure you want to delete "${pendingDelete.item.name || "Unnamed"}"? Its saved queries, saved results and password are deleted too.`,
      };
    }
    const scopeLabel = pendingDelete.scope === GLOBAL_SCOPE ? "global " : "";
    return pendingDelete.type === "query"
      ? { title: "Delete Query", message: `Are you sure you want to delete ${scopeLabel}saved query "${pendingDelete.item.name}"?` }
      : { title: "Delete Result", message: `Are you sure you want to delete ${scopeLabel}saved result "${pendingDelete.item.name}"?` };
  })();

  // --- SQL files ------------------------------------------------------------------------------
  const openSqlFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      const text = await readTextFile(selected);
      if (text.length > MAX_SQL_FILE_CHARS) {
        notify("error", `The file is too large for the editor (${(text.length / 1_000_000).toFixed(1)} million characters, limit ${MAX_SQL_FILE_CHARS / 1_000_000}). Use psql for big dumps.`);
        return;
      }

      replaceText(text);
      setQueryText(text);
      setActiveQueryId(null);
      const name = selected.split(/[\\/]/).pop() ?? selected;
      const count = splitSqlStatements(text, activeConnection?.db_type ?? "postgres").length;
      notify("info", `Loaded ${name}: ${count} statement${count === 1 ? "" : "s"}. Review it, then press Execute. Only the last statement's result is shown.`);
    } catch (error) {
      notify("error", `Could not open the file: ${errorText(error)}`);
    }
  };

  // --- export / import ------------------------------------------------------------------------
  const exportConnections = async (includePasswords: boolean) => {
    setShowExportModal(false);
    try {
      const filePath = await save({ filters: [{ name: "JSON", extensions: ["json"] }], defaultPath: "sauron-export.json" });
      if (!filePath) return;
      await writeTextFile(filePath, await appData.exportText(includePasswords));
      notify(
        "info",
        includePasswords
          ? "Exported connections, queries and results. The file contains your passwords in plain text - keep it safe."
          : "Exported connections, queries and results. Passwords are not included.",
      );
    } catch (error) {
      notify("error", `Export failed: ${errorText(error)}`);
    }
  };

  const importConnections = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!selected || Array.isArray(selected)) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readTextFile(selected));
      } catch {
        notify("error", "Import failed: the file is not valid JSON.");
        return;
      }

      const backup = normalizeBackup(parsed);
      if (!backup) {
        notify("error", "Import failed: this does not look like a Sauron export.");
        return;
      }

      await appData.importBackup(backup);
      const count = (scopes: Record<string, unknown[]>) => Object.values(scopes).reduce((sum, list) => sum + list.length, 0);
      notify(
        "info",
        `Imported ${backup.connections.length} connection(s), ${count(backup.queries)} saved quer${count(backup.queries) === 1 ? "y" : "ies"} and ${count(backup.results)} saved result(s). Existing items were kept.`,
      );
    } catch (error) {
      notify("error", `Import failed: ${errorText(error)}`);
    }
  };

  const startWindowDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    getCurrentWindow()
      .startDragging()
      .catch((error) => console.warn("Failed to start window drag.", error));
  };

  const resultSource =
    runner.resultConnectionId && runner.resultConnectionId !== activeConnection?.id
      ? (data.connections.find((connection) => connection.id === runner.resultConnectionId)?.name ?? "another connection")
      : null;

  return (
    <div
      className={`app-container ${layout.resizeAxis ? `resizing-layout resizing-layout-${layout.resizeAxis}` : ""}`}
      ref={layout.appContainerRef}
      style={layout.layoutStyle}
    >
      <div className="window-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />

      <ConnectionTabs
        activeConnectionId={data.activeConnectionId}
        connections={data.connections}
        onAddConnection={addConnection}
        onDeleteConnection={(connection) => setPendingDelete({ type: "connection", item: connection })}
        onEditConnection={editConnection}
        onExportConnections={() => setShowExportModal(true)}
        onImportConnections={importConnections}
        onReorderConnections={appData.moveConnection}
        onSelectTab={selectTab}
        onWindowDragStart={startWindowDrag}
      />

      <div className="workspace-layout">
        <div className="main-content" ref={layout.mainContentRef}>
          <Sidebar
            activeQueryId={activeQueryId}
            activeResultId={activeResultId}
            activeSaveScope={activeSaveScope}
            activeSidebarTab={activeSidebarTab}
            onDeleteQuery={(query) => sidebarScope && setPendingDelete({ type: "query", item: query, scope: sidebarScope })}
            onDeleteResult={(result) => sidebarScope && setPendingDelete({ type: "result", item: result, scope: sidebarScope })}
            onOverwriteQuery={overwriteQuery}
            onOverwriteResult={overwriteResult}
            onReorderQuery={(from, to) => sidebarScope && appData.moveQuery(sidebarScope, from, to)}
            onReorderResult={(from, to) => sidebarScope && appData.moveResult(sidebarScope, from, to)}
            onSelectQuery={selectQuery}
            onSelectResult={selectResult}
            onSetSaveScope={setActiveSaveScope}
            onSetSidebarTab={setActiveSidebarTab}
            savedQueries={savedQueries}
            savedResults={savedResults}
          />

          <div
            aria-label="Resize Saved Stuff and Query Results panels"
            aria-orientation="vertical"
            className="layout-resize-gutter"
            onKeyDown={(event) => {
              if (event.target === event.currentTarget) layout.resizeWithKeyboard(event, "x");
            }}
            onPointerCancel={layout.stop}
            onPointerDown={(event) => layout.start(event, "x")}
            onPointerMove={layout.move}
            onPointerUp={layout.stop}
            role="separator"
            tabIndex={0}
          >
            <button
              aria-label="Resize Saved Stuff, Query Results, and SQL Query panels"
              className="layout-resize-handle"
              onDoubleClick={layout.reset}
              onKeyDown={(event) => layout.resizeWithKeyboard(event, "both")}
              onPointerCancel={layout.stop}
              onPointerDown={(event) => layout.start(event, "both")}
              onPointerMove={layout.move}
              onPointerUp={layout.stop}
              title="Drag to resize all three panels. Double-click to reset."
              type="button"
            />
          </div>

          <DataView
            canLoadMore={Boolean(runner.result?.truncated && runner.lastRun && runner.lastRun.rowLimit < MAX_ROW_LIMIT)}
            isLoading={runner.isLoading}
            onCloseDetail={() => setSelectedIndex(null)}
            onLoadMore={loadMore}
            onSaveResult={() => setShowSaveResultModal(true)}
            onSelectRow={(index) => setSelectedIndex((current) => (current === index ? null : index))}
            queryError={runner.error}
            queryOutput={runner.metaOutput}
            recordsTableRef={recordsTableRef}
            result={runner.result}
            resultSource={resultSource}
            selectedIndex={selectedIndex}
          />
        </div>

        <div
          aria-label="Resize upper panels and SQL Query panel"
          aria-orientation="horizontal"
          className="layout-horizontal-resize-gutter"
          onKeyDown={(event) => layout.resizeWithKeyboard(event, "y")}
          onPointerCancel={layout.stop}
          onPointerDown={(event) => layout.start(event, "y")}
          onPointerMove={layout.move}
          onPointerUp={layout.stop}
          role="separator"
          tabIndex={0}
        />

        <QuerySection
          editorContainerRef={editorContainerRef}
          isCommandQuery={isMetaCommand(queryText)}
          isLoading={runner.isLoading}
          onAbortQuery={runner.abort}
          onExecuteQuery={executeQuery}
          onOpenFile={openSqlFile}
          onSaveQuery={() => setShowSaveQueryModal(true)}
        />
      </div>

      {connectionModal && (
        <ConnectionModal
          hasSavedPassword={connectionModal.hasSavedPassword}
          initial={connectionModal.draft}
          isEditing={connectionModal.isEditing}
          onClose={() => setConnectionModal(null)}
          onSave={saveConnection}
          loadSavedPassword={() => getPassword(connectionModal.draft.id)}
        />
      )}

      {showExportModal && (
        <ExportModal
          connectionCount={data.connections.length}
          onClose={() => setShowExportModal(false)}
          onExport={exportConnections}
        />
      )}

      {showSaveQueryModal && (
        <SaveNameModal
          inputId="query-name"
          label="Query Name"
          onClose={() => setShowSaveQueryModal(false)}
          onSave={saveQueryConfirmed}
          title="Save Query"
        />
      )}

      {showSaveResultModal && (
        <SaveNameModal
          inputId="result-name"
          label="Result Name"
          onClose={() => setShowSaveResultModal(false)}
          onSave={saveResultConfirmed}
          title="Save Result"
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          confirmText="Delete"
          message={deleteModalText.message}
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          title={deleteModalText.title}
        />
      )}

      <Notices notices={notices} onDismiss={dismiss} />
    </div>
  );
}
