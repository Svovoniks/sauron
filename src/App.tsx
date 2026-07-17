import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ConfirmModal } from "./components/ConfirmModal";
import { ConnectionModal } from "./components/ConnectionModal";
import { ConnectionTabs } from "./components/ConnectionTabs";
import { DataView } from "./components/DataView";
import { QuerySection } from "./components/QuerySection";
import { SaveNameModal } from "./components/SaveNameModal";
import { Sidebar } from "./components/Sidebar";
import { useSqlEditor } from "./hooks/useSqlEditor";
import { setRecords } from "./lib/db/common";
import {
  checkPsqlAvailability,
  executePostgresMetaCommand,
  type PostgresMetaOutput,
  type PsqlAvailability,
} from "./lib/db/postgresMeta";
import { emptyConnection, type Connection, type SavedQuery, type SavedResult } from "./types/app";
import { getValueType, prettyPrintJson } from "./utils/record";

type PendingDelete =
  | { type: "connection"; item: Connection }
  | { type: "query"; item: SavedQuery; scope: "local" | "global" }
  | { type: "result"; item: SavedResult; scope: "local" | "global" };
type PsqlAvailabilityState =
  | { status: "checking" }
  | { status: "ready"; availability: PsqlAvailability }
  | { status: "error"; error: string };
type CommandAvailability = {
  status: "checking" | "available" | "unavailable";
  label: string;
  detail: string;
};

const reorderById = <T extends { id: string }>(items: T[], fromId: string, toId: string): T[] => {
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const toIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return items;

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
};

const parseStoredJson = <T,>(key: string, raw: string | null, fallback: T): T => {
  if (!raw) return fallback;

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`Failed to parse localStorage key "${key}". Resetting to default value.`, error);
    return fallback;
  }
};

const isMetaCommandQuery = (query: string) => query.trimStart().startsWith("\\");

const DEFAULT_SIDEBAR_WIDTH = 350;
const DEFAULT_QUERY_HEIGHT = 185;
const MIN_SIDEBAR_WIDTH = 220;
const MIN_RESULTS_WIDTH = 320;
const MIN_MAIN_HEIGHT = 160;
const MIN_QUERY_HEIGHT = 150;
const LAYOUT_GAP = 10;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

