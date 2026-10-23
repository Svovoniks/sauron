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
import type { MonacoThemeData } from "./themes";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

export const languageFor = (dbType: DbType): string => (dbType === "postgres" ? "pgsql" : "sql");

/** Registers (or re-registers) a theme from lib/themes.ts and makes it the active one for every editor. */
export function applyEditorTheme(theme: MonacoThemeData): string {
  monaco.editor.defineTheme(theme.name, {
    base: theme.base,
    inherit: true,
    rules: theme.rules.map((rule) => ({ token: rule.token, foreground: rule.foreground })),
    colors: theme.colors,
  });
  monaco.editor.setTheme(theme.name);
  return theme.name;
}

export default monaco;
