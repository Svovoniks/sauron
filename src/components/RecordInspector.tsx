import { useMemo, useState, type ReactNode } from "react";
import { parsePgArray } from "../lib/pgArray";
import { embeddedJson, parseTimestamp, rowToInsert, rowToObject, typedValue } from "../lib/record";
import { relativeTime } from "../lib/sql/analyze";
import type { Cell, ColumnMeta } from "../types/app";
import { cellText, detailValue } from "../utils/format";
import { JsonView } from "./JsonTree";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, CopyIcon, FilterIcon, SearchIcon } from "./icons";

type Mode = "fields" | "json";

interface RecordInspectorProps {
  columns: ColumnMeta[];
  rows: Cell[][];
  selectedIndex: number;
  /** Text typed in the results search box; fields that do not match are hidden. */
  searchTerm: string;
  prefs: { prettyJson: boolean; nullText: string };
  /** Table the rows came from, for "Copy as INSERT". */
  tableName: string | null;
  dialect: "postgres" | "clickhouse";
  onStep: (delta: number) => void;
  onClose: () => void;
  onCopy: (text: string, label: string) => void;
  /** "Show rows with this value": closes the record and searches the table for it. */
  onFilterValue: (text: string) => void;
}

const highlight = (text: string, term: string): ReactNode => {
  if (!term) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, from)) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark className="search-match-highlight" key={at}>
        {text.slice(at, at + term.length)}
      </mark>,
    );
    from = at + term.length;
  }
  if (from === 0) return text;
  if (from < text.length) out.push(text.slice(from));
  return out;
};

function FieldValue({ column, cell, prefs, term }: { column: ColumnMeta; cell: Cell; prefs: RecordInspectorProps["prefs"]; term: string }): ReactNode {
  if (cell === null) return <span className="v-null">{prefs.nullText}</span>;

  if (column.type === "json" && prefs.prettyJson) {
    const value = typedValue(column, cell);
    if (typeof value === "object" && value !== null) {
      return (
        <JsonView term={term} value={value} />
      );
    }
  }
  if (column.type === "string" && prefs.prettyJson) {
    const embedded = embeddedJson(cell);
    if (embedded) {
      return (
        <JsonView term={term} value={embedded} />
      );
    }
  }
  if (column.type === "array") {
    const items = parsePgArray(cell);
    if (items && prefs.prettyJson && items.every((item) => typeof item === "string" || typeof item === "number")) {
      return items.length > 0 ? (
        <>
          {items.map((item, i) => (
            <span className="tag" key={i}>
              {highlight(String(item), term)}
            </span>
          ))}
        </>
      ) : (
        <span className="muted">empty array</span>
      );
    }
  }
  const detail = detailValue(column.type, cell, { prettyJson: prefs.prettyJson, nullText: prefs.nullText });
  const stamp = column.type.startsWith("timestamp") ? parseTimestamp(cell) : null;
  return (
    <>
      <span className={`v-${detail.kind}`}>{highlight(detail.text, term)}</span>
      {stamp !== null ? <span className="rel">{relativeTime(stamp)}</span> : null}
    </>
  );
}

