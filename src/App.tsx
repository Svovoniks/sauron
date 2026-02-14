import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectionModal } from "./components/ConnectionModal";
import { ConnectionTabs } from "./components/ConnectionTabs";
import { DataView } from "./components/DataView";
import { QuerySection } from "./components/QuerySection";
import { SaveNameModal } from "./components/SaveNameModal";
import { Sidebar } from "./components/Sidebar";
import { useSqlEditor } from "./hooks/useSqlEditor";
import { setRecords } from "./lib/db/common";
import { emptyConnection, type Connection, type SavedQuery, type SavedResult } from "./types/app";
import { getValueType, prettyPrintJson } from "./utils/record";

export default function App() {
  const recordsTableRef = useRef<HTMLDivElement | null>(null);
  const connectionNameInputRef = useRef<HTMLInputElement | null>(null);
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

  const { editorRef, editorContainerRef } = useSqlEditor(queryText, setQueryText, executeQuery);

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

  return (
    <div className="app-container">
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
        onDeleteConnection={deleteConnection}
        onSelectTab={selectTab}
        onImportConnections={importConnections}
        onExportConnections={exportConnections}
      />

      <div className="main-content">
        <Sidebar
          activeSidebarTab={activeSidebarTab}
          savedQueries={savedQueries}
          savedResults={savedResults}
          onSetSidebarTab={setActiveSidebarTab}
          onSelectQuery={selectQuery}
          onSelectResult={selectResult}
          onDeleteQuery={deleteQuery}
          onDeleteResult={deleteResult}
        />

        <DataView
          records={records}
          recordColumns={recordColumns}
          selectedRecord={selectedRecord}
          isLoading={isLoading}
          queryError={queryError}
          recordsTableRef={recordsTableRef}
          onSelectRecord={selectRecord}
          onSaveResult={promptSaveResult}
          onCloseDetail={() => setSelectedRecord(null)}
          prettyPrintJson={prettyPrintJson}
          getValueType={getValueType}
        />
      </div>

      <QuerySection
        editorContainerRef={editorContainerRef}
        isLoading={isLoading}
        onSaveQuery={promptSaveQuery}
        onAbortQuery={abortQuery}
        onExecuteQuery={executeQuery}
      />

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
    </div>
  );
}
