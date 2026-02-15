import type { Connection } from "../../types/app";
import { setRecordsPG } from "./postgres";

type RowRecord = Record<string, unknown>;

interface SlashCommand {
  command: string;
  argument: string;
  expanded: boolean;
}

interface MetaTable {
  title: string;
  headers: string[];
  rows: string[][];
}

interface MetaPlan {
  sql: string;
  toTable: (rows: RowRecord[]) => MetaTable;
}

export interface PostgresMetaOutput {
  title: string;
  text: string;
}

const SUPPORTED_COMMANDS = ["\\d", "\\dt", "\\dt+", "\\dv", "\\dm", "\\ds", "\\di", "\\di+", "\\dn", "\\df"];

function toCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function centerText(value: string, totalWidth: number): string {
  if (value.length >= totalWidth) {
    return value;
  }

  const totalPadding = totalWidth - value.length;
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return `${" ".repeat(leftPadding)}${value}${" ".repeat(rightPadding)}`;
}

function formatPsqlTable(title: string, headers: string[], rows: string[][]): string {
  if (headers.length === 0) {
    return `(0 rows)`;
  }

  const widths = headers.map((header, index) => {
    const maxRowWidth = rows.reduce((maxWidth, row) => Math.max(maxWidth, row[index]?.length ?? 0), 0);
    return Math.max(header.length, maxRowWidth);
  });

  const renderLine = (columns: string[]) =>
    columns
      .map((column, index) => ` ${column.padEnd(widths[index], " ")} `)
      .join("|");
  const separator = widths.map((width) => "-".repeat(width + 2)).join("+");

  const lines: string[] = [];
  const headerLine = renderLine(headers);
  if (title) {
    lines.push(centerText(title, headerLine.length));
  }

  lines.push(headerLine);
  lines.push(separator);
  for (const row of rows) {
    lines.push(renderLine(row));
  }
  lines.push(`(${rows.length} ${rows.length === 1 ? "row" : "rows"})`);

  return lines.join("\n");
}

function normalizeRows(rows: unknown[]): RowRecord[] {
  return rows.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return row as RowRecord;
    }

    return { value: row };
  });
}

function normalizePattern(rawPattern: string): string {
  const trimmed = rawPattern.trim();
  if (!trimmed) {
    return "";
  }

  const wildcardPattern = trimmed.replace(/\*/g, "%");
  if (wildcardPattern.includes("%") || wildcardPattern.includes("_")) {
    return wildcardPattern;
  }

  return `%${wildcardPattern}%`;
}

function buildNamePatternFilter(rawPattern: string, nameExpression: string, qualifiedExpression: string): string {
  const pattern = normalizePattern(rawPattern);
  if (!pattern) {
    return "";
  }

  const escapedPattern = escapeSqlLiteral(pattern);
  return `AND (${nameExpression} ILIKE ${escapedPattern} OR ${qualifiedExpression} ILIKE ${escapedPattern})`;
}

function buildSinglePatternFilter(rawPattern: string, expression: string): string {
  const pattern = normalizePattern(rawPattern);
  if (!pattern) {
    return "";
  }

  return `AND ${expression} ILIKE ${escapeSqlLiteral(pattern)}`;
}

function buildRelationListSql(relKinds: string[], pattern: string): string {
  const kinds = relKinds.map((kind) => escapeSqlLiteral(kind)).join(", ");
  const patternFilter = buildNamePatternFilter(pattern, "c.relname", "n.nspname || '.' || c.relname");

  return `
SELECT
  n.nspname AS "Schema",
  c.relname AS "Name",
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
    WHEN 'S' THEN 'sequence'
    WHEN 'i' THEN 'index'
    WHEN 'f' THEN 'foreign table'
    ELSE c.relkind::text
  END AS "Type",
  pg_catalog.pg_get_userbyid(c.relowner) AS "Owner"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN (${kinds})
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  ${patternFilter}
ORDER BY 1, 2;
`.trim();
}

function buildTableListSql(pattern: string, expanded: boolean): string {
  const patternFilter = buildNamePatternFilter(pattern, "c.relname", "n.nspname || '.' || c.relname");

  if (!expanded) {
    return buildRelationListSql(["r", "p"], pattern);
  }

  return `
SELECT
  n.nspname AS "Schema",
  c.relname AS "Name",
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    ELSE c.relkind::text
  END AS "Type",
  pg_catalog.pg_get_userbyid(c.relowner) AS "Owner",
  CASE c.relpersistence
    WHEN 'u' THEN 'unlogged'
    WHEN 't' THEN 'temporary'
    ELSE 'permanent'
  END AS "Persistence",
  COALESCE(am.amname, '') AS "Access method",
  pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.oid)) AS "Size",
  COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS "Description"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  ${patternFilter}
ORDER BY 1, 2;
`.trim();
}