export function RecordInspector(props: RecordInspectorProps) {
  const { columns, rows, selectedIndex, searchTerm, prefs } = props;
  const row = rows[selectedIndex] ?? [];
  const [mode, setMode] = useState<Mode>("fields");
  const [fieldFilter, setFieldFilter] = useState("");
  const [hideNulls, setHideNulls] = useState(false);

  const filter = fieldFilter.trim().toLowerCase();

  const visibleFields = useMemo(
    () =>
      columns
        .map((column, index) => ({ column, index, cell: row[index] ?? null }))
        .filter(({ column, cell }) => {
          if (hideNulls && cell === null) return false;
          const text = cellText(cell, prefs.nullText).toLowerCase();
          if (filter && !column.name.toLowerCase().includes(filter) && !text.includes(filter)) return false;
          if (searchTerm && !column.name.toLowerCase().includes(searchTerm) && !text.includes(searchTerm)) return false;
          return true;
        }),
    [columns, row, hideNulls, filter, searchTerm, prefs.nullText],
  );

  const json = useMemo(() => JSON.stringify(rowToObject(columns, row), null, 2), [columns, row]);

  return (
    <div className="inspector">
      <div className="ri-head">
        <b>Record</b>
        <button aria-label="Previous record" className="ri-icon" onClick={() => props.onStep(-1)} title="Previous (k)" type="button">
          <ChevronLeftIcon size={15} />
        </button>
        <span className="muted">
          {selectedIndex + 1} of {rows.length.toLocaleString("en-US")}
        </span>
        <button aria-label="Next record" className="ri-icon" onClick={() => props.onStep(1)} title="Next (j)" type="button">
          <ChevronRightIcon size={15} />
        </button>
        <span className="sp" />
        <button aria-label="Close details" className="ri-icon close" onClick={props.onClose} title="Close (Esc)" type="button">
          <CloseIcon />
        </button>
      </div>

      <div className="ri-tools">
        <div className="seg" role="group" aria-label="Record view">
          <button className={mode === "fields" ? "active" : ""} onClick={() => setMode("fields")} type="button">
            Fields
          </button>
          <button className={mode === "json" ? "active" : ""} onClick={() => setMode("json")} type="button">
            JSON
          </button>
        </div>
      </div>
      {mode === "fields" ? (
        <div className="ri-tools">
          <label className="panel-search">
            <SearchIcon />
            <input aria-label="Filter fields" onChange={(event) => setFieldFilter(event.target.value)} placeholder="Filter fields or values" spellCheck={false} value={fieldFilter} />
          </label>
          <label className="ri-check">
            <input checked={hideNulls} onChange={(event) => setHideNulls(event.target.checked)} type="checkbox" />
            Hide nulls
          </label>
        </div>
      ) : null}

      <div className="ri-body">
        {mode === "fields" ? (
          visibleFields.length > 0 ? (
            visibleFields.map(({ column, index, cell }) => {
              const detail = detailValue(column.type, cell, { prettyJson: prefs.prettyJson, nullText: prefs.nullText });
              return (
                <div className="fld" key={index}>
                  <div className="fk">
                    {highlight(column.name, searchTerm || filter)}
                    <small>{column.type === "string" && cell !== null && prefs.prettyJson && embeddedJson(cell) ? "json in text" : detail.label === "null" ? column.type : detail.label}</small>
                  </div>
                  <div className="fv">
                    <FieldValue cell={cell} column={column} prefs={prefs} term={searchTerm || filter} />
                  </div>
                  <div className="acts">
                    <button aria-label={`Copy ${column.name}`} onClick={() => props.onCopy(detail.copyText, column.name)} title="Copy value" type="button">
                      <CopyIcon />
                    </button>
                    {cell !== null && cell.length < 200 ? (
                      <button aria-label={`Show rows with this ${column.name}`} onClick={() => props.onFilterValue(cell)} title="Show rows with this value" type="button">
                        <FilterIcon size={13} />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="detail-placeholder">
              <p>No matching fields in this record</p>
            </div>
          )
        ) : null}

        {mode === "json" ? <pre className="raw">{highlight(json, searchTerm)}</pre> : null}
      </div>

      <div className="ri-foot">
        <button className="btn" onClick={() => props.onCopy(json, "row as JSON")} type="button">
          <CopyIcon />
          Copy as JSON
        </button>
        <button className="btn" onClick={() => props.onCopy(rowToInsert(props.tableName ?? "table_name", columns, row, props.dialect), "INSERT statement")} title={props.tableName ? undefined : "Replace table_name with your table"} type="button">
          <CopyIcon />
          Copy as INSERT
        </button>
      </div>
    </div>
  );
}
