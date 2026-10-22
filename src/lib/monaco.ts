// Core editor + editor features + plain tokenizers (syntax highlighting) for SQL.
//
// Deliberately NOT the full `monaco-editor` entry point: that adds the command palette (F1),
// go-to-line, go-to-symbol, ... and the css/html/json/ts language services (several MB of
// workers that are never used for SQL). Deliberately not `monaco-sql-languages` either: its
// completion / diagnostics need per-language workers that were never wired up, and a grammar
// that does not match ClickHouse would underline valid queries.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all.js";
import "monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

import type { DbType } from "../types/app";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

export const languageFor = (dbType: DbType): string => (dbType === "postgres" ? "pgsql" : "sql");

export const SQL_DARK_THEME = "sql-dark";

// VS Code "Dark+" colours on top of the built-in dark theme.
monaco.editor.defineTheme(SQL_DARK_THEME, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6a9955" },
    { token: "keyword", foreground: "569cd6" },
    { token: "number", foreground: "b5cea8" },
    { token: "string", foreground: "ce9178" },
    { token: "predefined", foreground: "dcdcaa" },
    { token: "type", foreground: "4ec9b0" },
    { token: "identifier", foreground: "9cdcfe" },
    { token: "operator", foreground: "d4d4d4" },
  ],
  colors: {},
});

export default monaco;
