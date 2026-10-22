import { invoke } from "@tauri-apps/api/core";
import type { Connection, MetaResult, QueryResult } from "../../types/app";

/** Default / maximum number of rows fetched per query. Keep in sync with MAX_ROW_LIMIT in lib.rs. */
export const DEFAULT_ROW_LIMIT = 5_000;
export const MAX_ROW_LIMIT = 1_000_000;

/** Message produced by the backend when a query is stopped by the user. */
export const CANCELLED_MESSAGE = "Query was cancelled";

/** Tauri rejects with plain strings; make them real errors. */
const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export async function executeQuery(
  connection: Connection,
  statements: string[],
  rowLimit: number,
): Promise<QueryResult> {
  try {
    return await invoke<QueryResult>("execute_query", { connection, statements, rowLimit });
  } catch (error) {
    throw toError(error);
  }
}

/** Backslash commands (`\dt`, `\d table`, ...), implemented natively - no psql needed. */
export async function executeMetaCommand(connection: Connection, commandText: string): Promise<MetaResult> {
  try {
    return await invoke<MetaResult>("execute_meta_command", { connection, commandText });
  } catch (error) {
    throw toError(error);
  }
}

export async function cancelQuery(): Promise<void> {
  try {
    await invoke("cancel_query");
  } catch (error) {
    console.warn("Failed to cancel the query.", error);
  }
}

export const isMetaCommand = (query: string) => query.trimStart().startsWith("\\");
