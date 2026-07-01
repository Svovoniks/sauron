import { invoke } from "@tauri-apps/api/core";
import type { Connection } from "../../types/app";

export interface PostgresMetaOutput {
  title: string;
  text: string;
}

export interface PsqlAvailability {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

export function checkPsqlAvailability(): Promise<PsqlAvailability> {
  return invoke<PsqlAvailability>("check_psql_availability");
}

export function executePostgresMetaCommand(
  input: string,
  connection: Connection,
  onOutput: (output: PostgresMetaOutput) => void,
  onError: (error: Error) => void,
  signal: AbortSignal,
) {
  if (connection.db_type !== "postgres") {
    onError(new Error("Meta command mode is only available for Postgres connections."));
    return;
  }

  const handleAbort = () => {
    void invoke("cancel_query");
  };
  signal.addEventListener("abort", handleAbort, { once: true });

  invoke<string>("execute_psql_meta_command", {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password ?? "",
    database: connection.database,
    commandText: input,
  })
    .then((text) => {
      onOutput({
        title: "Meta Command Output",
        text: text.trimEnd(),
      });
    })
    .catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
    })
    .finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
}
