import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { formatCount, parseAliases, qualifiedName, quoteIdent, type Schema } from "./schema";
import { splitSqlRanges } from "./sql/splitStatements";

/** Table and column completion for the SQL editor, driven by the loaded schema. */

export interface CompletionSource {
  schema: Schema | null;
  enabled: boolean;
  /** Default schema (public / the connection's database): names in it are not qualified. */
  defaultSchema: string;
}

type Monaco_ = typeof Monaco;

export function registerSchemaCompletion(monaco: Monaco_, languages: string[], getSource: () => CompletionSource): Monaco.IDisposable[] {
  return languages.map((language) =>
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ["."],
      provideCompletionItems(model, position) {
        const { schema, enabled, defaultSchema } = getSource();
        if (!enabled || !schema) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range: Monaco.IRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const line = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
        const kinds = monaco.languages.CompletionItemKind;

        // The statement being edited, to find the aliases it declares.
        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        const ranges = splitSqlRanges(text, schema.dbType);
        const current = ranges.find((r) => offset >= r.start && offset <= r.end + 1)?.text ?? text;
        const aliases = parseAliases(current);

        const tableByName = (name: string) => {
          const lower = name.toLowerCase();
          return schema.tables.find((t) => t.name.toLowerCase() === lower && t.schema === defaultSchema) ?? schema.tables.find((t) => t.name.toLowerCase() === lower);
        };

        const dotted = /([A-Za-z_][\w$]*)\.$/.exec(line);
        if (dotted) {
          const qualifier = dotted[1];
          const tableName = aliases.get(qualifier.toLowerCase()) ?? qualifier;
          const table = tableByName(tableName);
          if (table) {
            return {
              suggestions: table.columns.map((column, index) => ({
                label: column.name,
                kind: kinds.Field,
                insertText: quoteIdent(column.name, schema.dbType),
                detail: `${column.type}${column.nullable ? "" : " · not null"}${column.key === "pk" ? " · primary key" : column.key === "fk" ? " · foreign key" : ""}`,
                documentation: `${table.name}.${column.name}`,
                sortText: String(index).padStart(4, "0"),
                range,
              })),
            };
          }
          // `billing.` -> tables of that schema
          const inSchema = schema.tables.filter((t) => t.schema.toLowerCase() === qualifier.toLowerCase());
          if (inSchema.length > 0) {
            return { suggestions: inSchema.map((t) => ({ label: t.name, kind: kinds.Struct, insertText: quoteIdent(t.name, schema.dbType), detail: t.kind, range })) };
          }
          return { suggestions: [] };
        }

        const suggestions: Monaco.languages.CompletionItem[] = [];
        // Schema (or database) names: `bucket_1` then `.` lists its tables.
        const counts = new Map<string, number>();
        for (const table of schema.tables) counts.set(table.schema, (counts.get(table.schema) ?? 0) + 1);
        for (const [name, count] of counts) {
          suggestions.push({
            label: name,
            kind: kinds.Module,
            insertText: quoteIdent(name, schema.dbType),
            detail: `${schema.dbType === "postgres" ? "schema" : "database"} · ${count} object${count === 1 ? "" : "s"}`,
            sortText: "0" + name,
            range,
          });
        }
        for (const table of schema.tables) {
          suggestions.push({
            label: table.name,
            kind: table.kind === "table" ? kinds.Struct : kinds.Interface,
            insertText: qualifiedName(table, schema.dbType, defaultSchema),
            detail: `${table.schema === defaultSchema ? "" : `${table.schema} · `}${table.kind}${table.rows !== null ? ` · ~${formatCount(table.rows)} rows` : ""}`,
            sortText: "1" + table.name,
            range,
          });
        }
        // Columns of the tables this statement already mentions.
        const seen = new Set<string>();
        for (const tableName of new Set(aliases.values())) {
          const table = tableByName(tableName);
          if (!table) continue;
          for (const column of table.columns) {
            if (seen.has(column.name)) continue;
            seen.add(column.name);
            suggestions.push({ label: column.name, kind: kinds.Field, insertText: quoteIdent(column.name, schema.dbType), detail: `${table.name} · ${column.type}`, sortText: "0" + column.name, range });
          }
        }
        return { suggestions };
      },
    }),
  );
}