function buildIndexListSql(pattern: string, expanded: boolean): string {
  const patternFilter = buildNamePatternFilter(pattern, "c.relname", "n.nspname || '.' || c.relname");

  if (!expanded) {
    return `
SELECT
  n.nspname AS "Schema",
  c.relname AS "Name",
  CASE c.relkind
    WHEN 'I' THEN 'partitioned index'
    ELSE 'index'
  END AS "Type",
  pg_catalog.pg_get_userbyid(c.relowner) AS "Owner",
  COALESCE(tbl.relname, '') AS "Table"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_index idx ON idx.indexrelid = c.oid
LEFT JOIN pg_catalog.pg_class tbl ON tbl.oid = idx.indrelid
WHERE c.relkind IN ('i', 'I')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  ${patternFilter}
ORDER BY 1, 2;
`.trim();
  }

  return `
SELECT
  n.nspname AS "Schema",
  c.relname AS "Name",
  CASE c.relkind
    WHEN 'I' THEN 'partitioned index'
    ELSE 'index'
  END AS "Type",
  pg_catalog.pg_get_userbyid(c.relowner) AS "Owner",
  COALESCE(tbl.relname, '') AS "Table",
  pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.oid)) AS "Size",
  COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS "Description"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_index idx ON idx.indexrelid = c.oid
LEFT JOIN pg_catalog.pg_class tbl ON tbl.oid = idx.indrelid
WHERE c.relkind IN ('i', 'I')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  ${patternFilter}
ORDER BY 1, 2;
`.trim();
}

function buildSchemaListSql(pattern: string): string {
  const patternFilter = buildSinglePatternFilter(pattern, "n.nspname");

  return `
SELECT
  n.nspname AS "Name",
  pg_catalog.pg_get_userbyid(n.nspowner) AS "Owner"
FROM pg_catalog.pg_namespace n
WHERE n.nspname !~ '^pg_'
  AND n.nspname <> 'information_schema'
  ${patternFilter}
ORDER BY 1;
`.trim();
}

function buildFunctionListSql(pattern: string): string {
  const patternFilter = buildNamePatternFilter(pattern, "p.proname", "n.nspname || '.' || p.proname");

  return `
SELECT
  n.nspname AS "Schema",
  p.proname AS "Name",
  pg_catalog.pg_get_function_result(p.oid) AS "Result data type",
  pg_catalog.pg_get_function_arguments(p.oid) AS "Argument data types",
  CASE p.prokind
    WHEN 'a' THEN 'agg'
    WHEN 'w' THEN 'window'
    WHEN 'p' THEN 'proc'
    ELSE 'func'
  END AS "Type"
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  ${patternFilter}
ORDER BY 1, 2, 4;
`.trim();
}

function buildDescribeRelationSql(rawRelationName: string): string {
  const relationName = rawRelationName.trim();
  const fallbackRelation =
    relationName.includes(".") || relationName.includes('"')
      ? "NULL::regclass"
      : `to_regclass(${escapeSqlLiteral(`public.${relationName}`)})`;

  return `
WITH target AS (
  SELECT COALESCE(to_regclass(${escapeSqlLiteral(relationName)}), ${fallbackRelation})::oid AS oid
)
SELECT
  a.attname AS "Column",
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS "Type",
  CASE
    WHEN a.attcollation = t.typcollation THEN NULL
    ELSE c_coll.collname
  END AS "Collation",
  CASE WHEN a.attnotnull THEN 'not null' ELSE '' END AS "Nullable",
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "Default",
  COALESCE((
    SELECT string_agg(
      format('"%s" %s', ic.relname, pg_get_indexdef(i.indexrelid)),
      E'\n'
      ORDER BY i.indisprimary DESC, i.indisunique DESC, ic.relname
    )
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = c.oid
  ), '') AS "_indexes",
  n.nspname AS "_schema",
  c.relname AS "_name",
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
    WHEN 'S' THEN 'sequence'
    WHEN 'i' THEN 'index'
    WHEN 'f' THEN 'foreign table'
    ELSE 'relation'
  END AS "_kind"
FROM target
JOIN pg_catalog.pg_class c ON c.oid = target.oid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_collation c_coll ON c_coll.oid = a.attcollation
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE target.oid IS NOT NULL
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum;
`.trim();
}

function tableFromHeaders(title: string, headers: string[]): (rows: RowRecord[]) => MetaTable {
  return (rows: RowRecord[]) => ({
    title,
    headers,
    rows: rows.map((row) => headers.map((header) => toCellValue(row[header]))),
  });
}

