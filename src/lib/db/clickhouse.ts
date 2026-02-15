import { createClient } from '@clickhouse/client-web'

type Data = { number: string }

export function setRecordsClick(statements: string[], connection: any, setResults: (results: unknown[]) => void, onError: (error: Error) => void, signal: AbortSignal) {
    let host = connection.host;
    if (!host.startsWith('http://') && !host.startsWith('https://')) {
        host = 'http://' + host;
    }

    host = host + ':' + connection.port

    try {
        const client = createClient({
            url: host,
            username: connection.username,
            password: connection.password,
            database: connection.database,
            request_timeout: 30000,
            session_id: crypto.randomUUID(),
        })

        void (async () => {
            for (let index = 0; index < statements.length; index += 1) {
                const statement = statements[index];
                const isLastStatement = index === statements.length - 1;

                if (signal.aborted) {
                    const abortedError = new Error("Query was aborted.");
                    abortedError.name = "AbortError";
                    throw abortedError;
                }

                if (!isLastStatement) {
                    await client.command({
                        query: statement,
                        abort_signal: signal,
                    });
                    continue;
                }

                const resultSet = await client.query({
                    query: statement,
                    format: 'JSONEachRow',
                    abort_signal: signal,
                });

                const result = await resultSet.json<Data>();
                setResults(result);
            }
        })().catch((error: unknown) => {
            console.error('ClickHouse query error:', error);
            onError(error instanceof Error ? error : new Error(String(error)));
        }).finally(() => {
            void client.close();
        });
    } catch (err: unknown) {
        onError(err instanceof Error ? err : new Error(String(err)))
    }
}
