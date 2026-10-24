import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { COMMAND_ICONS } from "./components/commandIcons";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { ConfirmModal } from "./components/ConfirmModal";
import { ConnectionModal } from "./components/ConnectionModal";
import { ConnectionTabs, OPEN_SWITCHER_EVENT } from "./components/ConnectionTabs";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { DataView } from "./components/DataView";
import { ExportModal } from "./components/ExportModal";
import { HistoryPanel, normalizeSql } from "./components/HistoryPanel";
import { Notices } from "./components/Notices";
import { ProdGuardModal } from "./components/ProdGuardModal";
import { QuerySection } from "./components/QuerySection";
import { QueryTabs } from "./components/QueryTabs";
import { SaveNameModal } from "./components/SaveNameModal";
import { SchemaPanel } from "./components/SchemaPanel";
import { SettingsModal, settingsSections, settingValueText, type SettingsSection } from "./components/SettingsModal";
import { Sidebar, type SaveScope, type SidebarMode } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { UpdateModal } from "./components/UpdateModal";
import { Welcome } from "./components/Welcome";
import { useAppData } from "./hooks/useAppData";
import { useConnectionStatus } from "./hooks/useConnectionStatus";
import { useHistory } from "./hooks/useHistory";
import { useLayoutResize } from "./hooks/useLayoutResize";
import { useNotices } from "./hooks/useNotices";
import { useSchema } from "./hooks/useSchema";
import { useSettings } from "./hooks/useSettings";
import { useUpdater } from "./hooks/useUpdater";
import { useSqlEditor, type RunKind } from "./hooks/useSqlEditor";
import { useWorkspace, type RunRequest, type RunSummary } from "./hooks/useWorkspace";
import { itemsOf } from "./lib/appDataOps";
import { formatConnectionUrl } from "./lib/connUrl";
import { isMetaCommand, MAX_ROW_LIMIT, testConnection } from "./lib/db/query";
import { findIdentifier, tokenLengthAt } from "./lib/errors";
import { dayLabel, timeLabel, type HistoryEntry } from "./lib/history";
import { normalizeBackup } from "./lib/normalize";
import { qualifiedName, type SchemaTable } from "./lib/schema";
import { getPassword, hasPassword } from "./lib/secrets";
import { monacoTheme } from "./lib/themes";
import { accentOverride, comboText, DENSITY_ROW_HEIGHT, matchesCombo, matchesShortcut } from "./lib/settings";
import { isRiskyMetaCommand, isWriteStatement } from "./lib/sql/analyze";
import { splitSqlRanges, splitSqlStatements } from "./lib/sql/splitStatements";
import {
  emptyDraft,
  GLOBAL_SCOPE,
  type Connection,
  type ConnectionDraft,
  type Env,
  type SavedQuery,
  type SavedResult,
} from "./types/app";
import { MESSAGES, type QueryTab, type ResultSet } from "./types/workspace";
import packageJson from "../package.json";

type PendingDelete =
  | { type: "connection"; item: Connection }
  | { type: "query"; item: SavedQuery; scope: string }
  | { type: "result"; item: SavedResult; scope: string };

interface ConnectionModalState {
  draft: ConnectionDraft;
  isEditing: boolean;
  hasSavedPassword: boolean | null;
  focusUrl: boolean;
}

/** A bigger file would make the editor sluggish; run huge dumps with psql. */
const MAX_SQL_FILE_CHARS = 5_000_000;
/** Selecting a connection that was found reachable less than this long ago does not check it again. */
const WARM_COOLDOWN_MS = 30_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The table a statement reads from, for "Copy as INSERT". */
const guessTable = (sql: string | undefined): string | null => {
  const match = sql ? /\bfrom\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i.exec(sql) : null;
  return match ? match[1] : null;
};

interface SavePrompt {
  sql: string;
  initialName: string;
  /** Link the active tab to the new saved query. */
  linkTab: boolean;
}

