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
    sql: string,
    connection: any,
    setResults: (results: unknown[]) => void,
    onError: (error: Error) => void,
    signal: AbortSignal
) {
    console.log('Executing query with connection pg:', connection);
    console.log('SQL:', sql);

    const connectionString = `postgres://${connection.username}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}/${connection.database}`;
    signal.addEventListener('abort', () => {
        invoke("cancel_query")
    })

    invoke("execute_query", { connectionString, query: sql })
        .then((resultSet: any) => {
            setResults(toUIRowEncoding(JSON.parse(resultSet)));
        })
        .catch((error) => {
            console.error('Tauri query error:', error);
            onError(Error(error));
        });
}
