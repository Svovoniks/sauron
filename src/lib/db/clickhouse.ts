import { createClient } from '@clickhouse/client-web'

type Data = { number: string }

export function setRecordsClick(sql: string, connection: any, setResults: (results: unknown[]) => void, onError: (error: Error) => void, signal: AbortSignal) {
    console.log('Executing query with connection click:', connection);
    console.log('SQL:', sql);

    let host = connection.host;
    if (!host.startsWith('http://') && !host.startsWith('https://')) {
        host = 'http://' + host;
    }

    host = host + ':' + connection.port

    const client = createClient({
        url: host,
        username: connection.username,
        password: connection.password,
        database: connection.database,
        request_timeout: 30000,
    })

    console.log('client:', client);


    client.query({
        query: sql,
        format: 'JSONEachRow',
        abort_signal: signal
    }).then(async (resultSet) => {
        const result = await resultSet.json<Data>()
        console.log('Query result:', result);
        setResults(result);
    }).catch((error) => {
        console.error('ClickHouse query error:', error);
        onError(error);
    });
}