function parseCommand(input: string): SlashCommand {
  const nonEmptyLines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length === 0) {
    throw new Error("No command to execute.");
  }

  if (nonEmptyLines.length > 1) {
    throw new Error("Meta mode executes one command at a time.");
  }

  const line = nonEmptyLines[0];
  if (!line.startsWith("\\")) {
    throw new Error("Meta mode expects commands like \\dt or \\d users.");
  }

  const commandMatch = line.match(/^\\(\S+)(?:\s+(.+))?$/);
  if (!commandMatch) {
    throw new Error("Invalid meta command.");
  }

  const expanded = commandMatch[1].endsWith("+");
  const baseCommand = expanded ? commandMatch[1].slice(0, -1) : commandMatch[1];
  const argument = (commandMatch[2] ?? "").trim().replace(/;$/, "").trim();
  return {
    command: `\\${baseCommand}`,
    argument,
    expanded,
  };
}

function buildMetaPlan(command: SlashCommand): MetaPlan {
  switch (command.command) {
    case "\\d":
      if (!command.argument) {
        return {
          sql: buildRelationListSql(["r", "p", "v", "m", "S", "f"], ""),
          toTable: tableFromHeaders("List of relations", ["Schema", "Name", "Type", "Owner"]),
        };
      }

      if (command.argument.includes("*") || command.argument.includes("%")) {
        throw new Error("Wildcards are not supported for \\d <relation>. Use \\dt <pattern> or \\dv <pattern>.");
      }

      return {
        sql: buildDescribeRelationSql(command.argument),
        toTable: (rows: RowRecord[]) => {
          if (rows.length === 0) {
            throw new Error(`Did not find any relation named "${command.argument}".`);
          }

          const schema = toCellValue(rows[0]._schema);
          const relationName = toCellValue(rows[0]._name);
          const relationKind = toCellValue(rows[0]._kind);
          const title = `${relationKind.charAt(0).toUpperCase()}${relationKind.slice(1)} "${schema}.${relationName}"`;
          const headers = ["Column", "Type", "Collation", "Nullable", "Default"];
          const indexesRaw = toCellValue(rows[0]._indexes).trim();
          const baseTable = formatPsqlTable(
            title,
            headers,
            rows.map((row) => headers.map((header) => toCellValue(row[header]))),
          );
          if (!indexesRaw) {
            return {
              title: "",
              headers: [],
              rows: [[baseTable]],
            };
          }

          return {
            title: "",
            headers: [],
            rows: [[`${baseTable}\n\nIndexes:\n${indexesRaw.split("\n").map((line) => `    ${line}`).join("\n")}`]],
          };
        },
      };
    case "\\dt":
      return {
        sql: buildTableListSql(command.argument, command.expanded),
        toTable: tableFromHeaders(
          "List of relations",
          command.expanded
            ? ["Schema", "Name", "Type", "Owner", "Persistence", "Access method", "Size", "Description"]
            : ["Schema", "Name", "Type", "Owner"],
        ),
      };
    case "\\dv":
      return {
        sql: buildRelationListSql(["v"], command.argument),
        toTable: tableFromHeaders("List of relations", ["Schema", "Name", "Type", "Owner"]),
      };
    case "\\dm":
      return {
        sql: buildRelationListSql(["m"], command.argument),
        toTable: tableFromHeaders("List of relations", ["Schema", "Name", "Type", "Owner"]),
      };
    case "\\ds":
      return {
        sql: buildRelationListSql(["S"], command.argument),
        toTable: tableFromHeaders("List of relations", ["Schema", "Name", "Type", "Owner"]),
      };
    case "\\di":
      return {
        sql: buildIndexListSql(command.argument, command.expanded),
        toTable: tableFromHeaders(
          "List of indexes",
          command.expanded
            ? ["Schema", "Name", "Type", "Owner", "Table", "Size", "Description"]
            : ["Schema", "Name", "Type", "Owner", "Table"],
        ),
      };
    case "\\dn":
      return {
        sql: buildSchemaListSql(command.argument),
        toTable: tableFromHeaders("List of schemas", ["Name", "Owner"]),
      };
    case "\\df":
      return {
        sql: buildFunctionListSql(command.argument),
        toTable: tableFromHeaders("List of functions", ["Schema", "Name", "Result data type", "Argument data types", "Type"]),
      };
    default:
      throw new Error(`Unsupported command "${command.command}". Supported: ${SUPPORTED_COMMANDS.join(", ")}`);
  }
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

  let plan: MetaPlan;
  try {
    const parsedCommand = parseCommand(input);
    plan = buildMetaPlan(parsedCommand);
  } catch (error: unknown) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  setRecordsPG(
    [plan.sql],
    connection,
    (rawRows: unknown[]) => {
      try {
        const rows = normalizeRows(rawRows);
        const table = plan.toTable(rows);
        const isPreformattedBlock =
          table.title === "" &&
          table.headers.length === 0 &&
          table.rows.length === 1 &&
          table.rows[0].length === 1;
        onOutput({
          title: "Meta Command Output",
          text: isPreformattedBlock ? table.rows[0][0] : formatPsqlTable(table.title, table.headers, table.rows),
        });
      } catch (error: unknown) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError,
    signal,
  );
}
