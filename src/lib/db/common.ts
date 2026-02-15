import { setRecordsClick } from "./clickhouse";
import { setRecordsPG } from "./postgres";
import { MySQL, PostgreSQL, TrinoSQL } from "dt-sql-parser";

type SetResults = (results: unknown[]) => void;
type OnError = (error: Error) => void;
type SetRecordsFn = (
    statements: string[],
    connection: any,
    setResults: SetResults,
    onError: OnError,
    signal: AbortSignal
) => void;

const postgresSqlParser = new PostgreSQL();
const trinoSqlParser = new TrinoSQL();
const mySqlParser = new MySQL();

type LexerToken = {
    text?: string | null;
    start?: number | null;
    stop?: number | null;
};

type SqlParserWithLexer = {
    createLexer: (input: string) => {
        getAllTokens: () => LexerToken[];
    };
};

function normalizeParsedStatement(statementText: string): string {
    return statementText.replace(/;\s*$/, "").trim();
}

function getParsersForDbType(dbType: string): SqlParserWithLexer[] {
    if (dbType === "postgres") {
        return [postgresSqlParser, trinoSqlParser, mySqlParser];
    }

    if (dbType === "clickhouse") {
        return [trinoSqlParser, mySqlParser, postgresSqlParser];
    }

    return [postgresSqlParser, trinoSqlParser, mySqlParser];
}

function splitSqlStatementsByLexer(sql: string, parser: SqlParserWithLexer): string[] | null {
    let tokens: LexerToken[];
    try {
        tokens = parser.createLexer(sql).getAllTokens();
    } catch {
        return null;
    }

    const statements: string[] = [];
    let statementStart = 0;

    for (const token of tokens) {
        if (token.text !== ";") {
            continue;
        }

        const tokenStart = typeof token.start === "number" ? token.start : statementStart;
        const tokenStop = typeof token.stop === "number" ? token.stop + 1 : tokenStart + 1;
        const statement = normalizeParsedStatement(sql.slice(statementStart, tokenStop));
        if (statement.length > 0) {
            statements.push(statement);
        }
        statementStart = tokenStop;
    }

    const trailingStatement = normalizeParsedStatement(sql.slice(statementStart));
    if (trailingStatement.length > 0) {
        statements.push(trailingStatement);
    }

    return statements.length > 0 ? statements : null;
}

function splitSqlStatements(sql: string, dbType: string): string[] {
    const parsers = getParsersForDbType(dbType);

    for (const parser of parsers) {
        const statements = splitSqlStatementsByLexer(sql, parser);
        if (statements) {
            return statements;
        }
    }

    const singleStatement = normalizeParsedStatement(sql);
    return singleStatement.length > 0 ? [singleStatement] : [];
}

export function setRecords(
    sql: string,
    connection: any,
    setResults: SetResults,
    onError: OnError,
    signal: AbortSignal
) {
    const statements = splitSqlStatements(sql, connection.db_type);
    if (statements.length === 0) {
        onError(new Error("No SQL statement to execute."));
        return;
    }

    const executeQuery = connection.db_type === "clickhouse" ? setRecordsClick : setRecordsPG;
    executeQuery(statements, connection, setResults, onError, signal);
}