export default function App() {
  const appContainerRef = useRef<HTMLDivElement | null>(null);
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const recordsTableRef = useRef<HTMLDivElement | null>(null);
  const connectionNameInputRef = useRef<HTMLInputElement | null>(null);
  const queryNameInputRef = useRef<HTMLInputElement | null>(null);
  const resultNameInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isExecutingQueryRef = useRef(false);
  const layoutResizeRef = useRef<{
    axis: "both" | "x" | "y";
    pointerId: number;
    startX: number;
    startY: number;
    sidebarWidth: number;
    queryHeight: number;
    maximumSidebarWidth: number;
    maximumQueryHeight: number;
  } | null>(null);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [allSavedQueries, setAllSavedQueries] = useState<Record<string, SavedQuery[]>>({});
  const [allSavedResults, setAllSavedResults] = useState<Record<string, SavedResult[]>>({});
  const [globalSavedQueries, setGlobalSavedQueries] = useState<SavedQuery[]>([]);
  const [globalSavedResults, setGlobalSavedResults] = useState<SavedResult[]>([]);

  const [queryText, setQueryText] = useState("SELECT * FROM system.tables LIMIT 10");
  const [records, setRecordsState] = useState<any[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [queryError, setQueryError] = useState<Error | null>(null);
  const [queryOutput, setQueryOutput] = useState<PostgresMetaOutput | null>(null);
  const [psqlAvailability, setPsqlAvailability] = useState<PsqlAvailabilityState>({ status: "checking" });

  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(null);
  const [connectionInModal, setConnectionInModal] = useState<Connection>(emptyConnection);
  const [showPassword, setShowPassword] = useState(false);

  const [showSaveQueryModal, setShowSaveQueryModal] = useState(false);
  const [queryNameInModal, setQueryNameInModal] = useState("");
  const [showSaveResultModal, setShowSaveResultModal] = useState(false);
  const [resultNameInModal, setResultNameInModal] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [activeSaveScope, setActiveSaveScope] = useState<"local" | "global">("local");
  const [activeSidebarTab, setActiveSidebarTab] = useState<"queries" | "results">("queries");
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [queryHeight, setQueryHeight] = useState(DEFAULT_QUERY_HEIGHT);
  const [layoutResizeAxis, setLayoutResizeAxis] = useState<"both" | "x" | "y" | null>(null);

  const activeConnection = useMemo(() => connections.find((connection) => connection.active) ?? null, [connections]);
  const localSavedQueries = activeConnection ? allSavedQueries[activeConnection.id] || [] : [];
  const localSavedResults = activeConnection ? allSavedResults[activeConnection.id] || [] : [];
  const savedQueries = activeSaveScope === "global" ? globalSavedQueries : localSavedQueries;
  const savedResults = activeSaveScope === "global" ? globalSavedResults : localSavedResults;
  const recordColumns = records.length > 0 ? Object.keys(records[0]) : [];
  const commandAvailability = useMemo<CommandAvailability>(() => {
    if (!activeConnection) {
      return {
        status: "unavailable",
        label: "Unavailable: no connection",
        detail: "No active connection selected.",
      };
    }

    if (activeConnection.db_type !== "postgres") {
      return {
        status: "unavailable",
        label: "Unavailable: Postgres only",
        detail: "Meta commands are available for Postgres connections only.",
      };
    }

    if (psqlAvailability.status === "checking") {
      return {
        status: "checking",
        label: "Checking psql",
        detail: "Checking whether psql is installed.",
      };
    }

    if (psqlAvailability.status === "error") {
      return {
        status: "unavailable",
        label: "Unavailable: psql check failed",
        detail: psqlAvailability.error,
      };
    }

    if (psqlAvailability.availability.available) {
      return {
        status: "available",
        label: "ok",
        detail: psqlAvailability.availability.version ?? "psql is installed.",
      };
    }

    return {
      status: "unavailable",
      label: psqlAvailability.availability.path
        ? "Unavailable: psql check failed"
        : "Unavailable: psql not installed",
      detail: psqlAvailability.availability.error ?? "psql is not installed.",
    };
  }, [activeConnection, psqlAvailability]);

  const persistConnections = (next: Connection[]) => localStorage.setItem("connections", JSON.stringify(next));
  const persistQueries = (next: Record<string, SavedQuery[]>) => localStorage.setItem("savedQueries", JSON.stringify(next));
  const persistResults = (next: Record<string, SavedResult[]>) => localStorage.setItem("savedResults", JSON.stringify(next));
  const persistGlobalQueries = (next: SavedQuery[]) => localStorage.setItem("globalSavedQueries", JSON.stringify(next));
  const persistGlobalResults = (next: SavedResult[]) => localStorage.setItem("globalSavedResults", JSON.stringify(next));

  useEffect(() => {
    const storedConnections = localStorage.getItem("connections");
    const storedQueries = localStorage.getItem("savedQueries");
    const storedResults = localStorage.getItem("savedResults");
    const storedGlobalQueries = localStorage.getItem("globalSavedQueries");
    const storedGlobalResults = localStorage.getItem("globalSavedResults");

    const parsedConnections = parseStoredJson<unknown[]>("connections", storedConnections, []);
    const parsedQueries = parseStoredJson<unknown>("savedQueries", storedQueries, {});
    const parsedResults = parseStoredJson<Record<string, unknown>>("savedResults", storedResults, {});
    const parsedGlobalQueries = parseStoredJson<unknown[]>("globalSavedQueries", storedGlobalQueries, []);
    const parsedGlobalResults = parseStoredJson<unknown[]>("globalSavedResults", storedGlobalResults, []);

    let nextConnections: Connection[] = [];
    if (Array.isArray(parsedConnections)) {
      nextConnections = parsedConnections.map((connection) => {
        const typedConnection = connection as Connection;
        return {
          ...typedConnection,
          id: typedConnection.id || crypto.randomUUID(),
        };
      });
      if (nextConnections.length > 0) {
        nextConnections = nextConnections.map((connection, index) => ({ ...connection, active: index === 0 }));
      }
    }

    let nextQueries: Record<string, SavedQuery[]> = {};
    if (Array.isArray(parsedQueries)) {
      if (nextConnections.length > 0) {
        nextQueries[nextConnections[0].id] = parsedQueries.map((query) => {
          const typedQuery = query as SavedQuery;
          return {
            ...typedQuery,
            id: typedQuery.id || crypto.randomUUID(),
          };
        });
      }
    } else if (parsedQueries && typeof parsedQueries === "object") {
      const parsedQueryRecord = parsedQueries as Record<string, unknown>;
      for (const connectionId in parsedQueryRecord) {
        const connectionQueries = parsedQueryRecord[connectionId];
        if (!Array.isArray(connectionQueries)) continue;
        nextQueries[connectionId] = connectionQueries.map((query) => {
          const typedQuery = query as SavedQuery;
          return {
            ...typedQuery,
            id: typedQuery.id || crypto.randomUUID(),
          };
        });
      }
    }

    let nextResults: Record<string, SavedResult[]> = {};
    if (parsedResults && typeof parsedResults === "object") {
      for (const connectionId in parsedResults) {
        const connectionResults = parsedResults[connectionId];
        if (!Array.isArray(connectionResults)) continue;
        nextResults[connectionId] = connectionResults.map((result) => {
          const typedResult = result as SavedResult;
          return {
            ...typedResult,
            id: typedResult.id || crypto.randomUUID(),
          };
        });
      }
    }

    const nextGlobalQueries: SavedQuery[] = Array.isArray(parsedGlobalQueries)
      ? parsedGlobalQueries.map((query) => {
          const typedQuery = query as SavedQuery;
          return {
            ...typedQuery,
            id: typedQuery.id || crypto.randomUUID(),
          };
        })
      : [];

    const nextGlobalResults: SavedResult[] = Array.isArray(parsedGlobalResults)
      ? parsedGlobalResults.map((result) => {
          const typedResult = result as SavedResult;
          return {
            ...typedResult,
            id: typedResult.id || crypto.randomUUID(),
          };
        })
      : [];

    setConnections(nextConnections);
    setAllSavedQueries(nextQueries);
    setAllSavedResults(nextResults);
    setGlobalSavedQueries(nextGlobalQueries);
    setGlobalSavedResults(nextGlobalResults);
    persistConnections(nextConnections);
    persistQueries(nextQueries);
    persistResults(nextResults);
    persistGlobalQueries(nextGlobalQueries);
    persistGlobalResults(nextGlobalResults);
  }, []);

  useEffect(() => {
    let isCurrent = true;
    setPsqlAvailability({ status: "checking" });

    checkPsqlAvailability()
      .then((availability) => {
        if (!isCurrent) return;
        setPsqlAvailability({ status: "ready", availability });
      })
      .catch((error: unknown) => {
        if (!isCurrent) return;
        setPsqlAvailability({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (showConnectionModal) connectionNameInputRef.current?.focus();
  }, [showConnectionModal]);

  useEffect(() => {
    if (showSaveQueryModal) queryNameInputRef.current?.focus();
  }, [showSaveQueryModal]);

  useEffect(() => {
    if (showSaveResultModal) resultNameInputRef.current?.focus();
  }, [showSaveResultModal]);

  const scrollToSelected = () => {
    requestAnimationFrame(() => {
      const selectedElement = recordsTableRef.current?.querySelector(".record-row.active");
      if (selectedElement) {
        selectedElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  };

  const onQueryError = (error: Error) => {
    isExecutingQueryRef.current = false;
    abortControllerRef.current = null;
    setQueryOutput(null);
    if (error.name === "AbortError") {
      setQueryError(new Error("Query was aborted."));
    } else {
      setQueryError(error);
    }
    setRecordsState([]);
    setIsLoading(false);
  };

  const executeQuery = () => {
    if (isExecutingQueryRef.current) return;
    isExecutingQueryRef.current = true;

    setIsLoading(true);
    setQueryError(null);
    setQueryOutput(null);
    setSelectedRecord(null);

    if (!activeConnection) {
      onQueryError(new Error("No active connection selected."));
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    if (isMetaCommandQuery(queryText)) {
      executePostgresMetaCommand(
        queryText,
        activeConnection,
        (output) => {
          isExecutingQueryRef.current = false;
          abortControllerRef.current = null;
          setRecordsState([]);
          setQueryOutput(output);
          setIsLoading(false);
        },
        onQueryError,
        abortController.signal,
      );
      return;
    }

    setRecords(
      queryText,
      activeConnection,
      (newRecords: unknown[]) => {
        isExecutingQueryRef.current = false;
        abortControllerRef.current = null;
        setRecordsState(newRecords as any[]);
        setIsLoading(false);
      },
      onQueryError,
      abortController.signal,
    );
  };

  const abortQuery = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  const { editorRef, editorContainerRef } = useSqlEditor(queryText, setQueryText, executeQuery);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInputTarget = Boolean(
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
      );
      const hasOpenModal = showConnectionModal || showSaveQueryModal || showSaveResultModal || Boolean(pendingDelete);

      if (event.ctrlKey && event.key === "Enter") {
        if (hasOpenModal || isTextInputTarget) return;
        event.preventDefault();
        executeQuery();
        return;
      }

      if (event.key === "Escape") {
        if (showConnectionModal) return setShowConnectionModal(false);
        if (showSaveQueryModal) return setShowSaveQueryModal(false);
        if (showSaveResultModal) return setShowSaveResultModal(false);
        if (pendingDelete) return setPendingDelete(null);
        if (selectedRecord) return setSelectedRecord(null);
      }

      if (isTextInputTarget) {
        return;
      }

      if (!selectedRecord || records.length === 0) return;

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        const currentIndex = records.indexOf(selectedRecord);
        const nextIndex = (currentIndex + 1) % records.length;
        setSelectedRecord(records[nextIndex]);
        scrollToSelected();
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        const currentIndex = records.indexOf(selectedRecord);
        const previousIndex = (currentIndex - 1 + records.length) % records.length;
        setSelectedRecord(records[previousIndex]);
        scrollToSelected();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [executeQuery, records, selectedRecord, showConnectionModal, showSaveQueryModal, showSaveResultModal, pendingDelete]);

  const addConnection = () => {
    setEditingConnection(null);
    setConnectionInModal(emptyConnection);
    setShowPassword(false);
    setShowConnectionModal(true);
  };

  const editConnection = (connection: Connection) => {
    setEditingConnection(connection);
    setConnectionInModal({ ...connection });
    setShowPassword(false);
    setShowConnectionModal(true);
  };

  const saveConnection = () => {
    const nextConnections = [...connections];
    const nextSavedQueries = { ...allSavedQueries };
    const nextSavedResults = { ...allSavedResults };

    if (editingConnection) {
      const index = nextConnections.findIndex((connection) => connection.id === editingConnection.id);
      if (index !== -1) {
        nextConnections[index] = {
          ...connectionInModal,
          id: editingConnection.id,
          active: editingConnection.active,
        };
      }
    } else {
      const newConnection: Connection = {
        ...connectionInModal,
        id: crypto.randomUUID(),
        active: nextConnections.length === 0,
      };
      nextConnections.push(newConnection);
      nextSavedQueries[newConnection.id] = [];
      nextSavedResults[newConnection.id] = [];
    }

    setConnections(nextConnections);
    setAllSavedQueries(nextSavedQueries);
    setAllSavedResults(nextSavedResults);
    persistConnections(nextConnections);
    persistQueries(nextSavedQueries);
    persistResults(nextSavedResults);
    setShowConnectionModal(false);
  };

  const deleteConnection = (connectionToDelete: Connection) => {
    const nextConnections = connections.filter((connection) => connection.id !== connectionToDelete.id);
    const nextSavedQueries = { ...allSavedQueries };
    const nextSavedResults = { ...allSavedResults };
    delete nextSavedQueries[connectionToDelete.id];
    delete nextSavedResults[connectionToDelete.id];

    if (connectionToDelete.active && nextConnections.length > 0) {
      nextConnections[0].active = true;
    }

    setConnections(nextConnections);
    setAllSavedQueries(nextSavedQueries);
    setAllSavedResults(nextSavedResults);
    persistConnections(nextConnections);
    persistQueries(nextSavedQueries);
    persistResults(nextSavedResults);
  };

  const promptSaveQuery = () => {
    setQueryNameInModal("");
    setShowSaveQueryModal(true);
  };

  const saveQueryConfirmed = () => {
    if (!queryNameInModal) return;

    const newQuery: SavedQuery = { id: crypto.randomUUID(), name: queryNameInModal, query: queryText };

    if (activeSaveScope === "global") {
      const nextGlobalSavedQueries = [...globalSavedQueries, newQuery];
      setGlobalSavedQueries(nextGlobalSavedQueries);
      persistGlobalQueries(nextGlobalSavedQueries);
      setShowSaveQueryModal(false);
      return;
    }

    if (!activeConnection) return;

    const nextSavedQueries = { ...allSavedQueries };
    const currentQueries = nextSavedQueries[activeConnection.id] || [];
    nextSavedQueries[activeConnection.id] = [...currentQueries, newQuery];

    setAllSavedQueries(nextSavedQueries);
    persistQueries(nextSavedQueries);
    setShowSaveQueryModal(false);
  };

  const deleteQuery = (queryToDelete: SavedQuery, scope: "local" | "global" = activeSaveScope) => {
    if (scope === "global") {
      const nextGlobalSavedQueries = globalSavedQueries.filter((query) => query.id !== queryToDelete.id);
      setGlobalSavedQueries(nextGlobalSavedQueries);
      persistGlobalQueries(nextGlobalSavedQueries);
      return;
    }

    if (!activeConnection) return;

    const nextSavedQueries = { ...allSavedQueries };
    nextSavedQueries[activeConnection.id] = (nextSavedQueries[activeConnection.id] || []).filter(
      (query) => query.id !== queryToDelete.id,
    );

    setAllSavedQueries(nextSavedQueries);
    persistQueries(nextSavedQueries);
  };

  const overwriteQuery = (queryToOverwrite: SavedQuery) => {
    if (activeSaveScope === "global") {
      const nextGlobalSavedQueries = globalSavedQueries.map((query) =>
        query.id === queryToOverwrite.id ? { ...query, query: queryText } : query,
      );
      setGlobalSavedQueries(nextGlobalSavedQueries);
      persistGlobalQueries(nextGlobalSavedQueries);
      return;
    }

    if (!activeConnection) return;

    const nextSavedQueries = { ...allSavedQueries };
    nextSavedQueries[activeConnection.id] = (nextSavedQueries[activeConnection.id] || []).map((query) =>
      query.id === queryToOverwrite.id ? { ...query, query: queryText } : query,
    );

    setAllSavedQueries(nextSavedQueries);
    persistQueries(nextSavedQueries);
  };

  const promptSaveResult = () => {
    setResultNameInModal("");
    setShowSaveResultModal(true);
  };

  const saveResultConfirmed = () => {
    if (!resultNameInModal) return;

    const newResult: SavedResult = {
      id: crypto.randomUUID(),
      name: resultNameInModal,
      records,
      query: queryText,
    };

    if (activeSaveScope === "global") {
      const nextGlobalSavedResults = [...globalSavedResults, newResult];
      setGlobalSavedResults(nextGlobalSavedResults);
      persistGlobalResults(nextGlobalSavedResults);
      setShowSaveResultModal(false);
      return;
    }

    if (!activeConnection) return;

    const nextSavedResults = { ...allSavedResults };
    const currentResults = nextSavedResults[activeConnection.id] || [];
    nextSavedResults[activeConnection.id] = [...currentResults, newResult];

    setAllSavedResults(nextSavedResults);
    persistResults(nextSavedResults);
    setShowSaveResultModal(false);
  };

  const deleteResult = (resultToDelete: SavedResult, scope: "local" | "global" = activeSaveScope) => {
    if (scope === "global") {
      const nextGlobalSavedResults = globalSavedResults.filter((result) => result.id !== resultToDelete.id);
      setGlobalSavedResults(nextGlobalSavedResults);
      persistGlobalResults(nextGlobalSavedResults);
      return;
    }

    if (!activeConnection) return;

    const nextSavedResults = { ...allSavedResults };
    nextSavedResults[activeConnection.id] = (nextSavedResults[activeConnection.id] || []).filter(
      (result) => result.id !== resultToDelete.id,
    );

    setAllSavedResults(nextSavedResults);
    persistResults(nextSavedResults);
  };

  const overwriteResult = (resultToOverwrite: SavedResult) => {
    if (activeSaveScope === "global") {
      const nextGlobalSavedResults = globalSavedResults.map((result) =>
        result.id === resultToOverwrite.id ? { ...result, query: queryText, records } : result,
      );
      setGlobalSavedResults(nextGlobalSavedResults);
      persistGlobalResults(nextGlobalSavedResults);
      return;
    }

    if (!activeConnection) return;

    const nextSavedResults = { ...allSavedResults };
    nextSavedResults[activeConnection.id] = (nextSavedResults[activeConnection.id] || []).map((result) =>
      result.id === resultToOverwrite.id ? { ...result, query: queryText, records } : result,
    );

    setAllSavedResults(nextSavedResults);
    persistResults(nextSavedResults);
  };

  const selectTab = (tab: Connection) => {
    const nextConnections = connections.map((connection) => ({
      ...connection,
      active: connection.id === tab.id,
    }));
    setConnections(nextConnections);
    persistConnections(nextConnections);
  };

  const reorderConnections = (fromId: string, toId: string) => {
    setConnections((currentConnections) => {
      const nextConnections = reorderById(currentConnections, fromId, toId);
      if (nextConnections === currentConnections) return currentConnections;
      persistConnections(nextConnections);
      return nextConnections;
    });
  };

  const reorderQueries = (fromId: string, toId: string) => {
    if (activeSaveScope === "global") {
      setGlobalSavedQueries((currentQueries) => {
        const nextQueries = reorderById(currentQueries, fromId, toId);
        if (nextQueries === currentQueries) return currentQueries;
        persistGlobalQueries(nextQueries);
        return nextQueries;
      });
      return;
    }

    if (!activeConnection) return;

    setAllSavedQueries((currentSavedQueries) => {
      const connectionId = activeConnection.id;
      const connectionQueries = currentSavedQueries[connectionId] || [];
      const nextConnectionQueries = reorderById(connectionQueries, fromId, toId);
      if (nextConnectionQueries === connectionQueries) return currentSavedQueries;

      const nextSavedQueries = {
        ...currentSavedQueries,
        [connectionId]: nextConnectionQueries,
      };
      persistQueries(nextSavedQueries);
      return nextSavedQueries;
    });
  };

  const reorderResults = (fromId: string, toId: string) => {
    if (activeSaveScope === "global") {
      setGlobalSavedResults((currentResults) => {
        const nextResults = reorderById(currentResults, fromId, toId);
        if (nextResults === currentResults) return currentResults;
        persistGlobalResults(nextResults);
        return nextResults;
      });
      return;
    }

    if (!activeConnection) return;

    setAllSavedResults((currentSavedResults) => {
      const connectionId = activeConnection.id;
      const connectionResults = currentSavedResults[connectionId] || [];
      const nextConnectionResults = reorderById(connectionResults, fromId, toId);
      if (nextConnectionResults === connectionResults) return currentSavedResults;

      const nextSavedResults = {
        ...currentSavedResults,
        [connectionId]: nextConnectionResults,
      };
      persistResults(nextSavedResults);
      return nextSavedResults;
    });
  };

  const exportConnections = async () => {
    try {
      const filePath = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;

      await writeTextFile(
        filePath,
        JSON.stringify(
          {
            connections,
            queries: allSavedQueries,
            results: allSavedResults,
            globalQueries: globalSavedQueries,
            globalResults: globalSavedResults,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error);
    }
  };

  const importConnections = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;

      const rawData = await readTextFile(selected as string);
      const importedData = JSON.parse(rawData);

      let nextConnections: Connection[] = [];
      let nextSavedQueries: Record<string, SavedQuery[]> = {};
      let nextSavedResults: Record<string, SavedResult[]> = {};
      let nextGlobalQueries: SavedQuery[] = [];
      let nextGlobalResults: SavedResult[] = [];

      if (importedData.connections && importedData.queries) {
        nextConnections = importedData.connections.map((connection: Connection) => ({
          ...connection,
          id: connection.id || crypto.randomUUID(),
        }));

        for (const connectionId in importedData.queries) {
          nextSavedQueries[connectionId] = importedData.queries[connectionId].map((query: SavedQuery) => ({
            ...query,
            id: query.id || crypto.randomUUID(),
          }));
        }

        if (importedData.results) {
          for (const connectionId in importedData.results) {
            nextSavedResults[connectionId] = importedData.results[connectionId].map((result: SavedResult) => ({
              ...result,
              id: result.id || crypto.randomUUID(),
            }));
          }
        }

        if (importedData.globalQueries) {
          nextGlobalQueries = importedData.globalQueries.map((query: SavedQuery) => ({
            ...query,
            id: query.id || crypto.randomUUID(),
          }));
        }

        if (importedData.globalResults) {
          nextGlobalResults = importedData.globalResults.map((result: SavedResult) => ({
            ...result,
            id: result.id || crypto.randomUUID(),
          }));
        }
      } else {
        nextConnections = importedData.map((connection: Connection) => ({
          ...connection,
          id: connection.id || crypto.randomUUID(),
        }));
      }

      if (nextConnections.length > 0) {
        nextConnections = nextConnections.map((connection, index) => ({ ...connection, active: index === 0 }));
      }

      setConnections(nextConnections);
      setAllSavedQueries(nextSavedQueries);
      setAllSavedResults(nextSavedResults);
      setGlobalSavedQueries(nextGlobalQueries);
      setGlobalSavedResults(nextGlobalResults);
      persistConnections(nextConnections);
      persistQueries(nextSavedQueries);
      persistResults(nextSavedResults);
      persistGlobalQueries(nextGlobalQueries);
      persistGlobalResults(nextGlobalResults);
    } catch (error) {
      console.error(error);
    }
  };

  const selectQuery = (query: SavedQuery) => {
    if (activeSaveScope === "global") {
      const nextGlobalSavedQueries = globalSavedQueries.map((savedQuery) => ({
        ...savedQuery,
        active: savedQuery.id === query.id,
      }));
      setGlobalSavedQueries(nextGlobalSavedQueries);
      persistGlobalQueries(nextGlobalSavedQueries);
      setQueryText(query.query);
      editorRef.current?.setValue(query.query);
      return;
    }

    if (!activeConnection) return;

    const nextSavedQueries = { ...allSavedQueries };
    nextSavedQueries[activeConnection.id] = (nextSavedQueries[activeConnection.id] || []).map((savedQuery) => ({
      ...savedQuery,
      active: savedQuery.id === query.id,
    }));

    setAllSavedQueries(nextSavedQueries);
    persistQueries(nextSavedQueries);
    setQueryText(query.query);
    editorRef.current?.setValue(query.query);
  };

  const selectResult = (result: SavedResult) => {
    if (activeSaveScope === "global") {
      const nextGlobalSavedResults = globalSavedResults.map((savedResult) => ({
        ...savedResult,
        active: savedResult.id === result.id,
      }));
      setGlobalSavedResults(nextGlobalSavedResults);
      persistGlobalResults(nextGlobalSavedResults);
      setSelectedRecord(null);
      setRecordsState(result.records);
      setQueryText(result.query);
      setQueryOutput(null);
      setQueryError(null);
      editorRef.current?.setValue(result.query);
      return;
    }

    if (!activeConnection) return;

    const nextSavedResults = { ...allSavedResults };
    nextSavedResults[activeConnection.id] = (nextSavedResults[activeConnection.id] || []).map((savedResult) => ({
      ...savedResult,
      active: savedResult.id === result.id,
    }));

    setAllSavedResults(nextSavedResults);
    persistResults(nextSavedResults);
    setSelectedRecord(null);
    setRecordsState(result.records);
    setQueryText(result.query);
    setQueryOutput(null);
    setQueryError(null);
    editorRef.current?.setValue(result.query);
  };

  const selectRecord = (record: any) => {
    setSelectedRecord((currentRecord: any) => (currentRecord === record ? null : record));
  };

  const requestDeleteConnection = (connection: Connection) => {
    setPendingDelete({ type: "connection", item: connection });
  };

  const requestDeleteQuery = (query: SavedQuery) => {
    setPendingDelete({ type: "query", item: query, scope: activeSaveScope });
  };

  const requestDeleteResult = (result: SavedResult) => {
    setPendingDelete({ type: "result", item: result, scope: activeSaveScope });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;

    if (pendingDelete.type === "connection") {
      deleteConnection(pendingDelete.item);
    } else if (pendingDelete.type === "query") {
      deleteQuery(pendingDelete.item, pendingDelete.scope);
    } else {
      deleteResult(pendingDelete.item, pendingDelete.scope);
    }

    setPendingDelete(null);
  };

  const getDeleteModalText = () => {
    if (!pendingDelete) return { title: "", message: "" };

    if (pendingDelete.type === "connection") {
      const name = pendingDelete.item.name || "Unnamed";
      return { title: "Delete Connection", message: `Are you sure you want to delete "${name}"?` };
    }

    if (pendingDelete.type === "query") {
      const scopeLabel = pendingDelete.scope === "global" ? "global " : "";
      return {
        title: "Delete Query",
        message: `Are you sure you want to delete ${scopeLabel}saved query "${pendingDelete.item.name}"?`,
      };
    }

    const scopeLabel = pendingDelete.scope === "global" ? "global " : "";
    return {
      title: "Delete Result",
      message: `Are you sure you want to delete ${scopeLabel}saved result "${pendingDelete.item.name}"?`,
    };
  };

  const deleteModalText = getDeleteModalText();
  const startWindowDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    getCurrentWindow().startDragging().catch((error) => {
      console.warn("Failed to start window drag.", error);
    });
  };

  const startLayoutResize = (event: ReactPointerEvent<HTMLElement>, axis: "both" | "x" | "y") => {
    if (event.button !== 0 || !mainContentRef.current || !appContainerRef.current) return;

    const sidebar = mainContentRef.current.querySelector<HTMLElement>(".sidebar");
    const querySection = appContainerRef.current.querySelector<HTMLElement>(".query-section");
    if (!sidebar || !querySection) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const mainWidth = mainContentRef.current.getBoundingClientRect().width;
    const sharedVerticalSpace =
      mainContentRef.current.getBoundingClientRect().height + LAYOUT_GAP + querySection.getBoundingClientRect().height;

    layoutResizeRef.current = {
      axis,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      queryHeight: querySection.getBoundingClientRect().height,
      maximumSidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, mainWidth - LAYOUT_GAP - MIN_RESULTS_WIDTH),
      maximumQueryHeight: Math.max(MIN_QUERY_HEIGHT, sharedVerticalSpace - LAYOUT_GAP - MIN_MAIN_HEIGHT),
    };
    setLayoutResizeAxis(axis);
  };

  const resizeLayout = (event: ReactPointerEvent<HTMLElement>) => {
    const resize = layoutResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    if (resize.axis !== "y") {
      setSidebarWidth(
        clamp(resize.sidebarWidth + event.clientX - resize.startX, MIN_SIDEBAR_WIDTH, resize.maximumSidebarWidth),
      );
    }
    if (resize.axis !== "x") {
      setQueryHeight(
        clamp(resize.queryHeight - (event.clientY - resize.startY), MIN_QUERY_HEIGHT, resize.maximumQueryHeight),
      );
    }
  };

  const stopLayoutResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (layoutResizeRef.current?.pointerId !== event.pointerId) return;

    layoutResizeRef.current = null;
    setLayoutResizeAxis(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeLayoutWithKeyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    axis: "both" | "x" | "y" = "both",
  ) => {
    const increment = event.shiftKey ? 24 : 8;

    if (event.key === "ArrowLeft" && axis !== "y") {
      event.preventDefault();
      setSidebarWidth((width) => Math.max(MIN_SIDEBAR_WIDTH, width - increment));
    } else if (event.key === "ArrowRight" && axis !== "y") {
      event.preventDefault();
      const mainWidth = mainContentRef.current?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
      setSidebarWidth((width) => Math.min(mainWidth - LAYOUT_GAP - MIN_RESULTS_WIDTH, width + increment));
    } else if (event.key === "ArrowUp" && axis !== "x") {
      event.preventDefault();
      const querySection = appContainerRef.current?.querySelector<HTMLElement>(".query-section");
      const mainHeight = mainContentRef.current?.getBoundingClientRect().height;
      const maximumQueryHeight =
        querySection && mainHeight !== undefined
          ? Math.max(
              MIN_QUERY_HEIGHT,
              mainHeight + querySection.getBoundingClientRect().height - MIN_MAIN_HEIGHT,
            )
          : Number.POSITIVE_INFINITY;
      setQueryHeight((height) => Math.min(maximumQueryHeight, height + increment));
    } else if (event.key === "ArrowDown" && axis !== "x") {
      event.preventDefault();
      setQueryHeight((height) => Math.max(MIN_QUERY_HEIGHT, height - increment));
    }
  };

  const resetLayoutSize = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    setQueryHeight(DEFAULT_QUERY_HEIGHT);
  };

  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--query-section-height": `${queryHeight}px`,
  } as CSSProperties;

  return (
    <div
      className={`app-container ${layoutResizeAxis ? `resizing-layout resizing-layout-${layoutResizeAxis}` : ""}`}
      ref={appContainerRef}
      style={layoutStyle}
    >
      <div className="window-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />

      <ConnectionModal
        show={showConnectionModal}
        editingConnection={editingConnection}
        connectionInModal={connectionInModal}
        connectionNameInputRef={connectionNameInputRef}
        showPassword={showPassword}
        onClose={() => setShowConnectionModal(false)}
        onSave={saveConnection}
        onTogglePassword={() => setShowPassword((value) => !value)}
        onDbTypeChange={(dbType) => setConnectionInModal((connection) => ({ ...connection, db_type: dbType }))}
        onFieldChange={(field, value) => setConnectionInModal((connection) => ({ ...connection, [field]: value }))}
      />

      <ConnectionTabs
        connections={connections}
        onAddConnection={addConnection}
        onEditConnection={editConnection}
        onDeleteConnection={requestDeleteConnection}
        onSelectTab={selectTab}
        onReorderConnections={reorderConnections}
        onImportConnections={importConnections}
        onExportConnections={exportConnections}
        onWindowDragStart={startWindowDrag}
      />

      <div className="workspace-layout">
        <div className="main-content" ref={mainContentRef}>
          <Sidebar
            activeSaveScope={activeSaveScope}
            activeSidebarTab={activeSidebarTab}
            savedQueries={savedQueries}
            savedResults={savedResults}
            onSetSaveScope={setActiveSaveScope}
            onSetSidebarTab={setActiveSidebarTab}
            onSelectQuery={selectQuery}
            onSelectResult={selectResult}
            onDeleteQuery={requestDeleteQuery}
            onDeleteResult={requestDeleteResult}
            onOverwriteQuery={overwriteQuery}
            onOverwriteResult={overwriteResult}
            onReorderQuery={reorderQueries}
            onReorderResult={reorderResults}
          />

          <div
            aria-label="Resize Saved Stuff and Query Results panels"
            aria-orientation="vertical"
            className="layout-resize-gutter"
            onKeyDown={(event) => {
              if (event.target === event.currentTarget) resizeLayoutWithKeyboard(event, "x");
            }}
            onPointerCancel={stopLayoutResize}
            onPointerDown={(event) => startLayoutResize(event, "x")}
            onPointerMove={resizeLayout}
            onPointerUp={stopLayoutResize}
            role="separator"
            tabIndex={0}
          >
            <button
              aria-label="Resize Saved Stuff, Query Results, and SQL Query panels"
              className="layout-resize-handle"
              onDoubleClick={resetLayoutSize}
              onKeyDown={(event) => resizeLayoutWithKeyboard(event, "both")}
              onPointerCancel={stopLayoutResize}
              onPointerDown={(event) => startLayoutResize(event, "both")}
              onPointerMove={resizeLayout}
              onPointerUp={stopLayoutResize}
              title="Drag to resize all three panels. Double-click to reset."
              type="button"
            />
          </div>

          <DataView
            records={records}
            recordColumns={recordColumns}
            selectedRecord={selectedRecord}
            isLoading={isLoading}
            queryError={queryError}
            queryOutput={queryOutput}
            recordsTableRef={recordsTableRef}
            onSelectRecord={selectRecord}
            onSaveResult={promptSaveResult}
            onCloseDetail={() => setSelectedRecord(null)}
            prettyPrintJson={prettyPrintJson}
            getValueType={getValueType}
          />
        </div>

        <div
          aria-label="Resize upper panels and SQL Query panel"
          aria-orientation="horizontal"
          className="layout-horizontal-resize-gutter"
          onKeyDown={(event) => resizeLayoutWithKeyboard(event, "y")}
          onPointerCancel={stopLayoutResize}
          onPointerDown={(event) => startLayoutResize(event, "y")}
          onPointerMove={resizeLayout}
          onPointerUp={stopLayoutResize}
          role="separator"
          tabIndex={0}
        />

        <QuerySection
          editorContainerRef={editorContainerRef}
          commandAvailability={commandAvailability}
          isLoading={isLoading}
          isCommandQuery={isMetaCommandQuery(queryText)}
          onSaveQuery={promptSaveQuery}
          onAbortQuery={abortQuery}
          onExecuteQuery={executeQuery}
        />
      </div>

      <SaveNameModal
        show={showSaveQueryModal}
        title="Save Query"
        inputId="query-name"
        label="Query Name"
        value={queryNameInModal}
        inputRef={queryNameInputRef}
        onChange={setQueryNameInModal}
        onClose={() => setShowSaveQueryModal(false)}
        onSave={saveQueryConfirmed}
      />

      <SaveNameModal
        show={showSaveResultModal}
        title="Save Result"
        inputId="result-name"
        label="Result Name"
        value={resultNameInModal}
        inputRef={resultNameInputRef}
        onChange={setResultNameInModal}
        onClose={() => setShowSaveResultModal(false)}
        onSave={saveResultConfirmed}
      />

      <ConfirmModal
        show={Boolean(pendingDelete)}
        title={deleteModalText.title}
        message={deleteModalText.message}
        confirmText="Delete"
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
