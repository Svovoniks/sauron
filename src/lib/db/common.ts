import { setRecordsClick } from "./clickhouse";
import { setRecordsPG } from "./postgres";

export function setRecords(
    sql: string,
    connection: any,
    setResults: (results: unknown[]) => void,
    onError: (error: Error) => void,
    signal: AbortSignal
) {
    if (connection.db_type === 'clickhouse') {
        setRecordsClick(sql, connection, setResults, onError, signal);
    } else {
        setRecordsPG(sql, connection, setResults, onError, signal);
    }
}
