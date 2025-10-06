<script lang="ts">
    import { browser } from "$app/environment";
    import { open, save } from "@tauri-apps/plugin-dialog";
    import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
    import { onMount, tick, onDestroy } from "svelte";
    import { setRecords } from "$lib/db/common";
    import * as Monaco from "monaco-editor/esm/vs/editor/editor.api";

    import "monaco-sql-languages/esm/languages/mysql/mysql.contribution";
    import "monaco-sql-languages/esm/languages/flink/flink.contribution";
    import "monaco-sql-languages/esm/languages/spark/spark.contribution";
    import "monaco-sql-languages/esm/languages/hive/hive.contribution";
    import "monaco-sql-languages/esm/languages/trino/trino.contribution";
    import "monaco-sql-languages/esm/languages/pgsql/pgsql.contribution";
    import "monaco-sql-languages/esm/languages/impala/impala.contribution";
    import { LanguageIdEnum } from "monaco-sql-languages";

    import { vsPlusTheme } from "monaco-sql-languages";

    let editor: Monaco.editor.IStandaloneCodeEditor;
    let monaco: typeof Monaco;
    let editorContainer: HTMLElement;

    onMount(async () => {
        monaco = (await import("$lib/monaco")).default;
        monaco.editor.defineTheme("sql-dark", vsPlusTheme.darkThemeData);

        editor = monaco.editor.create(editorContainer, {
            lineNumbers: "off",
            minimap: { enabled: false },
            automaticLayout: false, // Disable automatic layout
            theme: "sql-dark",
            scrollbar: {
                vertical: "hidden",
                verticalSliderSize: 0,
                verticalScrollbarSize: 0,
            },
            language: LanguageIdEnum.FLINK,
            lineDecorationsWidth: "0px",
            find: undefined,
            wordWrap: "on",
            lineNumbersMinChars: 0,
            padding: {
                top: 5,
                bottom: 5,
            },
            renderLineHighlight: "none",
            value: queryText,
            fontSize: 15,
        });

        editor.onDidChangeModelContent(() => {
            if (editor) {
                queryText = editor.getValue();
            }
        });

        // Manually handle resizing
        const resizeObserver = new ResizeObserver(() => {
            editor.layout();
        });
        resizeObserver.observe(editorContainer);

        // Cleanup the observer when the component is destroyed
        onDestroy(() => {
            resizeObserver.disconnect();
        });
    });

    onDestroy(() => {
        monaco?.editor.getModels().forEach((model) => model.dispose());
        editor?.dispose();
    });

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

    let queryVersion = 0;

    let connections: Connection[] = [];
    let allSavedQueries: Record<string, SavedQuery[]> = {};
    let savedQueries: SavedQuery[] = [];
    let allSavedResults: Record<string, SavedResult[]> = {};
    let savedResults: SavedResult[] = [];

    let queryText = "SELECT * FROM system.tables LIMIT 10";
    let records: any[] = [];
    let selectedRecord: any | null = null;
    let isLoading = false;
    let queryError: Error | null = null;
    let abortController: AbortController | null = null;

    let showConnectionModal = false;
    let editingConnection: Connection | null = null;
    let connectionInModal: Connection = {
        id: "",
        name: "",
        host: "",
        port: "",
        username: "",
        password: "",
        database: "",
        db_type: "clickhouse",
    };

    let showPassword = false;

    let showSaveQueryModal = false;
    let queryNameInModal = "";
    let queryNameInput: HTMLInputElement;

    let showSaveResultModal = false;
    let resultNameInModal = "";
    let resultNameInput: HTMLInputElement;

    let activeSidebarTab = "queries";
    let recordsTableElement: HTMLElement;

    async function scrollToSelected() {
        await tick();
        const selectedElement =
            recordsTableElement?.querySelector(".record-row.active");
        if (selectedElement) {
            selectedElement.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
            });
        }
    }

    onMount(() => {
        const storedConnections = localStorage.getItem("connections");
        if (storedConnections) {
            connections = JSON.parse(storedConnections).map(
                (c: Connection) => ({
                    ...c,
                    id: c.id || crypto.randomUUID(),
                }),
            );
            if (connections.length > 0) {
                connections[0].active = true;
            }
            for (let i = 1; i < connections.length; i++) {
                connections[i].active = false;
            }
            saveConnections();
        }

        const storedQueries = localStorage.getItem("savedQueries");
        if (storedQueries) {
            const parsedQueries = JSON.parse(storedQueries);
            if (Array.isArray(parsedQueries)) {
                // Old format, migrate to new format
                if (connections.length > 0) {
                    allSavedQueries[connections[0].id] = parsedQueries.map(
                        (q: any) => ({ ...q, id: q.id || crypto.randomUUID() }),
                    );
                    saveQueries();
                }
            } else {
                for (const connId in parsedQueries) {
                    parsedQueries[connId] = parsedQueries[connId].map(
                        (q: any) => ({ ...q, id: q.id || crypto.randomUUID() }),
                    );
                }
                allSavedQueries = parsedQueries;
            }
            updateSavedQueries();
        }

        const storedResults = localStorage.getItem("savedResults");
        if (storedResults) {
            const parsedResults = JSON.parse(storedResults);
            for (const connId in parsedResults) {
                parsedResults[connId] = parsedResults[connId].map((r: any) => ({
                    ...r,
                    id: r.id || crypto.randomUUID(),
                }));
            }
            allSavedResults = parsedResults;
            updateSavedResults();
        }
    });

    function updateSavedQueries() {
        const activeConnection = connections.find((c) => c.active);
        if (activeConnection) {
            savedQueries = allSavedQueries[activeConnection.id] || [];
        } else {
            savedQueries = [];
        }
    }

    function updateSavedResults() {
        const activeConnection = connections.find((c) => c.active);
        if (activeConnection) {
            savedResults = allSavedResults[activeConnection.id] || [];
        } else {
            savedResults = [];
        }
    }

    function saveConnections() {
        localStorage.setItem("connections", JSON.stringify(connections));
    }

    function saveQueries() {
        localStorage.setItem("savedQueries", JSON.stringify(allSavedQueries));
    }

    function saveResults() {
        localStorage.setItem("savedResults", JSON.stringify(allSavedResults));
    }

    function addConnection() {
        editingConnection = null;
        connectionInModal = {
            id: "",
            name: "",
            host: "",
            port: "",
            username: "",
            password: "",
            database: "",
            db_type: "clickhouse",
        };
        showConnectionModal = true;
    }

    function editConnection(connection: Connection) {
        editingConnection = connection;
        connectionInModal = { ...connection };
        showConnectionModal = true;
    }

    function saveConnection() {
        if (connectionInModal.name && connectionInModal.host) {
            if (editingConnection) {
                const index = connections.findIndex(
                    (c) => editingConnection && c.id === editingConnection.id,
                );
                if (index !== -1) {
                    connections[index] = {
                        ...connectionInModal,
                        active: editingConnection.active,
                    };
                }
            } else {
                const newConnection: Connection = {
                    ...connectionInModal,
                    id: crypto.randomUUID(),
                    active: connections.length === 0,
                };
                connections = [...connections, newConnection];
                allSavedQueries[newConnection.id] = [];
                allSavedResults[newConnection.id] = [];
            }
            connections = connections;
            saveConnections();
            saveQueries();
            saveResults();
            showConnectionModal = false;
            updateSavedQueries();
            updateSavedResults();
        }
    }

    function deleteConnection(connectionToDelete: Connection) {
        delete allSavedQueries[connectionToDelete.id];
        delete allSavedResults[connectionToDelete.id];
        connections = connections.filter((c) => c.id !== connectionToDelete.id);
        if (connectionToDelete.active && connections.length > 0) {
            connections[0].active = true;
        }
        saveConnections();
        saveQueries();
        saveResults();
        updateSavedQueries();
        updateSavedResults();
    }

    async function promptSaveQuery() {
        queryNameInModal = "";
        showSaveQueryModal = true;
        await tick();
        queryNameInput.focus();
    }

    function saveQueryConfirmed() {
        if (queryNameInModal) {
            const activeConnection = connections.find((c) => c.active);
            if (activeConnection) {
                const newQuery: SavedQuery = {
                    id: crypto.randomUUID(),
                    name: queryNameInModal,
                    query: queryText,
                };
                if (!allSavedQueries[activeConnection.id]) {
                    allSavedQueries[activeConnection.id] = [];
                }
                allSavedQueries[activeConnection.id].push(newQuery);
                allSavedQueries = allSavedQueries;
                saveQueries();
                updateSavedQueries();
                showSaveQueryModal = false;
            }
        }
    }

    function deleteQuery(queryToDelete: SavedQuery) {
        const activeConnection = connections.find((c) => c.active);
        if (activeConnection) {
            allSavedQueries[activeConnection.id] = allSavedQueries[
                activeConnection.id
            ].filter((q) => q.id !== queryToDelete.id);
            saveQueries();
            updateSavedQueries();
        }
    }

    async function promptSaveResult() {
        resultNameInModal = "";
        showSaveResultModal = true;
        await tick();
        resultNameInput.focus();
    }

    function saveResultConfirmed() {
        if (resultNameInModal) {
            const activeConnection = connections.find((c) => c.active);
            if (activeConnection) {
                const newResult: SavedResult = {
                    id: crypto.randomUUID(),
                    name: resultNameInModal,
                    records: records,
                    query: queryText,
                };
                if (!allSavedResults[activeConnection.id]) {
                    allSavedResults[activeConnection.id] = [];
                }
                allSavedResults[activeConnection.id].push(newResult);
                allSavedResults = allSavedResults;
                saveResults();
                updateSavedResults();
                showSaveResultModal = false;
            }
        }
    }

    function deleteResult(resultToDelete: SavedResult) {
        const activeConnection = connections.find((c) => c.active);
        if (activeConnection) {
            allSavedResults[activeConnection.id] = allSavedResults[
                activeConnection.id
            ].filter((r) => r.id !== resultToDelete.id);
            saveResults();
            updateSavedResults();
        }
    }

    function setResults(newRecords: any[]) {
        records = newRecords;
        isLoading = false;
    }

    function onError(error: Error) {
        if (error.name === "AbortError") {
            queryError = new Error("Query was aborted.");
        } else {
            queryError = error;
        }
        records = [];
        isLoading = false;
    }

    function executeQuery() {
        isLoading = true;
        queryError = null;
        selectedRecord = null;

        const activeConnection = connections.find((c) => c.active);
        if (!activeConnection) {
            onError(new Error("No active connection selected."));
            return;
        }

        abortController = new AbortController();

        setRecords(
            queryText,
            activeConnection,
            setResults,
            onError,
            abortController.signal,
        );
    }

    function abortQuery() {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    }

    function selectTab(tab: Connection) {
        connections = connections.map((c) => ({
            ...c,
            active: c.id === tab.id,
        }));
        updateSavedQueries();
        updateSavedResults();
    }

    async function exportConnections() {
        if (browser) {
            try {
                const filePath = await save({
                    filters: [
                        {
                            name: "JSON",
                            extensions: ["json"],
                        },
                    ],
                });
                if (filePath) {
                    const exportData = {
                        connections: connections,
                        queries: allSavedQueries,
                        results: allSavedResults,
                    };
                    const data = JSON.stringify(exportData, null, 2);
                    await writeTextFile(filePath, data);
                }
            } catch (err) {
                console.error(err);
            }
        }
    }

    async function importConnections() {
        if (browser) {
            try {
                const selected = await open({
                    multiple: false,
                    filters: [
                        {
                            name: "JSON",
                            extensions: ["json"],
                        },
                    ],
                });
                if (selected) {
                    const data = await readTextFile(selected as string);
                    const importedData = JSON.parse(data);

                    if (importedData.connections && importedData.queries) {
                        connections = importedData.connections.map(
                            (c: Connection) => ({
                                ...c,
                                id: c.id || crypto.randomUUID(),
                            }),
                        );

                        for (const connId in importedData.queries) {
                            importedData.queries[connId] = importedData.queries[connId].map(
                                (q: any) => ({ ...q, id: q.id || crypto.randomUUID() }),
                            );
                        }
                        allSavedQueries = importedData.queries;

                        if (importedData.results) {
                            for (const connId in importedData.results) {
                                importedData.results[connId] = importedData.results[connId].map(
                                    (r: any) => ({ ...r, id: r.id || crypto.randomUUID() }),
                                );
                            }
                        }
                        allSavedResults = importedData.results || {};
                    } else {
                        // Old format
                        connections = importedData.map((c: Connection) => ({
                            ...c,
                            id: c.id || crypto.randomUUID(),
                        }));
                        allSavedQueries = {};
                        allSavedResults = {};
                    }

                    if (connections.length > 0) {
                        connections[0].active = true;
                    }

                    saveConnections();
                    saveQueries();
                    saveResults();
                    updateSavedQueries();
                    updateSavedResults();
                }
            } catch (err) {
                console.error(err);
            }
        }
    }

    function selectQuery(query: SavedQuery) {
        savedQueries = savedQueries.map((q) => ({ ...q, active: q.id === query.id }));
        queryText = query.query;
        editor.setValue(queryText);
        queryVersion++;
    }

    function selectResult(result: SavedResult) {
        savedResults = savedResults.map((r) => ({
            ...r,
            active: r.id === result.id,
        }));
        records = result.records;
        queryText = result.query;
        editor.setValue(queryText);
        queryError = null;
        queryVersion++;
    }

    function selectRecord(record: any) {
        if (selectedRecord === record) {
            selectedRecord = null;
        } else {
            selectedRecord = record;
        }
    }

    function prettyPrintJson(value: any) {
        if (value === null || value === undefined) {
            return "null";
        }

        const stringValue = String(value);

        // Try to parse as JSON
        try {
            const parsed = JSON.parse(stringValue);
            return JSON.stringify(parsed, null, 2);
        } catch (e) {
            // If not JSON, check if it looks like a formatted string
            if (stringValue.includes("\n") || stringValue.length > 100) {
                return stringValue;
            }
            return stringValue;
        }
    }

    function getValueType(value: any) {
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
    }

    async function handleKeydown(event: KeyboardEvent) {
        if (event.ctrlKey && event.key === "Enter") {
            event.preventDefault();
            executeQuery();
        }
        if (event.key === "Escape") {
            if (showConnectionModal) {
                showConnectionModal = false;
                return;
            }
            if (showSaveQueryModal) {
                showSaveQueryModal = false;
                return;
            }
            if (showSaveResultModal) {
                showSaveResultModal = false;
                return;
            }
            if (selectedRecord) {
                selectedRecord = null;
            }
        }

        const target = event.target as HTMLElement;
        if (
            target &&
            (target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable)
        ) {
            return;
        }

        if (records.length > 0 && selectedRecord) {
            if (event.key === "ArrowDown" || event.key === "j") {
                event.preventDefault();
                const currentIndex = records.indexOf(selectedRecord);
                const nextIndex = (currentIndex + 1) % records.length;
                selectedRecord = records[nextIndex];
                scrollToSelected();
            } else if (event.key === "ArrowUp" || event.key === "k") {
                event.preventDefault();
                const currentIndex = records.indexOf(selectedRecord);
                const prevIndex =
                    (currentIndex - 1 + records.length) % records.length;
                selectedRecord = records[prevIndex];
                scrollToSelected();
            }
        }
    }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="app-container">
    <!-- Connection Modal -->
    {#if showConnectionModal}
        <div class="modal-backdrop">
            <div class="modal">
                <h3>
                    {editingConnection ? "Edit Connection" : "New Connection"}
                </h3>
                <div class="form-group">
                    <label>Database Type</label>
                    <div
                        class="db-type-switch"
                        class:clickhouse={connectionInModal.db_type ===
                            "clickhouse"}
                    >
                        <button
                            class:active={connectionInModal.db_type ===
                                "postgres"}
                            on:click={() =>
                                (connectionInModal.db_type = "postgres")}
                        >
                            Postgres
                        </button>
                        <button
                            class:active={connectionInModal.db_type ===
                                "clickhouse"}
                            on:click={() =>
                                (connectionInModal.db_type = "clickhouse")}
                        >
                            ClickHouse
                        </button>
                    </div>
                </div>
                <div class="form-group">
                    <label for="connection-name">Connection Name</label>
                    <input
                        id="connection-name"
                        type="text"
                        placeholder="stage"
                        bind:value={connectionInModal.name}
                        autocorrect="off"
                    />
                </div>
                <div class="host-port-group">
                    <div class="form-group">
                        <label for="host">Host</label>
                        <input
                            id="host"
                            type="text"
                            placeholder="localhost"
                            bind:value={connectionInModal.host}
                            autocorrect="off"
                        />
                    </div>
                    <div class="form-group">
                        <label for="port">Port</label>
                        <input
                            id="port"
                            type="text"
                            placeholder="5432"
                            bind:value={connectionInModal.port}
                            autocorrect="off"
                        />
                    </div>
                </div>
                <div class="form-group">
                    <label for="database">Database</label>
                    <input
                        id="database"
                        type="text"
                        placeholder="postgres"
                        bind:value={connectionInModal.database}
                        autocorrect="off"
                    />
                </div>
                <div class="form-group">
                    <label for="username">Username</label>
                    <input
                        id="username"
                        type="text"
                        placeholder="user"
                        bind:value={connectionInModal.username}
                        autocorrect="off"
                    />
                </div>
                <div class="form-group">
                    <label for="password">Password</label>
                    <div class="password-input-container">
                        <input
                            id="password"
                            type={showPassword ? "text" : "password"}
                            bind:value={connectionInModal.password}
                            autocorrect="off"
                            autocapitalize="none"
                        />
                        <button
                            on:click={() => (showPassword = !showPassword)}
                            class="password-toggle"
                        >
                            {showPassword ? "🙈" : "👁️"}
                        </button>
                    </div>
                </div>
                <div class="modal-buttons">
                    <button
                        class="button cancel-button"
                        on:click={() => (showConnectionModal = false)}
                        >Cancel</button
                    >
                    <button class="button save-button" on:click={saveConnection}
                        >Save</button
                    >
                </div>
            </div>
        </div>
    {/if}

    <!-- Save Query Modal -->
    {#if showSaveQueryModal}
        <div class="modal-backdrop">
            <div class="modal">
                <h3>Save Query</h3>
                <div class="form-group">
                    <label for="query-name">Query Name</label>
                    <input
                        id="query-name"
                        type="text"
                        placeholder="name"
                        bind:value={queryNameInModal}
                        bind:this={queryNameInput}
                        autocorrect="off"
                        on:keydown={(e) => {
                            if (e.key === "Enter") {
                                saveQueryConfirmed();
                            }
                        }}
                    />
                </div>
                <div class="modal-buttons">
                    <button
                        class="button cancel-button"
                        on:click={() => (showSaveQueryModal = false)}
                        >Cancel</button
                    >
                    <button
                        class="button save-button"
                        on:click={saveQueryConfirmed}>Save</button
                    >
                </div>
            </div>
        </div>
    {/if}

    <!-- Save Result Modal -->
    {#if showSaveResultModal}
        <div class="modal-backdrop">
            <div class="modal">
                <h3>Save Result</h3>
                <div class="form-group">
                    <label for="result-name">Result Name</label>
                    <input
                        id="result-name"
                        type="text"
                        placeholder="name"
                        bind:value={resultNameInModal}
                        bind:this={resultNameInput}
                        autocorrect="off"
                        on:keydown={(e) => {
                            if (e.key === "Enter") {
                                saveResultConfirmed();
                            }
                        }}
                    />
                </div>
                <div class="modal-buttons">
                    <button
                        class="button cancel-button"
                        on:click={() => (showSaveResultModal = false)}
                        >Cancel</button
                    >
                    <button
                        class="button save-button"
                        on:click={saveResultConfirmed}>Save</button
                    >
                </div>
            </div>
        </div>
    {/if}

    <!-- Connection Tabs -->
    <div class="connection-tabs">
        {#each connections as connection}
            <div class="tab-container">
                <div class="tab-actions">
                    <button
                        class="edit-tab"
                        on:click={() => editConnection(connection)}
                        title="Edit connection">✏️</button
                    >
                    <button
                        class="delete-tab"
                        on:click={() => deleteConnection(connection)}
                        title="Delete connection">✕</button
                    >
                </div>
                <button
                    class="tab {connection.active ? 'active' : ''}"
                    on:click={() => selectTab(connection)}
                >
                    {connection.name}
                </button>
            </div>
        {/each}
        <button
            class="add-tab"
            on:click={addConnection}
            title="Add new connection">+</button
        >
        <div class="import-export-buttons">
            <button
                class="import-button"
                on:click={importConnections}
                title="Import connections from JSON"
            >
                Import
            </button>
            <button
                class="export-button"
                on:click={exportConnections}
                title="Export connections to JSON"
            >
                Export
            </button>
        </div>
    </div>

    <!-- Main Content -->
    <div class="main-content">
        <!-- Sidebar -->
        <div class="sidebar">
            <div class="sidebar-header">
                <h3>📁 Saved Stuff</h3>
                <div class="sidebar-toggle">
                    <button
                        class:active={activeSidebarTab === "queries"}
                        on:click={() => (activeSidebarTab = "queries")}
                    >
                        Queries
                    </button>
                    <button
                        class:active={activeSidebarTab === "results"}
                        on:click={() => (activeSidebarTab = "results")}
                    >
                        Results
                    </button>
                </div>
            </div>
            {#if activeSidebarTab === "queries"}
                <div class="query-list">
                    {#each savedQueries as query}
                        <div
                            class="query-item {query.active ? 'active' : ''}"
                            on:click={() => selectQuery(query)}
                            role="button"
                            tabindex="0"
                            on:keydown={(e) =>
                                e.key === "Enter" && selectQuery(query)}
                        >
                            <div class="query-content">
                                <span class="query-name">{query.name}</span>
                                <span class="query-preview"
                                    >{query.query.substring(0, 50)}...</span
                                >
                            </div>
                            <button
                                class="delete-query"
                                on:click|stopPropagation={() =>
                                    deleteQuery(query)}
                                title="Delete query">✕</button
                            >
                        </div>
                    {/each}
                    {#if savedQueries.length === 0}
                        <div class="empty-state">
                            <p>No saved queries yet</p>
                            <p class="hint">
                                Save your first query to get started!
                            </p>
                        </div>
                    {/if}
                </div>
            {:else}
                <div class="query-list">
                    {#each savedResults as result}
                        <div
                            class="query-item {result.active ? 'active' : ''}"
                            on:click={() => selectResult(result)}
                            role="button"
                            tabindex="0"
                            on:keydown={(e) =>
                                e.key === "Enter" && selectResult(result)}
                        >
                            <div class="query-content">
                                <span class="query-name">{result.name}</span>
                                <span class="query-preview"
                                    >{result.records.length} records</span
                                >
                            </div>
                            <button
                                class="delete-query"
                                on:click|stopPropagation={() =>
                                    deleteResult(result)}
                                title="Delete result">✕</button
                            >
                        </div>
                    {/each}
                    {#if savedResults.length === 0}
                        <div class="empty-state">
                            <p>No saved results yet</p>
                            <p class="hint">
                                Save your first result to get started!
                            </p>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- Content Area -->
        <div class="content-area">
            <div class="data-view">
                <!-- Table Section -->
                <div class="table-section" class:with-detail={selectedRecord}>
                    <div class="table-header">
                        <h3>📊 Query Results</h3>
                        {#if records.length > 0}
                            <button
                                class="button save-button"
                                on:click={promptSaveResult}
                            >
                                💾 Save Results
                            </button>
                            <span class="record-count"
                                >{records.length} records</span
                            >
                        {/if}
                    </div>

                    {#if isLoading}
                        <div class="loading-state">
                            <div class="spinner"></div>
                            <p>Executing query...</p>
                        </div>
                    {:else if queryError}
                        <div class="error-state">
                            <div class="error-icon">⚠️</div>
                            <h4>Query Error</h4>
                            <p>{queryError.message}</p>
                        </div>
                    {:else}
                        <div
                            class="records-table"
                            bind:this={recordsTableElement}
                        >
                            <table>
                                <thead>
                                    <tr>
                                        {#if records.length > 0}
                                            {#each Object.keys(records[0]) as column}
                                                <th>{column}</th>
                                            {/each}
                                        {:else}
                                            <th>No Data</th>
                                        {/if}
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each records as record, index}
                                        <tr
                                            class="record-row {selectedRecord ===
                                            record
                                                ? 'active'
                                                : ''}"
                                            on:click={() =>
                                                selectRecord(record)}
                                        >
                                            {#each Object.values(record) as value}
                                                <td
                                                    class="truncate"
                                                    title={String(value)}
                                                    >{value}</td
                                                >
                                            {/each}
                                        </tr>
                                    {:else}
                                        <tr>
                                            <td colspan="100" class="no-data">
                                                <div class="empty-table">
                                                    <div class="empty-icon">
                                                        📋
                                                    </div>
                                                    <p>No records found</p>
                                                    <p class="hint">
                                                        Execute a query to see
                                                        results
                                                    </p>
                                                </div>
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    {/if}
                </div>

                <!-- Enhanced Detail View -->
                <div class="detail-view" class:visible={selectedRecord}>
                    <div class="detail-header">
                        <h4>🔍 Record Details</h4>
                        <button
                            class="close-detail"
                            on:click={() => (selectedRecord = null)}
                            title="Close details"
                        >
                            ✕
                        </button>
                    </div>

                    {#if selectedRecord}
                        <div class="detail-content">
                            {#each Object.entries(selectedRecord) as [key, value]}
                                <div class="detail-item">
                                    <div class="detail-key">
                                        <span class="key-name">{key}</span>
                                        <span class="key-type"
                                            >{getValueType(value)}</span
                                        >
                                    </div>
                                    <div class="detail-value">
                                        <div class="value-container">
                                            <pre
                                                class="value-content {getValueType(
                                                    value,
                                                )}">{prettyPrintJson(
                                                    value,
                                                )}</pre>
                                            <button
                                                class="copy-button"
                                                on:click={() =>
                                                    navigator.clipboard.writeText(
                                                        String(value),
                                                    )}
                                                title="Copy value"
                                            >
                                                📋
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <div class="detail-placeholder">
                            <div class="placeholder-icon">👆</div>
                            <p>Select a record to view details</p>
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    </div>

    <!-- Enhanced Query Section -->
    <div class="query-section">
        <div class="query-input-container">
            <div class="query-header">
                <span class="query-label">💻 SQL Query</span>
                <span class="query-hint">Ctrl+Enter to execute</span>
            </div>
            <div class="query-editor" bind:this={editorContainer}></div>
        </div>
        <div class="query-actions">
            <button class="button save-button" on:click={promptSaveQuery}>
                💾 Save
            </button>
            {#if isLoading}
                <button class="button cancel-button" on:click={abortQuery}>
                    🚫 Abort
                </button>
            {:else}
                <button
                    class="button execute-button"
                    on:click={executeQuery}
                    disabled={isLoading}
                >
                    ▶️ Execute
                </button>
            {/if}
        </div>
    </div>
</div>

<style>
    .db-type-switch {
        position: relative;
        display: flex;
        width: 100%;
        background: rgba(15, 15, 35, 0.8);
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        overflow: hidden;
    }

    .db-type-switch::before {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        width: 50%;
        height: 100%;
        background: #3b82f6;
        border-radius: 10px;
        transition: transform 0.3s ease;
        transform: translateX(0);
    }

    .db-type-switch.clickhouse::before {
        transform: translateX(100%);
    }

    .db-type-switch button {
        flex: 1;
        padding: 10px;
        border: none;
        background: transparent;
        color: #e2e8f0;
        cursor: pointer;
        position: relative;
        z-index: 1;
    }

    .password-input-container {
        position: relative;
        display: flex;
        align-items: center;
    }

    .password-input-container input {
        width: 100%;
        padding-right: 40px; /* Make space for the button */
    }

    .password-toggle {
        position: absolute;
        right: 10px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 20px;
    }

    /* Modal Styles */
    .modal-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        backdrop-filter: blur(4px);
    }

    .modal {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        padding: 32px;
        border-radius: 16px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        width: 480px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    }

    .modal h3 {
        text-align: center;
        font-size: 24px;
        font-weight: 700;
        color: #f1f5f9;
        margin: 0;
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }

    .form-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .form-group label {
        font-size: 14px;
        font-weight: 600;
        color: #94a3b8;
    }

    .host-port-group {
        display: grid;
        grid-template-columns: 3fr 1fr;
        gap: 16px;
    }

    .host-port-group .form-group {
        min-width: 0;
    }

    .modal input {
        padding: 14px 18px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        background: rgba(15, 15, 35, 0.8);
        color: #e2e8f0;
        font-size: 16px;
        transition: all 0.3s ease;
    }

    .modal input:focus {
        outline: none;
        border-color: #3b82f6;
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
        background: rgba(15, 15, 35, 1);
    }

    .modal-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-top: 8px;
    }

    .cancel-button {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .cancel-button:hover {
        background: rgba(239, 68, 68, 0.25);
        transform: translateY(-1px);
    }

    /* Connection Tabs */
    .tab-container {
        position: relative;
        display: flex;
        flex-direction: column;
        background: rgba(15, 23, 42, 0.8);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 12px;
        overflow: hidden;
        padding: 8px;
        transition: all 0.3s ease;
    }

    .tab-container:hover {
        border-color: rgba(148, 163, 184, 0.4);
        transform: translateY(-1px);
    }

    .tab {
        flex-grow: 1;
        padding: 8px 12px;
        background: rgba(51, 65, 85, 0.6);
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        font-size: 14px;
        font-weight: 600;
        color: #e2e8f0;
    }

    .tab:hover {
        background: rgba(71, 85, 105, 0.8);
    }

    .tab.active {
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        color: white;
        box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
    }

    .tab-actions {
        align-self: center;
        display: flex;
        gap: 4px;
        margin-bottom: 4px;
    }

    .edit-tab,
    .delete-tab {
        color: white;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 24px;
        font-size: 12px;
        border-radius: 6px;
        transition: all 0.2s ease;
    }

    .edit-tab {
        background: rgba(245, 158, 11, 0.8);
    }

    .delete-tab {
        background: rgba(239, 68, 68, 0.8);
    }

    .edit-tab:hover,
    .delete-tab:hover {
        transform: scale(1.1);
        opacity: 1;
    }

    .add-tab {
        width: 40px;
        height: 40px;
        background: rgba(34, 197, 94, 0.15);
        border: 2px dashed rgba(34, 197, 94, 0.4);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.3s ease;
        font-size: 20px;
        font-weight: bold;
        color: #22c55e;
    }

    .add-tab:hover {
        background: rgba(34, 197, 94, 0.25);
        border-color: #22c55e;
        border-style: solid;
        transform: scale(1.05);
    }

    .export-button {
        padding: 0 1rem;
        height: 30px;
        background: rgba(59, 130, 246, 0.15);
        border: 2px dashed rgba(59, 130, 246, 0.4);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.3s ease;
        font-size: 14px;
        font-weight: bold;
        color: #3b82f6;
    }

    .export-button:hover {
        background: rgba(59, 130, 246, 0.25);
        border-color: #3b82f6;
        border-style: solid;
        transform: scale(1.05);
    }

    .import-export-buttons {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .import-button,
    .export-button {
        width: 90px;
    }

    .import-button {
        padding: 0 1rem;
        height: 30px;
        background: rgba(245, 158, 11, 0.15);
        border: 2px dashed rgba(245, 158, 11, 0.4);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.3s ease;
        font-size: 14px;
        font-weight: bold;
        color: #f59e0b;
    }

    .import-button:hover {
        background: rgba(245, 158, 11, 0.25);
        border-color: #f59e0b;
        border-style: solid;
        transform: scale(1.05);
    }

    /* Enhanced Sidebar */
    .sidebar {
        background: linear-gradient(
            135deg,
            rgba(26, 26, 46, 0.9),
            rgba(22, 33, 62, 0.9)
        );
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 16px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        min-height: 0;
        width: 350px;
        flex-shrink: 0;
        gap: 16px;
        backdrop-filter: blur(10px);
    }

    .sidebar-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
    }

    .sidebar h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        color: #f1f5f9;
    }

    .sidebar-toggle {
        display: flex;
        background: rgba(51, 65, 85, 0.6);
        border-radius: 8px;
        padding: 4px;
    }

    .sidebar-toggle button {
        flex: 1;
        padding: 6px 12px;
        border: none;
        background: transparent;
        color: #e2e8f0;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.3s ease;
        font-size: 12px;
        font-weight: 600;
    }

    .sidebar-toggle button.active {
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        color: white;
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
    }

    .query-count {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
        padding: 4px 8px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
    }

    .query-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 5px;
        scrollbar-width: none;
    }

    .query-item {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 16px;
        border-radius: 12px;
        transition: all 0.3s ease;
        cursor: pointer;
        border: 1px solid rgba(148, 163, 184, 0.2);
        background: rgba(51, 65, 85, 0.3);
        position: relative;
    }

    .query-content {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 0;
    }

    .query-name {
        font-weight: 600;
        color: #f1f5f9;
        font-size: 14px;
    }

    .query-preview {
        font-size: 12px;
        color: #94a3b8;
        opacity: 0.8;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .query-item:hover {
        background: rgba(71, 85, 105, 0.5);
        border-color: rgba(148, 163, 184, 0.4);
        transform: translateX(4px);
    }

    .query-item.active {
        background: linear-gradient(
            135deg,
            rgba(59, 130, 246, 0.3),
            rgba(29, 78, 216, 0.3)
        );
        border-color: rgba(59, 130, 246, 0.6);
        box-shadow: 0 4px 16px rgba(59, 130, 246, 0.2);
    }

    .delete-query {
        background: rgba(239, 68, 68, 0.8);
        color: white;
        border: none;
        border-radius: 6px;
        width: 24px;
        height: 24px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        transition: all 0.2s ease;
        flex-shrink: 0;
    }

    .delete-query:hover {
        background: rgba(239, 68, 68, 1);
        transform: scale(1.1);
    }

    .empty-state {
        text-align: center;
        padding: 32px 16px;
        color: #64748b;
    }

    .empty-state p {
        margin: 0 0 8px 0;
    }

    .hint {
        font-size: 12px;
        opacity: 0.7;
    }

    /* Global Styles */
    :global(*) {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    :global(html, body) {
        height: 100%;
        overflow: hidden;
    }

    :global(body) {
        font-family:
            "Inter",
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
        background: linear-gradient(
            135deg,
            #0f0f23 0%,
            #1a1a2e 50%,
            #16213e 100%
        );
        color: #e2e8f0;
    }

    .app-container {
        height: 100vh;
        display: flex;
        flex-direction: column;
        padding: 10px;
        gap: 10px;
        background: linear-gradient(
            135deg,
            #0f0f23 0%,
            #1a1a2e 50%,
            #16213e 100%
        );
    }

    .connection-tabs {
        padding: 8px;
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: nowrap; /* Prevent wrapping */
        overflow-x: auto; /* Enable horizontal scrolling */
        -webkit-overflow-scrolling: touch; /* Smooth scrolling on iOS */
        scrollbar-width: none; /* Firefox: thin scrollbar */
        scrollbar-color: #aaa transparent; /* Firefox: thumb and track color */
    }

    .connection-tabs > * {
        flex-shrink: 0; /* Critical! Stops items from compressing */
        align-self: center;
    }

    .main-content {
        display: flex;
        gap: 10px;
        flex: 1;
        min-height: 0;
    }

    .content-area {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
        min-width: 0;
    }

    .data-view {
        display: flex;
        gap: 20px;
        flex: 1;
        min-height: 0;
        align-items: stretch;
        position: relative;
    }

    .table-section {
        display: flex;
        flex-direction: column;
        width: 100%;
        transition: all 0.5s ease;
        background: linear-gradient(
            135deg,
            rgba(26, 26, 46, 0.9),
            rgba(22, 33, 62, 0.9)
        );
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 16px;
        padding: 10px;
        backdrop-filter: blur(10px);
    }

    .table-section.with-detail {
        width: 50%;
    }

    .table-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        gap: 16px;
    }

    .table-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        color: #f1f5f9;
        flex-shrink: 0;
    }

    .record-count {
        background: rgba(34, 197, 94, 0.2);
        color: #4ade80;
        padding: 4px 12px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
    }

    .records-table {
        flex: 1;
        overflow: auto;
        border-radius: 12px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        background: rgba(15, 23, 42, 0.6);
        scrollbar-width: none;
    }

    table {
        width: 100%;
        border-collapse: collapse;
    }

    th {
        background: linear-gradient(
            135deg,
            rgba(51, 65, 85, 0.8),
            rgba(71, 85, 105, 0.8)
        );
        padding: 16px 12px;
        text-align: left;
        font-weight: 700;
        font-size: 13px;
        color: #f1f5f9;
        border-bottom: 1px solid rgba(148, 163, 184, 0.3);
        position: sticky;
        top: 0;
        z-index: 10;
        letter-spacing: 0.5px;
    }

    td {
        padding: 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.1);
        font-size: 13px;
        max-width: 200px;
        transition: all 0.2s ease;
    }

    .truncate {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .record-row {
        cursor: pointer;
        transition: all 0.3s ease;
    }

    .record-row:hover {
        background: rgba(71, 85, 105, 0.4);
    }

    .record-row.active {
        background: linear-gradient(
            135deg,
            rgba(6, 182, 212, 0.3),
            rgba(8, 145, 178, 0.3)
        );
        box-shadow: inset 3px 0 0 #06b6d4;
    }

    .record-row.active td {
        color: #67e8f9;
        font-weight: 500;
    }

    .empty-table {
        text-align: center;
        padding: 48px 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
    }

    .empty-icon {
        font-size: 48px;
        opacity: 0.5;
    }

    .empty-table p {
        color: #64748b;
        margin: 0;
    }

    .empty-table .hint {
        font-size: 14px;
        opacity: 0.7;
    }

    /* Enhanced Detail View - Full Screen Height */
    .detail-view {
        background: linear-gradient(
            135deg,
            rgba(26, 26, 46, 0.95),
            rgba(22, 33, 62, 0.95)
        );
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 16px;
        padding: 24px;
        width: 50%;
        display: flex;
        flex-direction: column;
        backdrop-filter: blur(15px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        transform: translateX(100%);
        opacity: 0;
        transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 90;
        height: calc(100vh - 28px);
    }

    .detail-view.visible {
        transform: translateX(0);
        opacity: 1;
    }

    .detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    }

    .detail-header h4 {
        font-size: 20px;
        font-weight: 700;
        color: #f1f5f9;
        margin: 0;
    }

    .close-detail {
        background: rgba(239, 68, 68, 0.2);
        color: #f87171;
        border: none;
        border-radius: 8px;
        width: 32px;
        height: 32px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.2s ease;
    }

    .close-detail:hover {
        background: rgba(239, 68, 68, 0.3);
        transform: scale(1.1);
    }

    .detail-item {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 8px;
        padding: 16px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.15);
        border-radius: 12px;
        transition: all 0.2s ease;
    }

    .detail-item:hover {
        border-color: rgba(148, 163, 184, 0.3);
        background: rgba(15, 23, 42, 0.8);
    }

    .detail-key {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
    }

    .key-name {
        font-weight: 700;
        color: #94a3b8;
        font-size: 13px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
    }

    .key-type {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
        padding: 2px 8px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
    }

    .key-type.null {
        background: rgba(107, 114, 128, 0.2);
        color: #9ca3af;
    }

    .key-type.boolean {
        background: rgba(245, 158, 11, 0.2);
        color: #fbbf24;
    }

    .key-type.number {
        background: rgba(34, 197, 94, 0.2);
        color: #4ade80;
    }

    .key-type.json {
        background: rgba(168, 85, 247, 0.2);
        color: #c084fc;
    }

    .value-container {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 8px;
    }

    .value-content {
        flex: 1;
        padding: 12px;
        background: rgba(15, 15, 35, 0.8);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 8px;
        color: #e2e8f0;
        font-size: 13px;
        font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        min-height: 40px;
        overflow-x: hidden;
        scrollbar-width: none;
    }

    .value-content.null {
        color: #9ca3af;
        font-style: italic;
    }

    .value-content.boolean {
        color: #fbbf24;
        font-weight: 600;
    }

    .value-content.number {
        color: #4ade80;
        font-weight: 600;
    }

    .value-content.json {
        color: #c084fc;
    }

    .copy-button {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
        border: none;
        border-radius: 6px;
        width: 32px;
        height: 32px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.2s ease;
        flex-shrink: 0;
    }

    .copy-button:hover {
        background: rgba(59, 130, 246, 0.3);
        transform: scale(1.05);
    }

    .detail-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 1;
        gap: 16px;
        color: #64748b;
        text-align: center;
    }

    .placeholder-icon {
        font-size: 48px;
        opacity: 0.5;
    }

    .detail-placeholder p {
        margin: 0;
        font-size: 16px;
    }

    /* Enhanced Query Section */
    .query-section {
        display: flex;
        gap: 20px;
        align-items: stretch;
        flex-shrink: 0;
        min-height: 185px;
        background: linear-gradient(
            135deg,
            rgba(26, 26, 46, 0.9),
            rgba(22, 33, 62, 0.9)
        );
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 16px;
        padding: 10px;
        backdrop-filter: blur(10px);
        resize: vertical;
        overflow: auto;
        scrollbar-width: none;
    }

    .query-input-container {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
    }

    .query-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .query-label {
        font-weight: 700;
        color: #f1f5f9;
        font-size: 16px;
    }

    .query-hint {
        font-size: 12px;
        color: #94a3b8;
        background: rgba(51, 65, 85, 0.6);
        padding: 4px 8px;
        border-radius: 6px;
    }

    .query-editor {
        position: relative;
        background: rgba(15, 15, 35, 0.9);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 12px;
        font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
        font-size: 14px;
        line-height: 1.6;
        transition: all 0.3s ease;
        flex-grow: 1;
        user-select: text;
        -webkit-user-select: text;
        -moz-user-select: text;
        -ms-user-select: text;
        overflow: hidden;
    }

    .query-actions {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 12px;
    }

    .button {
        padding: 14px 24px;
        border: none;
        border-radius: 12px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
        transition: all 0.3s ease;
        min-width: 120px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        position: relative;
        overflow: hidden;
    }

    .save-button {
        background: linear-gradient(135deg, #10b981, #059669);
        color: white;
        box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3);
    }

    .save-button:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4);
    }

    .execute-button {
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        color: white;
        box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3);
    }

    .execute-button:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(59, 130, 246, 0.4);
    }

    button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none !important;
    }

    /* Loading and Error States */
    .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 80px 40px;
        color: #94a3b8;
        gap: 20px;
    }

    .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(59, 130, 246, 0.2);
        border-top: 3px solid #3b82f6;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .loading-state p {
        margin: 0;
        font-size: 16px;
        font-weight: 500;
    }

    .error-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px 32px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 12px;
        color: #f87171;
        text-align: center;
        gap: 16px;
    }

    .error-icon {
        font-size: 48px;
    }

    .error-state h4 {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        color: #f87171;
    }

    .error-state p {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        background: rgba(15, 15, 35, 0.6);
        padding: 12px 16px;
        border-radius: 8px;
        font-family: "Monaco", "Menlo", monospace;
        word-break: break-word;
    }

    /* Responsive Design */
    @media (max-width: 1024px) {
        .main-content {
            flex-direction: column;
            gap: 16px;
        }

        .sidebar {
            width: 100%;
            max-height: 200px;
        }

        .content-area {
            width: 100%;
        }

        .data-view {
            flex-direction: column;
        }

        .table-section,
        .table-section.with-detail {
            width: 100%;
        }

        .detail-view {
            width: 100%;
            max-height: 400px;
        }
    }

    @media (max-width: 768px) {
        .app-container {
            padding: 16px;
            gap: 16px;
        }

        .query-section {
            flex-direction: column;
            gap: 16px;
            align-items: stretch;
        }

        .query-actions {
            flex-direction: row;
        }

        .connection-tabs {
            flex-wrap: wrap;
            gap: 8px;
        }

        .modal {
            width: 90%;
            margin: 16px;
        }

        .host-port-group {
            grid-template-columns: 1fr;
        }
    }

    .detail-content {
        overflow-y: auto;
        scrollbar-width: none;
        padding-right: 1rem;
    }

    .records-table,
    .query-list,
    .value-content {
        -ms-overflow-style: none;
        scrollbar-width: none;
    }
</style>
