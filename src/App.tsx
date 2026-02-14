import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { LanguageIdEnum, vsPlusTheme } from "monaco-sql-languages";
import "monaco-sql-languages/esm/languages/flink/flink.contribution";
import "monaco-sql-languages/esm/languages/hive/hive.contribution";
import "monaco-sql-languages/esm/languages/impala/impala.contribution";
import "monaco-sql-languages/esm/languages/mysql/mysql.contribution";
import "monaco-sql-languages/esm/languages/pgsql/pgsql.contribution";
import "monaco-sql-languages/esm/languages/spark/spark.contribution";
import "monaco-sql-languages/esm/languages/trino/trino.contribution";
import { setRecords } from "./lib/db/common";

interface Connection {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password?: string;
  database: string;
  db_type: "postgres" | "clickhouse";
  active?: boolean;
}

interface SavedQuery {
  id: string;
  name: string;
  query: string;
  active?: boolean;
}

interface SavedResult {
  id: string;
  name: string;
  records: any[];
  query: string;
  active?: boolean;
}

const emptyConnection: Connection = {
  id: "",
  name: "",
  host: "",
  port: "",
  username: "",
  password: "",
  database: "",
  db_type: "clickhouse",
};

export default function App() {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const recordsTableRef = useRef<HTMLDivElement | null>(null);
  const queryNameInputRef = useRef<HTMLInputElement | null>(null);
  const resultNameInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [allSavedQueries, setAllSavedQueries] = useState<Record<string, SavedQuery[]>>({});
  const [allSavedResults, setAllSavedResults] = useState<Record<string, SavedResult[]>>({});

  const [queryText, setQueryText] = useState("SELECT * FROM system.tables LIMIT 10");
  const [records, setRecordsState] = useState<any[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [queryError, setQueryError] = useState<Error | null>(null);

  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(null);
  const [connectionInModal, setConnectionInModal] = useState<Connection>(emptyConnection);
  const [showPassword, setShowPassword] = useState(false);

  const [showSaveQueryModal, setShowSaveQueryModal] = useState(false);
  const [queryNameInModal, setQueryNameInModal] = useState("");
  const [showSaveResultModal, setShowSaveResultModal] = useState(false);
  const [resultNameInModal, setResultNameInModal] = useState("");
  const [activeSidebarTab, setActiveSidebarTab] = useState<"queries" | "results">("queries");

  const activeConnection = useMemo(() => connections.find((connection) => connection.active) ?? null, [connections]);
  const savedQueries = activeConnection ? allSavedQueries[activeConnection.id] || [] : [];
  const savedResults = activeConnection ? allSavedResults[activeConnection.id] || [] : [];
  const recordColumns = records.length > 0 ? Object.keys(records[0]) : [];

  const persistConnections = (next: Connection[]) => localStorage.setItem("connections", JSON.stringify(next));
  const persistQueries = (next: Record<string, SavedQuery[]>) => localStorage.setItem("savedQueries", JSON.stringify(next));
  const persistResults = (next: Record<string, SavedResult[]>) => localStorage.setItem("savedResults", JSON.stringify(next));

  useEffect(() => {
    const storedConnections = localStorage.getItem("connections");
    const storedQueries = localStorage.getItem("savedQueries");
    const storedResults = localStorage.getItem("savedResults");

    let nextConnections: Connection[] = [];
    if (storedConnections) {
      nextConnections = JSON.parse(storedConnections).map((connection: Connection) => ({
        ...connection,
        id: connection.id || crypto.randomUUID(),
      }));
      if (nextConnections.length > 0) {
        nextConnections = nextConnections.map((connection, index) => ({ ...connection, active: index === 0 }));
      }
    }

    let nextQueries: Record<string, SavedQuery[]> = {};
    if (storedQueries) {
      const parsed = JSON.parse(storedQueries);
      if (Array.isArray(parsed)) {
        if (nextConnections.length > 0) {
          nextQueries[nextConnections[0].id] = parsed.map((query: SavedQuery) => ({
            ...query,
            id: query.id || crypto.randomUUID(),
          }));
        }
      } else {
        for (const connectionId in parsed) {
          nextQueries[connectionId] = parsed[connectionId].map((query: SavedQuery) => ({
            ...query,
            id: query.id || crypto.randomUUID(),
          }));
        }
      }
    }

    let nextResults: Record<string, SavedResult[]> = {};
    if (storedResults) {
      const parsed = JSON.parse(storedResults);
      for (const connectionId in parsed) {
        nextResults[connectionId] = parsed[connectionId].map((result: SavedResult) => ({
          ...result,
          id: result.id || crypto.randomUUID(),
        }));
      }
    }

    setConnections(nextConnections);
    setAllSavedQueries(nextQueries);
    setAllSavedResults(nextResults);
    persistConnections(nextConnections);
    persistQueries(nextQueries);
    persistResults(nextResults);
  }, []);

  useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let disposed = false;

    const initEditor = async () => {
      const container = editorContainerRef.current;
      if (!container) return;

      const monaco = (await import("./lib/monaco")).default;
      if (disposed) return;
      monacoRef.current = monaco;

      monaco.editor.defineTheme("sql-dark", vsPlusTheme.darkThemeData);
      const editor = monaco.editor.create(container, {
        lineNumbers: "off",
        minimap: { enabled: false },
        automaticLayout: false,
        theme: "sql-dark",
        scrollbar: { vertical: "hidden", verticalSliderSize: 0, verticalScrollbarSize: 0 },
        language: LanguageIdEnum.FLINK,
        lineDecorationsWidth: "0px",
        find: undefined,
        wordWrap: "on",
        lineNumbersMinChars: 0,
        padding: { top: 5, bottom: 5 },
        renderLineHighlight: "none",
        value: queryText,
        fontSize: 15,
      });

      editor.onDidChangeModelContent(() => setQueryText(editor.getValue()));
      resizeObserver = new ResizeObserver(() => editor.layout());
      resizeObserver.observe(container);
      editorRef.current = editor;
    };

    initEditor();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      monacoRef.current?.editor.getModels().forEach((model) => model.dispose());
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

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
    if (error.name === "AbortError") {
      setQueryError(new Error("Query was aborted."));
    } else {
      setQueryError(error);
    }
    setRecordsState([]);
    setIsLoading(false);
  };

  const executeQuery = () => {
    setIsLoading(true);
    setQueryError(null);
    setSelectedRecord(null);

    if (!activeConnection) {
      onQueryError(new Error("No active connection selected."));
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setRecords(
      queryText,
      activeConnection,
      (newRecords: unknown[]) => {
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

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        executeQuery();
      }

      if (event.key === "Escape") {
        if (showConnectionModal) return setShowConnectionModal(false);
        if (showSaveQueryModal) return setShowSaveQueryModal(false);
        if (showSaveResultModal) return setShowSaveResultModal(false);
        if (selectedRecord) return setSelectedRecord(null);
      }

      const target = event.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
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
  }, [records, selectedRecord, showConnectionModal, showSaveQueryModal, showSaveResultModal]);

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
    if (!connectionInModal.name || !connectionInModal.host) return;

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
    if (!queryNameInModal || !activeConnection) return;

    const newQuery: SavedQuery = { id: crypto.randomUUID(), name: queryNameInModal, query: queryText };
    const nextSavedQueries = { ...allSavedQueries };
    const currentQueries = nextSavedQueries[activeConnection.id] || [];
    nextSavedQueries[activeConnection.id] = [...currentQueries, newQuery];

    setAllSavedQueries(nextSavedQueries);
    persistQueries(nextSavedQueries);
    setShowSaveQueryModal(false);
  };

  const deleteQuery = (queryToDelete: SavedQuery) => {
    if (!activeConnection) return;

    const nextSavedQueries = { ...allSavedQueries };
    nextSavedQueries[activeConnection.id] = (nextSavedQueries[activeConnection.id] || []).filter(
      (query) => query.id !== queryToDelete.id,
    );

    setAllSavedQueries(nextSavedQueries);
    persistQueries(nextSavedQueries);
  };

  const promptSaveResult = () => {
    setResultNameInModal("");
    setShowSaveResultModal(true);
  };

  const saveResultConfirmed = () => {
    if (!resultNameInModal || !activeConnection) return;

    const newResult: SavedResult = {
      id: crypto.randomUUID(),
      name: resultNameInModal,
      records,
      query: queryText,
    };

    const nextSavedResults = { ...allSavedResults };
    const currentResults = nextSavedResults[activeConnection.id] || [];
    nextSavedResults[activeConnection.id] = [...currentResults, newResult];

    setAllSavedResults(nextSavedResults);
    persistResults(nextSavedResults);
    setShowSaveResultModal(false);
  };

  const deleteResult = (resultToDelete: SavedResult) => {
    if (!activeConnection) return;

    const nextSavedResults = { ...allSavedResults };
    nextSavedResults[activeConnection.id] = (nextSavedResults[activeConnection.id] || []).filter(
      (result) => result.id !== resultToDelete.id,
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
      persistConnections(nextConnections);
      persistQueries(nextSavedQueries);
      persistResults(nextSavedResults);
    } catch (error) {
      console.error(error);
    }
  };

  const selectQuery = (query: SavedQuery) => {
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
    if (!activeConnection) return;

    const nextSavedResults = { ...allSavedResults };
    nextSavedResults[activeConnection.id] = (nextSavedResults[activeConnection.id] || []).map((savedResult) => ({
      ...savedResult,
      active: savedResult.id === result.id,
    }));

    setAllSavedResults(nextSavedResults);
    persistResults(nextSavedResults);
    setRecordsState(result.records);
    setQueryText(result.query);
    setQueryError(null);
    editorRef.current?.setValue(result.query);
  };

  const selectRecord = (record: any) => {
    setSelectedRecord((currentRecord: any) => (currentRecord === record ? null : record));
  };

  const prettyPrintJson = (value: any) => {
    if (value === null || value === undefined) return "null";

    const stringValue = String(value);
    try {
      const parsed = JSON.parse(stringValue);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return stringValue;
    }
  };

  const getValueType = (value: any) => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (typeof value === "string") {
      try {
        JSON.parse(value);
        return "json";
      } catch {
        return "string";
      }
    }
    return "object";
  };

  return (
    <div className="app-container">
      {showConnectionModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>{editingConnection ? "Edit Connection" : "New Connection"}</h3>
            <div className="form-group">
              <label>Database Type</label>
              <div className={`db-type-switch ${connectionInModal.db_type === "clickhouse" ? "clickhouse" : ""}`}>
                <button
                  className={connectionInModal.db_type === "postgres" ? "active" : ""}
                  onClick={() => setConnectionInModal((connection) => ({ ...connection, db_type: "postgres" }))}
                  type="button"
                >
                  Postgres
                </button>
                <button
                  className={connectionInModal.db_type === "clickhouse" ? "active" : ""}
                  onClick={() => setConnectionInModal((connection) => ({ ...connection, db_type: "clickhouse" }))}
                  type="button"
                >
                  ClickHouse
                </button>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="connection-name">Connection Name</label>
              <input
                id="connection-name"
                type="text"
                placeholder="stage"
                autoCorrect="off"
                value={connectionInModal.name}
                onChange={(event) => setConnectionInModal((connection) => ({ ...connection, name: event.target.value }))}
              />
            </div>
            <div className="host-port-group">
              <div className="form-group">
                <label htmlFor="host">Host</label>
                <input
                  id="host"
                  type="text"
                  placeholder="localhost"
                  autoCorrect="off"
                  value={connectionInModal.host}
                  onChange={(event) => setConnectionInModal((connection) => ({ ...connection, host: event.target.value }))}
                />
              </div>
              <div className="form-group">
                <label htmlFor="port">Port</label>
                <input
                  id="port"
                  type="text"
                  placeholder="5432"
                  autoCorrect="off"
                  value={connectionInModal.port}
                  onChange={(event) => setConnectionInModal((connection) => ({ ...connection, port: event.target.value }))}
                />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="database">Database</label>
              <input
                id="database"
                type="text"
                placeholder="postgres"
                autoCorrect="off"
                value={connectionInModal.database}
                onChange={(event) => setConnectionInModal((connection) => ({ ...connection, database: event.target.value }))}
              />
            </div>
            <div className="form-group">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                placeholder="user"
                autoCorrect="off"
                value={connectionInModal.username}
                onChange={(event) => setConnectionInModal((connection) => ({ ...connection, username: event.target.value }))}
              />
            </div>
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <div className="password-input-container">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoCorrect="off"
                  autoCapitalize="none"
                  value={connectionInModal.password || ""}
                  onChange={(event) => setConnectionInModal((connection) => ({ ...connection, password: event.target.value }))}
                />
                <button className="password-toggle" onClick={() => setShowPassword((value) => !value)} type="button">
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div className="modal-buttons">
              <button className="button cancel-button" onClick={() => setShowConnectionModal(false)} type="button">Cancel</button>
              <button className="button save-button" onClick={saveConnection} type="button">Save</button>
            </div>
          </div>
        </div>
      )}

      <div className="connection-tabs">
        {connections.map((connection) => (
          <div className="tab-container" key={connection.id}>
            <div className="tab-actions">
              <button className="edit-tab" onClick={() => editConnection(connection)} type="button">Edit</button>
              <button className="delete-tab" onClick={() => deleteConnection(connection)} type="button">X</button>
            </div>
            <button className={`tab ${connection.active ? "active" : ""}`} onClick={() => selectTab(connection)} type="button">{connection.name}</button>
          </div>
        ))}
        <button className="add-tab" onClick={addConnection} type="button">+</button>
        <div className="import-export-buttons">
          <button className="import-button" onClick={importConnections} type="button">Import</button>
          <button className="export-button" onClick={exportConnections} type="button">Export</button>
        </div>
      </div>

      <div className="main-content">
        <div className="sidebar">
          <div className="sidebar-header">
            <h3>Saved Stuff</h3>
            <div className="sidebar-toggle">
              <button className={activeSidebarTab === "queries" ? "active" : ""} onClick={() => setActiveSidebarTab("queries")} type="button">Queries</button>
              <button className={activeSidebarTab === "results" ? "active" : ""} onClick={() => setActiveSidebarTab("results")} type="button">Results</button>
            </div>
          </div>
          <div className="query-list">
            {(activeSidebarTab === "queries" ? savedQueries : savedResults).map((item) => (
              <div
                className={`query-item ${item.active ? "active" : ""}`}
                key={item.id}
                onClick={() => (activeSidebarTab === "queries" ? selectQuery(item as SavedQuery) : selectResult(item as SavedResult))}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === "Enter" && (activeSidebarTab === "queries" ? selectQuery(item as SavedQuery) : selectResult(item as SavedResult))}
              >
                <div className="query-content">
                  <span className="query-name">{item.name}</span>
                  <span className="query-preview">
                    {activeSidebarTab === "queries" ? `${(item as SavedQuery).query.substring(0, 50)}...` : `${(item as SavedResult).records.length} records`}
                  </span>
                </div>
                <button
                  className="delete-query"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (activeSidebarTab === "queries") {
                      deleteQuery(item as SavedQuery);
                    } else {
                      deleteResult(item as SavedResult);
                    }
                  }}
                  type="button"
                >
                  X
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="content-area">
          <div className="data-view">
            <div className={`table-section ${selectedRecord ? "with-detail" : ""}`}>
              <div className="table-header">
                <h3>Query Results</h3>
                {records.length > 0 && (
                  <>
                    <button className="button save-button" onClick={promptSaveResult} type="button">Save Results</button>
                    <span className="record-count">{records.length} records</span>
                  </>
                )}
              </div>

              {isLoading ? (
                <div className="loading-state"><div className="spinner"></div><p>Executing query...</p></div>
              ) : queryError ? (
                <div className="error-state"><h4>Query Error</h4><p>{queryError.message}</p></div>
              ) : (
                <div className="records-table" ref={recordsTableRef}>
                  <table>
                    <thead><tr>{records.length > 0 ? recordColumns.map((column) => <th key={column}>{column}</th>) : <th>No Data</th>}</tr></thead>
                    <tbody>
                      {records.length > 0 ? (
                        records.map((record, index) => (
                          <tr className={`record-row ${selectedRecord === record ? "active" : ""}`} key={index} onClick={() => selectRecord(record)}>
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
                <button className="close-detail" onClick={() => setSelectedRecord(null)} type="button">X</button>
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
                          <button className="copy-button" onClick={() => navigator.clipboard.writeText(String(value))} type="button">Copy</button>
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
      </div>

      <div className="query-section">
        <div className="query-input-container">
          <div className="query-header"><span className="query-label">SQL Query</span><span className="query-hint">Ctrl+Enter to execute</span></div>
          <div className="query-editor" ref={editorContainerRef}></div>
        </div>
        <div className="query-actions">
          <button className="button save-button" onClick={promptSaveQuery} type="button">Save</button>
          {isLoading ? (
            <button className="button cancel-button" onClick={abortQuery} type="button">Abort</button>
          ) : (
            <button className="button execute-button" onClick={executeQuery} disabled={isLoading} type="button">Execute</button>
          )}
        </div>
      </div>

      {showSaveQueryModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Save Query</h3>
            <div className="form-group">
              <label htmlFor="query-name">Query Name</label>
              <input id="query-name" type="text" value={queryNameInModal} ref={queryNameInputRef} onChange={(event) => setQueryNameInModal(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveQueryConfirmed()} />
            </div>
            <div className="modal-buttons">
              <button className="button cancel-button" onClick={() => setShowSaveQueryModal(false)} type="button">Cancel</button>
              <button className="button save-button" onClick={saveQueryConfirmed} type="button">Save</button>
            </div>
          </div>
        </div>
      )}

      {showSaveResultModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Save Result</h3>
            <div className="form-group">
              <label htmlFor="result-name">Result Name</label>
              <input id="result-name" type="text" value={resultNameInModal} ref={resultNameInputRef} onChange={(event) => setResultNameInModal(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveResultConfirmed()} />
            </div>
            <div className="modal-buttons">
              <button className="button cancel-button" onClick={() => setShowSaveResultModal(false)} type="button">Cancel</button>
              <button className="button save-button" onClick={saveResultConfirmed} type="button">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
