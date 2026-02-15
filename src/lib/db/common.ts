import { setRecordsClick } from "./clickhouse";
import { setRecordsPG } from "./postgres";

type SetResults = (results: unknown[]) => void;
type OnError = (error: Error) => void;
type SetRecordsFn = (
    statements: string[],
    connection: any,
    setResults: SetResults,
    onError: OnError,
    signal: AbortSignal
) => void;

function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let currentStatement = "";
    let index = 0;

    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktickQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarQuoteTag: string | null = null;

    while (index < sql.length) {
        const char = sql[index];
        const nextChar = sql[index + 1];

        if (inLineComment) {
            currentStatement += char;
            if (char === "\n") {
                inLineComment = false;
            }
            index += 1;
            continue;
        }

        if (inBlockComment) {
            currentStatement += char;
            if (char === "*" && nextChar === "/") {
                currentStatement += nextChar;
                index += 2;
                inBlockComment = false;
                continue;
            }
            index += 1;
            continue;
        }

        if (dollarQuoteTag !== null) {
            if (sql.startsWith(dollarQuoteTag, index)) {
                currentStatement += dollarQuoteTag;
                index += dollarQuoteTag.length;
                dollarQuoteTag = null;
                continue;
            }

            currentStatement += char;
            index += 1;
            continue;
        }

        if (inSingleQuote) {
            currentStatement += char;
            if (char === "'" && nextChar === "'") {
                currentStatement += nextChar;
                index += 2;
                continue;
            }
            if (char === "'") {
                inSingleQuote = false;
            }
            index += 1;
            continue;
        }

        if (inDoubleQuote) {
            currentStatement += char;
            if (char === "\"" && nextChar === "\"") {
                currentStatement += nextChar;
                index += 2;
                continue;
            }
            if (char === "\"") {
                inDoubleQuote = false;
            }
            index += 1;
            continue;
        }

        if (inBacktickQuote) {
            currentStatement += char;
            if (char === "`") {
                inBacktickQuote = false;
            }
            index += 1;
            continue;
        }

        if (char === "-" && nextChar === "-") {
            currentStatement += char + nextChar;
            inLineComment = true;
            index += 2;
            continue;
        }

        if (char === "/" && nextChar === "*") {
            currentStatement += char + nextChar;
            inBlockComment = true;
            index += 2;
            continue;
        }

        if (char === "'") {
            currentStatement += char;
            inSingleQuote = true;
            index += 1;
            continue;
        }

        if (char === "\"") {
            currentStatement += char;
            inDoubleQuote = true;
            index += 1;
            continue;
        }

        if (char === "`") {
            currentStatement += char;
            inBacktickQuote = true;
            index += 1;
            continue;
        }

        if (char === "$") {
            const dollarMatch = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
            if (dollarMatch) {
                dollarQuoteTag = dollarMatch[0];
                currentStatement += dollarQuoteTag;
                index += dollarQuoteTag.length;
                continue;
            }
        }

        if (char === ";") {
            const trimmedStatement = currentStatement.trim();
            if (trimmedStatement.length > 0) {
                statements.push(trimmedStatement);
            }
            currentStatement = "";
            index += 1;
            continue;
        }

        currentStatement += char;
        index += 1;
    }

    const trailingStatement = currentStatement.trim();
    if (trailingStatement.length > 0) {
        statements.push(trailingStatement);
    }

    return statements;
}

export function setRecords(
    sql: string,
    connection: any,
    setResults: SetResults,
    onError: OnError,
    signal: AbortSignal
) {
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) {
        onError(new Error("No SQL statement to execute."));
        return;
    }

    const executeQuery = connection.db_type === "clickhouse" ? setRecordsClick : setRecordsPG;
    executeQuery(statements, connection, setResults, onError, signal);
}
