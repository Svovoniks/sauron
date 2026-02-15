import { invoke } from "@tauri-apps/api/core";

function toUIRowEncoding(backend_res: any): any {
    const rows = [];
    for (const row of backend_res) {
        const row_obj: any = {};
        for (const col of row) {
            const col_name = col[0];
            const col_type = col[1];
            let col_value = col[2];

            if (col_value === "<<null>>") {
                col_value = null;
            } else {
                switch (col_type) {
                    case 'bool':
                        col_value = col_value === 'true';
                        break;
                    case 'number':
                        col_value = parseFloat(col_value);
                        break;
                    case 'array':
                        try {
                            col_value = JSON.parse(col_value);
                        } catch (e) {
                            // ignore
                        }
                        break;
                }
            }

            row_obj[col_name] = col_value;
        }
        rows.push(row_obj);
    }
    return rows;
}

export function setRecordsPG(
    statements: string[],
    connection: any,
    setResults: (results: unknown[]) => void,
    onError: (error: Error) => void,
    signal: AbortSignal
) {
    const connectionString = `postgres://${connection.username}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}/${connection.database}`;
    const handleAbort = () => {
        void invoke("cancel_query");
    };
    signal.addEventListener("abort", handleAbort, { once: true });

    invoke("execute_query_batch", { connectionString, statements })
        .then((resultSet: any) => {
            setResults(toUIRowEncoding(JSON.parse(resultSet)));
        })
        .catch((error: unknown) => {
            console.error('Tauri query error:', error);
            onError(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
            signal.removeEventListener("abort", handleAbort);
        });
}