export default function App() {
  const { notices, notify, dismiss } = useNotices();
  const notifyError = useCallback((message: string) => notify("error", message), [notify]);
  const settingsStore = useSettings(notifyError);
  const { settings } = settingsStore;
  const appData = useAppData(notify);
  const { data } = appData;
  const history = useHistory(settings.historyKeep, settingsStore.loaded, notifyError);
  const schemas = useSchema();
  const connStatus = useConnectionStatus();
  const warming = useRef(new Set<string>());
  const warmedAt = useRef(new Map<string, number>());
  const layout = useLayoutResize();
  const recordsTableRef = useRef<HTMLDivElement | null>(null);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [activeSaveScope, setActiveSaveScope] = useState<SaveScope>("local");
  const [activeSidebarTab, setActiveSidebarTab] = useState<"queries" | "results">("queries");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("saved");
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [restoredNotes, setRestoredNotes] = useState<Record<string, string>>({});
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);

  const [connectionModal, setConnectionModal] = useState<ConnectionModalState | null>(null);
  const [savePrompt, setSavePrompt] = useState<SavePrompt | null>(null);
  const [showSaveResultModal, setShowSaveResultModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [settingsModal, setSettingsModal] = useState<{ section?: SettingsSection; focusRow?: string } | null>(null);
  const [palette, setPalette] = useState<{ initialQuery: string } | null>(null);
  const [pendingGuard, setPendingGuard] = useState<{ request: RunRequest; writes: string[] } | null>(null);
  const [pendingRisky, setPendingRisky] = useState<RunRequest | null>(null);
  const [pendingClose, setPendingClose] = useState<string[] | null>(null);
  const [pendingClearHistory, setPendingClearHistory] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);

  const updater = useUpdater({
    ready: settingsStore.loaded,
    autoUpdate: settings.autoUpdate,
    skippedVersion: settings.skippedUpdate,
    onOffer: () => {
      setSettingsModal(null); // one dialog at a time
      setShowUpdate(true);
    },
  });
  const updateDialogOpen = showUpdate && ["available", "downloading", "installing", "ready", "error"].includes(updater.state.kind);
  const updateStatus = (() => {
    const u = updater.state;
    if (u.kind === "checking") return "checking…";
    if (u.kind === "uptodate") return "you are on the latest version";
    if (u.kind === "available") return `version ${u.info.version} is available`;
    if (u.kind === "downloading" || u.kind === "installing") return "updating…";
    if (u.kind === "ready") return "restart to finish updating";
    if (u.kind === "error") return `could not update: ${u.message.split("\n")[0]}`;
    return "";
  })();

  const lastUpdateKind = useRef(updater.state.kind);
  useEffect(() => {
    const kind = updater.state.kind;
    if (kind === lastUpdateKind.current) return;
    lastUpdateKind.current = kind;
    if (kind === "uptodate") notify("info", "You are on the latest version.");
    else if (kind === "error" && !showUpdate) notify("error", `Could not check for updates: ${updater.state.message.split("\n")[0]}`);
  }, [updater.state, showUpdate, notify]);

  // --- workspace (tabs + runs) -----------------------------------------------------------------
  const runFinishedRef = useRef<(summary: RunSummary) => void>(() => undefined);
  const savedTextRef = useRef<(tab: QueryTab) => string | null>(() => null);
  savedTextRef.current = (tab) => {
    if (!tab.savedQueryId || !tab.savedScope) return null;
    return itemsOf(data, "queries", tab.savedScope).find((q) => q.id === tab.savedQueryId)?.query ?? null;
  };
  const ws = useWorkspace({
    ready: appData.loaded && settingsStore.settled,
    connections: data.connections,
    restoreSession: settings.restoreSession,
    savedText: (tab) => savedTextRef.current(tab),
    onRunFinished: (summary) => runFinishedRef.current(summary),
    onError: notifyError,
  });
  const { activeTab } = ws;
  const activeRun = activeTab ? (ws.runs[activeTab.id] ?? null) : null;

  const activeConnection = useMemo(
    () => data.connections.find((connection) => connection.id === activeTab?.connectionId) ?? null,
    [data.connections, activeTab?.connectionId],
  );
  const dbType = activeConnection?.db_type ?? "postgres";
  const schemaState = schemas.get(activeConnection?.id ?? null);
  const defaultSchema = useMemo(() => {
    const schema = schemaState.schema;
    if (!schema) return "public";
    if (schema.dbType === "clickhouse") return activeConnection?.database || schema.schemas[0] || "default";
    return schema.schemas.includes("public") ? "public" : (schema.schemas[0] ?? "public");
  }, [schemaState.schema, activeConnection?.database]);

  // The tab decides which connection is active; keep the persisted "active connection" and the tab in step.
  useEffect(() => {
    if (!ws.initialized || !activeTab) return;
    const known = data.connections.some((c) => c.id === activeTab.connectionId);
    if (!known) {
      const fallback = data.connections.find((c) => c.id === data.activeConnectionId) ?? data.connections[0];
      if (activeTab.connectionId !== (fallback?.id ?? null)) ws.patchTab(activeTab.id, { connectionId: fallback?.id ?? null });
    } else if (activeTab.connectionId !== data.activeConnectionId && activeTab.connectionId) {
      appData.selectConnection(activeTab.connectionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.initialized, activeTab?.id, activeTab?.connectionId, data.connections, data.activeConnectionId]);

  // Other tabs that point at a deleted connection fall back to the first one.
  useEffect(() => {
    if (!ws.initialized) return;
    const ids = new Set(data.connections.map((c) => c.id));
    ws.tabs.forEach((tab) => {
      if (tab.connectionId && !ids.has(tab.connectionId)) ws.patchTab(tab.id, { connectionId: data.connections[0]?.id ?? null });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.connections, ws.initialized]);

  // The last known schema of the active connection, from disk (no network).
  useEffect(() => {
    if (activeConnection) void schemas.restore(activeConnection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnection?.id, activeConnection?.host, activeConnection?.database]);

  /** Storage scope of the list shown in the sidebar (null = no connection). */
  const sidebarScope = activeSaveScope === "global" ? GLOBAL_SCOPE : (activeConnection?.id ?? null);
  const savedQueries = sidebarScope ? itemsOf(data, "queries", sidebarScope) : [];
  const savedResults = sidebarScope ? itemsOf(data, "results", sidebarScope) : [];
  const savedTexts = useMemo(() => {
    const set = new Set<string>();
    for (const scope of [GLOBAL_SCOPE, activeConnection?.id]) {
      if (scope) itemsOf(data, "queries", scope).forEach((q) => set.add(normalizeSql(q.query)));
    }
    return set;
  }, [data, activeConnection?.id]);

  const modalOpen = Boolean(connectionModal || savePrompt || showSaveResultModal || showExportModal || pendingDelete || settingsModal || palette || pendingGuard || pendingRisky || pendingClose || pendingClearHistory || updateDialogOpen);
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = palette !== null;

  const copy = useCallback(
    (text: string, label?: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => notify("info", label ? `Copied ${label}` : "Copied to clipboard"))
        .catch(() => notify("error", "Could not copy to the clipboard."));
    },
    [notify],
  );

  // --- the editor -----------------------------------------------------------------------------
  const runRef = useRef<(kind: RunKind) => void>(() => undefined);
  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const tabsRef = useRef(ws.tabs);
  tabsRef.current = ws.tabs;
  const connectionsRef = useRef(data.connections);
  connectionsRef.current = data.connections;

  const editorTheme = useMemo(
    () => monacoTheme(settings.theme, settingsStore.appearance, accentOverride(settings.accent)),
    [settings.theme, settings.accent, settingsStore.appearance],
  );
  const editor = useSqlEditor({
    activeTabId: ws.activeTabId,
    tabInfo: (tabId) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return null;
      const connection = connectionsRef.current.find((c) => c.id === tab.connectionId);
      return { sql: tab.sql, dbType: connection?.db_type ?? "postgres" };
    },
    activeDbType: dbType,
    onTextChange: (tabId, text) => ws.patchTab(tabId, { sql: text }),
    onRun: (kind) => runRef.current(kind),
    onShortcut: (event) => shortcutHandlerRef.current(event),
    settings,
    theme: editorTheme,
    completion: { schema: schemaState.schema, enabled: settings.autocomplete, defaultSchema },
    outlineStatements: true,
  });

  // --- running queries ------------------------------------------------------------------------
  const rowCount = activeRun?.sets[activeRun.activeSet]?.result?.rows.length ?? 0;

  const startRequest = useCallback(
    (request: RunRequest) => {
      setSelectedIndex(null);
      editor.clearMarkers();
      setRestoredNotes((notes) => {
        if (!(request.tabId in notes)) return notes;
        const { [request.tabId]: _gone, ...rest } = notes;
        return rest;
      });
      ws.startRun(request);
    },
    [editor, ws],
  );

  /** Guards in front of a run: production writes and risky backslash commands. */
  const requestRun = useCallback(
    (request: RunRequest) => {
      const { connection } = request;
      if (isMetaCommand(request.text)) {
        if (settings.warnBackslash && isRiskyMetaCommand(request.text)) return setPendingRisky(request);
        return startRequest(request);
      }
      // Read-only is the database's own mode and a script can switch it off again, so the guard does not trust it.
      if (connection.env === "prod" && settings.confirmProdWrites) {
        const writes = splitSqlStatements(request.text, connection.db_type).filter((statement) => isWriteStatement(statement, connection.db_type));
        if (writes.length > 0) return setPendingGuard({ request, writes });
      }
      startRequest(request);
    },
    [settings.warnBackslash, settings.confirmProdWrites, startRequest],
  );

  const runNow = (kind: RunKind) => {
    // The single guard for every way of starting a query (button, window shortcut, editor shortcut).
    if (modalOpenRef.current || !activeTab) return;
    if (ws.runningTabId) {
      if (ws.runningTabId !== activeTab.id) notify("info", `A query is still running in “${ws.tabs.find((t) => t.id === ws.runningTabId)?.name ?? "another tab"}”. Wait for it or abort it first.`);
      return;
    }
    if (!activeConnection) {
      ws.reportError(activeTab.id, "No active connection selected.");
      return;
    }
    const target = editor.getRunTarget(kind === "explain" ? "statement" : kind, settings.execScope);
    let text = target.text;
    if (kind === "explain" && text.trim() && !isMetaCommand(text)) text = `explain ${text}`;
    if (!text.trim()) {
      ws.reportError(activeTab.id, "No SQL statement to execute.");
      return;
    }
    requestRun({
      tabId: activeTab.id,
      connection: activeConnection,
      text,
      offset: kind === "explain" ? -1 : target.offset,
      rowLimit: settings.rowLimit,
      psql: { path: settings.psqlPath, useFallback: settings.psqlFallback },
    });
  };
  runRef.current = runNow;

  /** Run `sql` in a fresh tab (schema panel, history). */
  const openAndRun = (sql: string, name: string, connection: Connection | null = activeConnection) => {
    if (ws.runningTabId) {
      notify("info", "A query is still running. Wait for it or abort it first.");
      return;
    }
    const tab = ws.addTab({ name, sql, connectionId: connection?.id ?? null });
    setSelectedIndex(null);
    if (!connection) return;
    window.setTimeout(
      () =>
        requestRun({
          tabId: tab.id,
          connection,
          text: sql,
          offset: 0,
          rowLimit: settings.rowLimit,
          psql: { path: settings.psqlPath, useFallback: settings.psqlFallback },
        }),
      0,
    );
  };

  const loadMore = () => {
    if (!activeRun || !activeTab || !activeConnection || ws.runningTabId) return;
    // Only the statement that was cut short: earlier statements of a script must not run twice.
    const set = activeRun.sets[activeRun.activeSet];
    requestRun({
      tabId: activeTab.id,
      connection: activeConnection,
      text: set ? set.sql : activeRun.runSql,
      offset: set ? set.offset : activeRun.runOffset,
      rowLimit: Math.min(activeRun.rowLimit * 10, MAX_ROW_LIMIT),
      psql: { path: settings.psqlPath, useFallback: settings.psqlFallback },
    });
  };

  /** The part of the last run from `set` onward (statements before it already ran and are not repeated). */
  const textFrom = (set: ResultSet | null | undefined, runSql: string, runOffset: number) =>
    set && runOffset >= 0 && set.offset >= runOffset ? runSql.slice(set.offset - runOffset) : runSql;

  /** Run the text of the last run again, optionally replacing it or overriding the timeout. */
  const rerunLast = (override: { text?: string; offset?: number; timeoutSecs?: number } = {}) => {
    if (!activeRun || !activeTab || !activeConnection || ws.runningTabId) return;
    requestRun({
      tabId: activeTab.id,
      connection: activeConnection,
      text: override.text ?? activeRun.runSql,
      offset: override.offset ?? activeRun.runOffset,
      rowLimit: activeRun.rowLimit || settings.rowLimit,
      psql: { path: settings.psqlPath, useFallback: settings.psqlFallback },
      timeoutSecs: override.timeoutSecs,
    });
  };

  // History + status when a run ends.
  runFinishedRef.current = (summary) => {
    const { request } = summary;
    history.add({
      at: Date.now(),
      sql: request.text.trim(),
      connectionId: request.connection.id,
      connectionName: request.connection.name,
      status: summary.status,
      ms: summary.ms,
      rows: summary.rows,
      affected: summary.affected,
      truncated: summary.truncated,
      error: summary.error,
    });
    setActiveHistoryId(null);

    const reachable = !summary.connectionFailed;
    const wasKnown = connStatus.get(request.connection.id).state === "ok";
    connStatus.mark(request.connection.id, reachable ? { state: "ok" } : { state: "err", error: summary.error });
    if (reachable && !wasKnown && settings.autocomplete) void schemas.load(request.connection);

    // Point at the error in the editor.
    const failed = summary.sets.find((set) => set.error?.position);
    if (failed?.error?.position && failed.offset >= 0 && request.tabId === ws.activeTabId) {
      editor.markError(failed.offset + failed.error.position - 1, tokenLengthAt(failed.sql, failed.error.position), failed.error.message.split("\n")[0]);
    }
  };

  const abort = () => ws.abort();

  // --- tabs ----------------------------------------------------------------------------------
  const selectTab = (id: string) => {
    if (id === ws.activeTabId) return;
    ws.setActiveTabId(id);
    setSelectedIndex(null);
    window.setTimeout(() => editor.focus(), 0);
  };

  const newTab = (init: Partial<QueryTab> = {}) => {
    ws.addTab({ connectionId: activeConnection?.id ?? data.activeConnectionId, ...init });
    setSelectedIndex(null);
    window.setTimeout(() => editor.focus(), 0);
  };

  const closeTabsNow = (ids: string[]) => {
    if (ws.runningTabId && ids.includes(ws.runningTabId)) ws.abort();
    ws.closeTabs(ids);
    ids.forEach((id) => editor.dropModel(id));
    setSelectedIndex(null);
  };

  /** A tab with text that was never run (so it is not in the history) and is not a saved query. */
  const unsavedScratch = (id: string) => {
    const tab = ws.tabs.find((t) => t.id === id);
    return Boolean(tab && !tab.savedQueryId && tab.sql.trim() && tab.sql.trim() !== "SELECT 1" && !ws.runs[id]);
  };

  const requestCloseTabs = (ids: string[]) => {
    const unsaved = ids.filter((id) => ws.dirtyTabs.has(id) || unsavedScratch(id));
    if (unsaved.length > 0) setPendingClose(ids);
    else closeTabsNow(ids);
  };

  const tabMenuItems = (id: string): MenuItem[] => {
    const tab = ws.tabs.find((t) => t.id === id);
    if (!tab) return [];
    const others = ws.tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id);
    return [
      { label: tab.pinned ? "Unpin" : "Pin tab", onSelect: () => ws.togglePin(id) },
      { label: "Duplicate", onSelect: () => ws.duplicateTab(id) },
      { label: "Save as query…", onSelect: () => setSavePrompt({ sql: tab.sql, initialName: tab.name.startsWith("untitled") ? "" : tab.name, linkTab: id === ws.activeTabId }) },
      { type: "separator" },
      { label: "Close", onSelect: () => requestCloseTabs([id]) },
      { label: "Close others", disabled: others.length === 0, onSelect: () => requestCloseTabs(others) },
    ];
  };

  // --- connections ----------------------------------------------------------------------------
  const draftDefaults = useMemo(
    () => ({ readOnly: settings.newConnectionReadOnly, timeoutSecs: settings.defaultTimeoutSecs, sslMode: settings.defaultSslMode }),
    [settings.newConnectionReadOnly, settings.defaultTimeoutSecs, settings.defaultSslMode],
  );

  const addConnection = (focusUrl = false) =>
    setConnectionModal({ draft: emptyDraft(draftDefaults), isEditing: false, hasSavedPassword: null, focusUrl });

  const editConnection = (connection: Connection) => {
    setConnectionModal({ draft: { ...connection, password: "" }, isEditing: true, hasSavedPassword: null, focusUrl: false });
    hasPassword(connection.id)
      .then((saved) => setConnectionModal((current) => (current ? { ...current, hasSavedPassword: saved } : current)))
      .catch(() => undefined);
  };

  const duplicateConnection = async (connection: Connection) => {
    let password = "";
    try {
      password = (await getPassword(connection.id)) ?? "";
    } catch {
      /* the copy just starts without a password */
    }
    const id = await appData.saveConnection({ ...connection, id: "", name: `${connection.name || "Unnamed"} copy`, password });
    if (id) notify("info", `Created “${connection.name || "Unnamed"} copy”.`);
  };

  const saveConnection = async (draft: ConnectionDraft) => {
    const id = await appData.saveConnection(draft);
    if (!id) return;
    setConnectionModal(null);
    if (connectionModal?.isEditing) {
      // host / database / type may have changed
      schemas.forget(id);
      connStatus.mark(id, { state: "", version: null });
    } else {
      selectConnectionTab({ ...draft, id } as Connection);
      notify("info", `Connection saved${draft.read_only ? " · read-only" : ""}. ${draft.password ? "The password is stored securely on this computer." : ""}`.trim());
    }
  };

  /**
   * Selecting a connection checks it (so its dot lights up green or red) and, once it answers, reads its schema
   * in the background so the tree and autocomplete are ready. Read-only: nothing is written. Clicking the same
   * connection again within a short while does not reconnect.
   */
  const warmUp = async (connection: Connection) => {
    const id = connection.id;
    if (warming.current.has(id)) return;
    const last = warmedAt.current.get(id) ?? 0;
    if (Date.now() - last < WARM_COOLDOWN_MS && connStatus.get(id).state === "ok") return;
    warming.current.add(id);
    warmedAt.current.set(id, Date.now());
    connStatus.mark(id, { state: "checking" });
    try {
      const report = await testConnection(connection);
      if (report.ok) {
        connStatus.mark(id, { state: "ok", version: report.server_version });
        void schemas.load(connection);
      } else {
        connStatus.mark(id, { state: "err", error: report.steps[report.steps.length - 1]?.detail ?? "failed" });
      }
    } catch (error) {
      connStatus.mark(id, { state: "err", error: errorText(error) });
    } finally {
      warming.current.delete(id);
    }
  };

  const selectConnectionTab = (connection: Connection) => {
    if (!activeTab) return;
    void warmUp(connection);
    if (connection.id === activeTab.connectionId) return;
    // A running query belongs to the previous connection.
    if (ws.runningTabId === activeTab.id) ws.abort();
    ws.patchTab(activeTab.id, { connectionId: connection.id });
    appData.selectConnection(connection.id);
    editor.clearMarkers();
    setSelectedIndex(null);
  };

  const testConnectionFromMenu = async (connection: Connection) => {
    notify("info", `Testing ${connection.name || connection.host}…`);
    try {
      const report = await testConnection(connection);
      if (report.ok) {
        connStatus.mark(connection.id, { state: "ok", version: report.server_version });
        const total = report.steps.reduce((sum, step) => sum + step.ms, 0);
        notify("info", `${connection.name || connection.host}: connected in ${total} ms${report.server_version ? ` · ${report.server_version}` : ""}`);
      } else {
        const failed = report.steps[report.steps.length - 1];
        connStatus.mark(connection.id, { state: "err", error: failed?.detail ?? "failed" });
        notify("error", `${connection.name || connection.host}: ${failed?.name ?? "failed"} — ${failed?.detail ?? ""}`);
      }
    } catch (error) {
      connStatus.mark(connection.id, { state: "err", error: errorText(error) });
      notify("error", `${connection.name || connection.host}: ${errorText(error)}`);
    }
  };

  const patchConnection = (connection: Connection, changes: Partial<Connection>) =>
    void appData.saveConnection({ ...connection, ...changes, password: "" });

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === "connection") {
      if (ws.runningTabId && ws.tabs.find((t) => t.id === ws.runningTabId)?.connectionId === pendingDelete.item.id) ws.abort();
      appData.deleteConnection(pendingDelete.item.id);
      schemas.forget(pendingDelete.item.id);
    } else if (pendingDelete.type === "query") {
      appData.removeQuery(pendingDelete.scope, pendingDelete.item.id);
    } else {
      appData.removeResult(pendingDelete.scope, pendingDelete.item.id);
    }
    setPendingDelete(null);
  };

  // --- saved queries & results ----------------------------------------------------------------
  /** Save the active tab: overwrite its saved query, or ask for a name. */
  const saveActiveQuery = () => {
    if (!activeTab) return;
    if (activeTab.savedQueryId && activeTab.savedScope && savedTextRef.current(activeTab) !== null) {
      appData.overwriteQuery(activeTab.savedScope, activeTab.savedQueryId, activeTab.sql);
      notify("info", `Saved “${activeTab.name}”.`);
      return;
    }
    setSavePrompt({ sql: activeTab.sql, initialName: activeTab.name.startsWith("untitled") ? "" : activeTab.name, linkTab: true });
  };

  const saveQueryConfirmed = (name: string) => {
    if (!savePrompt) return;
    if (!sidebarScope) {
      notify("error", "Select a connection first, or switch to Global.");
      return;
    }
    const id = crypto.randomUUID();
    appData.addQuery(sidebarScope, { id, name, query: savePrompt.sql });
    if (savePrompt.linkTab && activeTab) ws.patchTab(activeTab.id, { savedQueryId: id, savedScope: sidebarScope, name });
    setSavePrompt(null);
  };

  const activeSet: ResultSet | null = activeRun && activeRun.activeSet !== MESSAGES ? (activeRun.sets[activeRun.activeSet] ?? null) : null;
  const activeResult = activeSet?.result ?? null;

  /** Local results are filed under the connection that produced them. */
  const resultScope = activeSaveScope === "global" ? GLOBAL_SCOPE : (activeRun?.connectionId || activeConnection?.id || null);

  const saveResultConfirmed = (name: string) => {
    if (!activeResult || !resultScope) return;
    appData.addResult(resultScope, {
      id: crypto.randomUUID(),
      name,
      query: activeRun?.runSql ?? "",
      columns: activeResult.columns,
      rows: activeResult.rows,
      truncated: activeResult.truncated,
    });
    setShowSaveResultModal(false);
  };

  const overwriteQuery = (query: SavedQuery) => {
    if (sidebarScope && activeTab) appData.overwriteQuery(sidebarScope, query.id, activeTab.sql);
  };

  const overwriteResult = (saved: SavedResult) => {
    if (!sidebarScope) return;
    if (!activeResult || activeResult.columns.length === 0) {
      notify("error", "There is no result to save. Run a query first.");
      return;
    }
    appData.overwriteResult(sidebarScope, saved.id, {
      query: activeRun?.runSql ?? "",
      columns: activeResult.columns,
      rows: activeResult.rows,
      truncated: activeResult.truncated,
    });
  };

  const selectQuery = (query: SavedQuery) => {
    const scope = sidebarScope;
    if (!scope) return;
    const linked = ws.tabs.find((tab) => tab.savedQueryId === query.id && tab.savedScope === scope);
    if (linked) return selectTab(linked.id);
    if (activeTab && !activeTab.sql.trim() && !activeTab.savedQueryId) {
      ws.patchTab(activeTab.id, { savedQueryId: query.id, savedScope: scope, name: query.name });
      editor.replaceText(query.query);
    } else {
      newTab({ name: query.name, sql: query.query, savedQueryId: query.id, savedScope: scope });
    }
  };

  const selectResult = (saved: SavedResult) => {
    if (!activeTab) return;
    setActiveResultId(saved.id);
    setSelectedIndex(null);
    const scopeConnection = sidebarScope === GLOBAL_SCOPE ? null : sidebarScope;
    const name = data.connections.find((c) => c.id === scopeConnection)?.name ?? "";
    ws.showSavedResult(activeTab.id, { columns: saved.columns, rows: saved.rows, truncated: saved.truncated, message: null }, saved.name, scopeConnection, name, saved.query);
    if (activeTab.savedQueryId) ws.patchTab(activeTab.id, { savedQueryId: null, savedScope: null });
    editor.replaceText(saved.query);
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

  // --- history ----------------------------------------------------------------------------------
  const restoreEntry = (entry: HistoryEntry, silent = false) => {
    const connection = data.connections.find((c) => c.id === entry.connectionId);
    if (!activeTab) return null;
    if (connection && connection.id !== activeTab.connectionId) selectConnectionTab(connection);
    if (activeTab.savedQueryId) ws.patchTab(activeTab.id, { savedQueryId: null, savedScope: null }); // different text now: do not overwrite that saved query with it
    editor.replaceText(entry.sql);
    setActiveHistoryId(entry.id);
    if (!silent) {
      const name = connection?.name ?? entry.connectionName;
      setRestoredNotes((notes) => ({ ...notes, [activeTab.id]: `Restored from ${dayLabel(entry.at).toLowerCase()} ${timeLabel(entry.at)}${name ? ` on ${name}` : ""}. Results aren’t stored in history.` }));
    }
    return connection ?? activeConnection;
  };

  const rerunEntry = (entry: HistoryEntry) => {
    if (!activeTab || ws.runningTabId) return;
    const connection = restoreEntry(entry, true);
    if (!connection) return;
    // Built from the entry itself: the closures of this render still see the connection from before the switch.
    requestRun({
      tabId: activeTab.id,
      connection,
      text: entry.sql,
      offset: 0,
      rowLimit: settings.rowLimit,
      psql: { path: settings.psqlPath, useFallback: settings.psqlFallback },
    });
  };

  const stepHistory = (direction: -1 | 1) => {
    const entries = history.entries;
    if (entries.length === 0) return;
    let at = activeHistoryId ? entries.findIndex((e) => e.id === activeHistoryId) : -1;
    // Nothing restored yet and the editor still holds the latest run: "previous" means the one before it.
    if (at === -1 && normalizeSql(editor.editorRef.current?.getModel()?.getValue() ?? "") === normalizeSql(entries[0].sql)) at = 0;
    // older = further down the list (newest first)
    const next = Math.min(entries.length - 1, Math.max(0, at + (direction === -1 ? 1 : -1)));
    restoreEntry(entries[next]);
  };

  // --- schema panel ------------------------------------------------------------------------------
  const schemaName = (table: SchemaTable) => qualifiedName(table, schemaState.schema?.dbType ?? dbType, defaultSchema);
  const selectAllFrom = (table: SchemaTable) => openAndRun(`select *\nfrom ${schemaName(table)}\nlimit 100;`, table.name);
  const describeTable = (table: SchemaTable) =>
    openAndRun(dbType === "postgres" ? `\\d ${schemaName(table)}` : `DESCRIBE TABLE ${schemaName(table)}`, `\\d ${table.name}`);

  // --- SQL files ------------------------------------------------------------------------------
  const openSqlFile = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
      if (!selected || Array.isArray(selected)) return;

      const text = await readTextFile(selected);
      if (text.length > MAX_SQL_FILE_CHARS) {
        notify("error", `The file is too large for the editor (${(text.length / 1_000_000).toFixed(1)} million characters, limit ${MAX_SQL_FILE_CHARS / 1_000_000}). Use psql for big dumps.`);
        return;
      }

      const name = selected.split(/[\\/]/).pop() ?? selected;
      newTab({ name, sql: text });
      const count = splitSqlStatements(text, dbType).length;
      notify("info", `Loaded ${name}: ${count} statement${count === 1 ? "" : "s"}. Review it, then press Execute. Each statement gets its own result.`);
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

  // --- settings & palette ---------------------------------------------------------------------
  const openSettings = useCallback((section?: SettingsSection, focusRow?: string) => {
    setPalette(null);
    setSettingsModal({ section, focusRow });
    invoke<string>("storage_dir").then(setDataDir).catch(() => setDataDir(null));
  }, []);

  /** Manual check: an available update opens the dialog, anything else is reported in a notice. */
  const checkUpdateNow = () => {
    void updater.check(true);
  };

  const paletteItems = useMemo((): PaletteItem[] => {
    if (!palette) return [];
    const k = settings.shortcuts;
    const I = COMMAND_ICONS;
    const items: PaletteItem[] = [
      { id: "a-run", group: "Actions", icon: I.play, label: "Execute", kbd: comboText(k.execute), run: () => runRef.current("default") },
      { id: "a-script", group: "Actions", icon: I.play, label: "Run whole script", kbd: comboText("Mod+Shift+Enter"), run: () => runRef.current("script") },
      { id: "a-stmt", group: "Actions", icon: I.play, label: "Run statement at cursor", run: () => runRef.current("statement") },
      { id: "a-explain", group: "Actions", icon: I.info, label: "Explain statement at cursor", kbd: comboText("Mod+Alt+Enter"), run: () => runRef.current("explain") },
      { id: "a-save", group: "Actions", icon: I.save, label: "Save query", kbd: comboText(k.save), run: saveActiveQuery },
      { id: "a-tab", group: "Actions", icon: I.plus, label: "New tab", kbd: comboText("Mod+T"), run: () => newTab() },
      { id: "a-closetab", group: "Actions", icon: I.close, label: "Close tab", kbd: comboText("Mod+Shift+W"), run: () => activeTab && requestCloseTabs([activeTab.id]) },
      { id: "a-file", group: "Actions", icon: I.file, label: "Open .sql file…", run: () => void openSqlFile() },
      { id: "a-newconn", group: "Actions", icon: I.plus, label: "New connection…", run: () => addConnection() },
      { id: "a-url", group: "Actions", icon: I.link, label: "New connection from URL…", run: () => addConnection(true) },
      { id: "a-export", group: "Actions", icon: I.download, label: "Export connections and saved items…", run: () => setShowExportModal(true) },
      { id: "a-import", group: "Actions", icon: I.upload, label: "Import from file…", run: () => void importConnections() },
      { id: "a-schema", group: "Actions", icon: I.db, label: "Show schema", run: () => setSidebarMode("schema") },
      { id: "a-history", group: "Actions", icon: I.clock, label: "Show query history", run: () => setSidebarMode("history") },
      { id: "a-reload", group: "Actions", icon: I.refresh, label: "Reload schema", run: () => activeConnection && void schemas.load(activeConnection, true) },
      { id: "a-update", group: "Actions", icon: I.download, label: "Check for updates", run: checkUpdateNow },
      { id: "a-settings", group: "Actions", icon: I.gear, label: "Open settings", kbd: comboText(k.settings), run: () => openSettings() },
    ];
    data.connections.forEach((connection, index) =>
      items.push({
        id: `c-${connection.id}`,
        group: "Connections",
        icon: connection.read_only ? I.lock : I.db,
        label: connection.name || "Unnamed",
        sub: `${connection.db_type === "postgres" ? "Postgres" : "ClickHouse"} · ${connection.host}`,
        kbd: index < 9 ? comboText(`Mod+${index + 1}`) : undefined,
        run: () => selectConnectionTab(connection),
      }),
    );
    ws.tabs.forEach((tab) =>
      items.push({ id: `t-${tab.id}`, group: "Tabs", icon: I.file, label: tab.name, sub: tab.sql.replace(/\s+/g, " ").slice(0, 80), mono: true, run: () => selectTab(tab.id) }),
    );
    [...savedQueries, ...(activeSaveScope === "local" && activeConnection ? itemsOf(data, "queries", GLOBAL_SCOPE) : [])].forEach((query) =>
      items.push({ id: `q-${query.id}`, group: "Saved queries", icon: I.file, label: query.name, sub: query.query.replace(/\s+/g, " ").slice(0, 90), mono: true, run: () => selectQuery(query) }),
    );
    (schemaState.schema?.tables ?? []).slice(0, 2_000).forEach((table) =>
      items.push({
        id: `tb-${table.schema}.${table.name}`,
        group: "Tables",
        icon: I.table,
        label: table.schema === defaultSchema ? table.name : `${table.schema}.${table.name}`,
        sub: `${table.kind} · select * … limit 100`,
        run: () => selectAllFrom(table),
      }),
    );
    for (const section of settingsSections(packageJson.version)) {
      for (const row of section.rows) {
        if (row.control.type === "value") continue;
        const value = settingValueText(row, settings);
        items.push({ id: `s-${row.id}`, group: "Settings", icon: I.gear, label: row.label, sub: `${section.title}${value ? ` · ${value}` : ""}`, run: () => openSettings(section.id, row.id) });
      }
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette, settings, data, ws.tabs, schemaState.schema, activeConnection?.id, activeTab?.id]);

  // --- keyboard ---------------------------------------------------------------------------------
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;
  const shortcutsRef = useRef(settings.shortcuts);
  shortcutsRef.current = settings.shortcuts;

  /** Handles an app shortcut. Returns true when it did (and prevented the default). */
  const handleShortcut = (event: KeyboardEvent): boolean => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inEditor = Boolean(target?.closest(".query-editor"));
    const isTextInputTarget = inEditor || Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
    const mod = event.metaKey || event.ctrlKey;
    const sc = shortcutsRef.current;
    const handled = () => {
      event.preventDefault();
      return true;
    };

    if (matchesCombo(event, sc.palette)) {
      // (decided outside the state updater: React may run updaters twice and this one must not depend on a ref that changes in between)
      if (paletteOpenRef.current) setPalette(null);
      else if (!modalOpenRef.current) setPalette({ initialQuery: "" });
      return handled();
    }
    if (matchesCombo(event, sc.settings)) {
      if (!modalOpenRef.current) openSettings();
      return handled();
    }
    if (modalOpenRef.current) return false;

    if (matchesCombo(event, sc.save)) {
      saveActiveQuery();
      return handled();
    }
    if (mod && event.key === ".") {
      abort();
      return handled();
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
      window.dispatchEvent(new CustomEvent(OPEN_SWITCHER_EVENT));
      return handled();
    }
    if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const connection = connectionsRef.current[Number(event.key) - 1];
      if (!connection) return false;
      selectConnectionTab(connection);
      return handled();
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "t") {
      newTab();
      return handled();
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "w") {
      if (ws.activeTabId) requestCloseTabs([ws.activeTabId]);
      return handled();
    }
    if (event.ctrlKey && event.key === "Tab") {
      const list = tabsRef.current;
      const at = list.findIndex((t) => t.id === ws.activeTabId);
      const next = list[(at + (event.shiftKey ? list.length - 1 : 1)) % list.length];
      if (next) selectTab(next.id);
      return handled();
    }
    if (event.altKey && mod && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      stepHistory(event.key === "ArrowLeft" ? -1 : 1);
      return handled();
    }
    if (!inEditor) {
      // (the editor itself handles these when it has the focus, see useSqlEditor)
      if (mod && event.shiftKey && event.key === "Enter") {
        runRef.current("script");
        return handled();
      }
      if (mod && event.altKey && event.key === "Enter") {
        runRef.current("explain");
        return handled();
      }
      if (matchesShortcut(event, "execute", sc) && !isTextInputTarget) {
        runRef.current("default");
        return handled();
      }
    }

    if (isTextInputTarget) return false;

    if (event.key === "Escape") {
      setSelectedIndex(null);
      return false;
    }

    const selected = selectedIndexRef.current;
    const count = rowCountRef.current;
    if (selected === null || count === 0 || event.ctrlKey || event.metaKey || event.altKey) return false;

    if (event.key === "ArrowDown" || event.key === "j") {
      setSelectedIndex((selected + 1) % count);
      return handled();
    }
    if (event.key === "ArrowUp" || event.key === "k") {
      setSelectedIndex((selected - 1 + count) % count);
      return handled();
    }
    return false;
  };
  shortcutHandlerRef.current = handleShortcut;

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => void shortcutHandlerRef.current(event);
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  const startWindowDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    getCurrentWindow()
      .startDragging()
      .catch((error) => console.warn("Failed to start window drag.", error));
  };

  // --- derived view state -------------------------------------------------------------------
  const staleFrom =
    activeRun && activeRun.connectionId && activeConnection && activeRun.connectionId !== activeConnection.id && activeRun.status === "done"
      ? (data.connections.find((c) => c.id === activeRun.connectionId)?.name ?? activeRun.connectionName ?? "another connection")
      : null;

  const prodBanner =
    settings.highlightProd && activeConnection?.env === "prod"
      ? { name: activeConnection.name || "Unnamed", host: activeConnection.host, readOnly: activeConnection.read_only }
      : null;

  const dataViewActions = {
    onSelectRow: (index: number) => setSelectedIndex((current) => (current === index ? null : index)),
    onStepRecord: (delta: number) => rowCount > 0 && setSelectedIndex((current) => (((current ?? 0) + delta) % rowCount + rowCount) % rowCount),
    onSaveResult: () => setShowSaveResultModal(true),
    onCloseDetail: () => setSelectedIndex(null),
    onLoadMore: loadMore,
    onSelectSet: (index: number) => {
      if (activeTab) ws.selectSet(activeTab.id, index);
      setSelectedIndex(null);
    },
    onCancel: abort,
    onRerunHere: () => rerunLast(),
    onDismissBanner: () => activeTab && setRestoredNotes((notes) => { const { [activeTab.id]: _gone, ...rest } = notes; return rest; }),
    onRunRestored: () => runNow("script"),
    onCopyLabelled: (text: string, label: string) => copy(text, label),
    onCopy: (text: string) => copy(text),
    onJumpToError: (set: ResultSet) => {
      const position = set.error?.position;
      const text = editor.editorRef.current?.getModel()?.getValue() ?? "";
      if (!position || set.offset < 0 || text.slice(set.offset, set.offset + set.sql.length) !== set.sql) {
        notify("info", "The editor changed since this run, so the position may be off.");
        if (!position) return;
      }
      editor.markError(Math.max(0, set.offset) + position - 1, tokenLengthAt(set.sql, position), set.error?.message.split("\n")[0] ?? "", true);
    },
    onApplyFix: (set: ResultSet, from: string, to: string) => {
      if (!activeRun) return;
      const model = editor.editorRef.current?.getModel();
      const text = model?.getValue() ?? "";
      const local = findIdentifier(set.sql, from, (set.error?.position ?? 1) - 1);
      const absolute = set.offset + local;
      if (local < 0 || set.offset < 0 || text.slice(absolute, absolute + from.length) !== from) {
        notify("error", "The editor changed since this run. Fix it by hand, or run again.");
        return;
      }
      editor.replaceRange(absolute, from.length, to);
      const relative = absolute - activeRun.runOffset;
      const fixed = relative >= 0 && activeRun.runSql.slice(relative, relative + from.length) === from ? activeRun.runSql.slice(0, relative) + to + activeRun.runSql.slice(relative + from.length) : activeRun.runSql;
      // Statements before the broken one already ran: continue from it.
      window.setTimeout(() => rerunLast({ text: textFrom(set, fixed, activeRun.runOffset), offset: set.offset }), 0);
    },
    onExplain: (set: ResultSet) => rerunLast({ text: `explain ${set.sql}`, offset: -1 }),
    onRunWithTimeout: (secs: number) => {
      const failed = activeRun?.sets.find((set) => set.error);
      rerunLast({ text: activeRun ? textFrom(failed, activeRun.runSql, activeRun.runOffset) : undefined, offset: failed?.offset, timeoutSecs: secs });
    },
    onRetry: () => rerunLast(),
    onOpenSettings: (section: "connections" | "results" | "editor" | "psql") => openSettings(section),
  };

  const canLoadMore = Boolean(activeResult?.truncated && activeRun && activeRun.runOffset >= 0 && !activeRun.savedResultName && activeRun.rowLimit < MAX_ROW_LIMIT && activeConnection);
  const tableName = guessTable(activeSet?.sql);

  const sidebarPanel = (
    <Sidebar
      activeQueryId={activeTab?.savedQueryId ?? null}
      activeResultId={activeResultId}
      activeSaveScope={activeSaveScope}
      activeSidebarTab={activeSidebarTab}
      historyPanel={
        <HistoryPanel
          activeConnectionId={activeConnection?.id ?? null}
          activeEntryId={activeHistoryId}
          connections={data.connections}
          entries={history.entries}
          keepLabel={settings.historyKeep === "off" ? "History is off. SQL only when on." : settings.historyKeep === "forever" ? "Kept forever, SQL only." : `Kept ${settings.historyKeep} days, SQL only.`}
          onOpenSettings={() => openSettings("data", "historyKeep")}
          onRerun={rerunEntry}
          onRestore={(entry) => restoreEntry(entry)}
          onSave={(entry) => setSavePrompt({ sql: entry.sql, initialName: "", linkTab: false })}
          savedTexts={savedTexts}
        />
      }
      mode={sidebarMode}
      onDeleteQuery={(query) => sidebarScope && setPendingDelete({ type: "query", item: query, scope: sidebarScope })}
      onDeleteResult={(result) => sidebarScope && setPendingDelete({ type: "result", item: result, scope: sidebarScope })}
      onOverwriteQuery={overwriteQuery}
      onOverwriteResult={overwriteResult}
      onReorderQuery={(from, to) => sidebarScope && appData.moveQuery(sidebarScope, from, to)}
      onReorderResult={(from, to) => sidebarScope && appData.moveResult(sidebarScope, from, to)}
      onSelectQuery={selectQuery}
      onSelectResult={selectResult}
      onSetMode={setSidebarMode}
      onSetSaveScope={setActiveSaveScope}
      onSetSidebarTab={setActiveSidebarTab}
      saveShortcut={settings.shortcuts.save}
      savedQueries={savedQueries}
      savedResults={savedResults}
      schemaPanel={
        <SchemaPanel
          connection={activeConnection}
          onCopy={(text) => copy(text, `“${text}”`)}
          onDescribe={describeTable}
          onInsert={(text) => editor.insertText(text)}
          onLoad={(force) => activeConnection && void schemas.load(activeConnection, force)}
          onSelectAll={selectAllFrom}
          state={schemaState}
        />
      }
    />
  );

  const noConnections = ws.initialized && data.connections.length === 0 && appData.loaded;

  return (
    <div
      className={`app-container ${layout.resizeAxis ? `resizing-layout resizing-layout-${layout.resizeAxis}` : ""}`}
      ref={layout.appContainerRef}
      style={layout.layoutStyle}
    >
      <div className="window-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />

      <ConnectionTabs
        activeConnectionId={activeConnection?.id ?? null}
        connections={data.connections}
        highlightProd={settings.highlightProd}
        onAddConnection={() => addConnection()}
        onAddFromUrl={() => addConnection(true)}
        onCopyUrl={(connection) => copy(formatConnectionUrl(connection), "connection URL (no password)")}
        onDeleteConnection={(connection) => setPendingDelete({ type: "connection", item: connection })}
        onDuplicateConnection={(connection) => void duplicateConnection(connection)}
        onEditConnection={editConnection}
        onExportConnections={() => setShowExportModal(true)}
        onImportConnections={() => void importConnections()}
        onOpenSettings={() => openSettings()}
        onReorderConnections={appData.moveConnection}
        onSelectTab={selectConnectionTab}
        onSetEnv={(connection, env: Env) => patchConnection(connection, { env })}
        onTestConnection={(connection) => void testConnectionFromMenu(connection)}
        onToggleReadOnly={(connection) => patchConnection(connection, { read_only: !connection.read_only })}
        onWindowDragStart={startWindowDrag}
        settingsShortcut={settings.shortcuts.settings}
        statusOf={(id) => connStatus.get(id)}
      />

      {noConnections ? <Welcome onConnect={() => addConnection()} onImport={() => void importConnections()} shortcuts={settings.shortcuts} /> : null}
      {/* Stays mounted behind the welcome screen: the Monaco editor is created once, in this DOM node. */}
      {(
        <div className="workspace-layout" hidden={noConnections}>
          <div className="main-content" ref={layout.mainContentRef}>
            {sidebarPanel}

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
              abortShortcut="Mod+."
              actions={dataViewActions}
              canLoadMore={canLoadMore}
              connection={activeConnection}
              executeShortcut={settings.shortcuts.execute}
              prefs={{ nullText: settings.nullText, rowNumbers: settings.rowNumbers, rowHeight: DENSITY_ROW_HEIGHT[settings.density], prettyJson: settings.prettyJson, findShortcut: settings.shortcuts.find }}
              recordsTableRef={recordsTableRef}
              restoredNote={activeTab ? (restoredNotes[activeTab.id] ?? null) : null}
              run={activeRun}
              schema={schemaState.schema}
              selectedIndex={selectedIndex}
              staleFrom={staleFrom}
              tab={activeTab}
              tableName={tableName}
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
            editorContainerRef={editor.editorContainerRef}
            execScope={settings.execScope}
            executeShortcut={settings.shortcuts.execute}
            commandUnsupported={dbType !== "postgres"}
            isCommandQuery={isMetaCommand(activeTab?.sql ?? "")}
            isLoading={ws.runningTabId !== null}
            onAbortQuery={abort}
            onOpenFile={() => void openSqlFile()}
            onOpenSettings={(section) => openSettings(section)}
            onRun={runNow}
            onSaveQuery={saveActiveQuery}
            prodBanner={prodBanner}
            tabs={
              <QueryTabs
                activeId={ws.activeTabId}
                connections={data.connections}
                dirtyIds={ws.dirtyTabs}
                highlightProd={settings.highlightProd}
                onClose={(id) => requestCloseTabs([id])}
                onContextMenu={(id, x, y) => setTabMenu({ id, x, y })}
                onNew={() => newTab()}
                onRename={(id, name) => ws.patchTab(id, { name })}
                onReorder={ws.moveTab}
                onSelect={selectTab}
                runningId={ws.runningTabId}
                tabs={ws.tabs}
              />
            }
          />
        </div>
      )}

      <StatusBar
        connection={activeConnection}
        onOpenSettings={(section) => openSettings(section)}
        rowLimit={settings.rowLimit}
        run={activeRun}
        settingsShortcut={settings.shortcuts.settings}
        status={connStatus.get(activeConnection?.id ?? null)}
      />

      {tabMenu ? <ContextMenu items={tabMenuItems(tabMenu.id)} onClose={() => setTabMenu(null)} x={tabMenu.x} y={tabMenu.y} /> : null}

      {connectionModal && (
        <ConnectionModal
          focusUrl={connectionModal.focusUrl}
          hasSavedPassword={connectionModal.hasSavedPassword}
          initial={connectionModal.draft}
          isEditing={connectionModal.isEditing}
          loadSavedPassword={() => getPassword(connectionModal.draft.id)}
          onClose={() => setConnectionModal(null)}
          onSave={(draft) => void saveConnection(draft)}
          onTested={(draft, report, error) => {
            if (!draft.id) return;
            if (report?.ok) connStatus.mark(draft.id, { state: "ok", version: report.server_version });
            else connStatus.mark(draft.id, { state: "err", error: error ?? report?.steps[report.steps.length - 1]?.detail ?? "failed" });
          }}
        />
      )}

      {showExportModal && (
        <ExportModal
          connectionCount={data.connections.length}
          onClose={() => setShowExportModal(false)}
          onExport={exportConnections}
          passwordsByDefault={settings.exportPasswordsByDefault}
        />
      )}

      {savePrompt && (
        <SaveNameModal
          initialValue={savePrompt.initialName}
          inputId="query-name"
          label="Query Name"
          onClose={() => setSavePrompt(null)}
          onSave={saveQueryConfirmed}
          title="Save Query"
        />
      )}

      {showSaveResultModal && (
        <SaveNameModal inputId="result-name" label="Result Name" onClose={() => setShowSaveResultModal(false)} onSave={saveResultConfirmed} title="Save Result" />
      )}

      {pendingDelete && (
        <ConfirmModal confirmText="Delete" message={deleteModalText.message} onClose={() => setPendingDelete(null)} onConfirm={confirmDelete} title={deleteModalText.title} />
      )}

      {pendingClose && (
        <ConfirmModal
          confirmText="Close without saving"
          message={(() => {
            const risky = pendingClose.filter((id) => ws.dirtyTabs.has(id) || unsavedScratch(id));
            const name = ws.tabs.find((t) => t.id === risky[0])?.name;
            return risky.length === 1 ? `“${name}” has text that is not saved (and was never run, so it is not in the history either).` : "Some of these tabs have text that is not saved.";
          })()}
          onClose={() => setPendingClose(null)}
          onConfirm={() => {
            closeTabsNow(pendingClose);
            setPendingClose(null);
          }}
          title="Unsaved changes"
        />
      )}

      {pendingClearHistory && (
        <ConfirmModal
          confirmText="Clear history"
          message={`Delete all ${history.entries.length.toLocaleString("en-US")} history entries? Saved queries are not affected.`}
          onClose={() => setPendingClearHistory(false)}
          onConfirm={() => {
            history.clear();
            setPendingClearHistory(false);
          }}
          title="Clear query history"
        />
      )}

      {pendingGuard && (
        <ProdGuardModal
          connectionName={pendingGuard.request.connection.name}
          host={pendingGuard.request.connection.host}
          onClose={() => setPendingGuard(null)}
          onConfirm={() => {
            const { request } = pendingGuard;
            setPendingGuard(null);
            window.setTimeout(() => startRequest(request), 0);
          }}
          statements={pendingGuard.writes}
        />
      )}

      {pendingRisky && (
        <ConfirmModal
          confirmText="Run command"
          message={`This psql command can run programs or read and write files on this computer with your permissions:\n\n${pendingRisky.text.trim().slice(0, 300)}`}
          onClose={() => setPendingRisky(null)}
          onConfirm={() => {
            const request = pendingRisky;
            setPendingRisky(null);
            window.setTimeout(() => startRequest(request), 0);
          }}
          title="Run psql command?"
        />
      )}

      {palette && <CommandPalette initialQuery={palette.initialQuery} items={paletteItems} onClose={() => setPalette(null)} />}

      {settingsModal && (
        <SettingsModal
          dataDir={dataDir}
          focusRow={settingsModal.focusRow}
          historyCount={history.entries.length}
          initialSection={settingsModal.section}
          onChange={settingsStore.update}
          checkingUpdate={updater.state.kind === "checking"}
          onCheckUpdate={checkUpdateNow}
          updateStatus={updateStatus}
          onClearHistory={() => {
            setSettingsModal(null);
            setPendingClearHistory(true);
          }}
          onClose={() => setSettingsModal(null)}
          onCopy={(text) => copy(text, "the folder path")}
          onExport={() => {
            setSettingsModal(null);
            setShowExportModal(true);
          }}
          onImport={() => {
            setSettingsModal(null);
            void importConnections();
          }}
          onReset={settingsStore.reset}
          appearance={settingsStore.wanted}
          settings={settings}
          version={packageJson.version}
        />
      )}

      {updateDialogOpen ? (
        <UpdateModal
          onInstall={() => void updater.install()}
          onLater={() => {
            setShowUpdate(false);
            updater.dismiss();
          }}
          onRestart={updater.restart}
          onSkip={(version) => {
            settingsStore.update({ skippedUpdate: version });
            setShowUpdate(false);
            updater.dismiss();
          }}
          state={updater.state}
        />
      ) : null}

      <Notices notices={notices} onDismiss={dismiss} />
    </div>
  );
}
