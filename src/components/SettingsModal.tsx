import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ACCENTS,
  comboFromEvent,
  comboLabels,
  DEFAULT_SETTINGS,
  EDITOR_FONTS,
  ROW_LIMIT_OPTIONS,
  type AccentName,
  type Settings,
  type ShortcutId,
} from "../lib/settings";
import { hasAppearance, paletteOf, THEMES, themeById, type Appearance } from "../lib/themes";
import { Modal } from "./Modal";
import { CloseIcon, SearchIcon, WarningIcon } from "./icons";

export type SettingsSection = "general" | "editor" | "results" | "connections" | "psql" | "agents" | "shortcuts" | "data" | "about";

interface Option {
  value: string;
  label: string;
}

type Control =
  | { type: "seg"; key: keyof Settings; options: Option[] }
  | { type: "swatch" }
  | { type: "themes" }
  | { type: "switch"; key: keyof Settings }
  | { type: "select"; key: keyof Settings; options: Option[]; numeric?: boolean; suffix?: string }
  | { type: "text"; key: keyof Settings; placeholder?: string; wide?: boolean }
  | { type: "keys"; id: ShortcutId }
  | { type: "button"; text: string; action: "export" | "import" | "clearHistory" | "copyFolder" | "checkUpdate" | "copyMcpClaude" | "copyMcpCodex" | "copyMcpJson"; danger?: boolean }
  | { type: "value"; text: string };

export interface Row {
  id: string;
  label: string;
  desc: string;
  control: Control;
}

export interface Section {
  id: SettingsSection;
  title: string;
  sub: string;
  rows: Row[];
  callout?: string;
}

/** How an agent starts Sauron's MCP server: the app's own executable with `--mcp`. */
export function mcpSetup(executable: string): { claude: string; codex: string; json: string } {
  const quoted = `"${executable.replace(/(["\\$`])/g, "\\$1")}"`;
  return {
    claude: `claude mcp add sauron -- ${quoted} --mcp`,
    codex: `codex mcp add sauron -- ${quoted} --mcp`,
    json: JSON.stringify({ mcpServers: { sauron: { command: executable, args: ["--mcp"] } } }, null, 2),
  };
}

const opts = (...values: string[]): Option[] => values.map((value) => ({ value, label: value }));
const numOpts = (values: number[]): Option[] => values.map((v) => ({ value: String(v), label: v.toLocaleString("en-US") }));

export const settingsSections = (version: string): Section[] => [
  {
    id: "general",
    title: "General",
    sub: "Look and feel of the whole app.",
    rows: [
      { id: "theme", label: "Theme", desc: "Colors and shape of the whole app. Applies immediately.", control: { type: "themes" } },
      {
        id: "appearance",
        label: "Appearance",
        desc: "Dark or light, or follow the system. Midnight is dark only.",
        control: { type: "seg", key: "appearance", options: [{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }] },
      },
      { id: "accent", label: "Accent color", desc: "Buttons, selection and focus rings. “Theme” uses the theme’s own accent.", control: { type: "swatch" } },
      {
        id: "loadingAnimation",
        label: "Loading animation",
        desc: "What plays while a query runs: the turning eye from the logo, or the eye on its tower.",
        control: { type: "seg", key: "loadingAnimation", options: [{ value: "eye", label: "Eye" }, { value: "tower", label: "Tower" }] },
      },
      {
        id: "autoUpdate",
        label: "Check for updates automatically",
        desc: "Once at launch, from GitHub releases. You are asked before anything is downloaded.",
        control: { type: "switch", key: "autoUpdate" },
      },
      {
        id: "restoreSession",
        label: "Restore last session",
        desc: "Reopen your query tabs and editor text on launch.",
        control: { type: "switch", key: "restoreSession" },
      },
    ],
  },
  {
    id: "editor",
    title: "Editor",
    sub: "The SQL editor at the bottom of the window.",
    rows: [
      { id: "editorFontSize", label: "Font size", desc: "Size of the editor text.", control: { type: "select", key: "editorFontSize", numeric: true, suffix: "px", options: numOpts([12, 13, 14, 15, 16, 18, 20]) } },
      { id: "editorFont", label: "Font", desc: "Any monospace font installed on this computer.", control: { type: "select", key: "editorFont", options: opts(...EDITOR_FONTS) } },
      {
        id: "execScope",
        label: "Execute runs",
        desc: "What Execute sends when nothing is selected. A selection is always run on its own.",
        control: { type: "seg", key: "execScope", options: [{ value: "script", label: "Whole script" }, { value: "statement", label: "Statement at cursor" }] },
      },
      { id: "autocomplete", label: "Autocomplete tables and columns", desc: "Uses the schema of the active connection once it is loaded.", control: { type: "switch", key: "autocomplete" } },
      { id: "wordWrap", label: "Word wrap", desc: "Wrap long lines instead of scrolling sideways.", control: { type: "switch", key: "wordWrap" } },
      { id: "lineNumbers", label: "Line numbers", desc: "Show line numbers in the gutter.", control: { type: "switch", key: "lineNumbers" } },
    ],
  },
  {
    id: "results",
    title: "Results",
    sub: "How query results are fetched and shown.",
    rows: [
      { id: "rowLimit", label: "Row limit", desc: "Rows fetched before “Load more” is offered.", control: { type: "select", key: "rowLimit", numeric: true, options: numOpts(ROW_LIMIT_OPTIONS) } },
      {
        id: "density",
        label: "Row density",
        desc: "Row height in the results table.",
        control: { type: "seg", key: "density", options: [{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "spacious", label: "Spacious" }] },
      },
      { id: "stripes", label: "Zebra stripes", desc: "Alternate row backgrounds.", control: { type: "switch", key: "stripes" } },
      { id: "rowNumbers", label: "Show row numbers", desc: "A narrow column on the left.", control: { type: "switch", key: "rowNumbers" } },
      { id: "nullText", label: "Show NULL as", desc: "Text used for SQL NULL in the table and record view.", control: { type: "text", key: "nullText", placeholder: "null" } },
      { id: "prettyJson", label: "Pretty-print JSON in the record view", desc: "Indent json / jsonb values and arrays.", control: { type: "switch", key: "prettyJson" } },
    ],
  },
  {
    id: "connections",
    title: "Connections",
    sub: "Defaults for new connections and safety rails.",
    rows: [
      { id: "newConnectionReadOnly", label: "New connections are read-only", desc: "Uses the database’s own read-only transaction mode.", control: { type: "switch", key: "newConnectionReadOnly" } },
      { id: "defaultTimeoutSecs", label: "Default query timeout", desc: "Per statement. 0 means no timeout.", control: { type: "select", key: "defaultTimeoutSecs", numeric: true, suffix: "s", options: numOpts([0, 15, 30, 60, 300, 900]) } },
      { id: "defaultSslMode", label: "Default TLS mode", desc: "verify checks the certificate and host name.", control: { type: "select", key: "defaultSslMode", options: opts("disable", "prefer", "require", "verify") } },
      { id: "highlightProd", label: "Highlight production connections", desc: "Red marker on the tab and a banner above the editor.", control: { type: "switch", key: "highlightProd" } },
      { id: "confirmProdWrites", label: "Confirm writes on production", desc: "Ask you to type the connection name before INSERT, UPDATE, DELETE or DDL runs on a production connection.", control: { type: "switch", key: "confirmProdWrites" } },
    ],
  },
  {
    id: "psql",
    title: "psql commands",
    sub: "Backslash commands like \\dt and \\d table.",
    rows: [
      { id: "psqlPath", label: "psql binary", desc: "Leave empty to look it up on PATH and in the usual install locations.", control: { type: "text", key: "psqlPath", placeholder: "/opt/homebrew/bin/psql", wide: true } },
      { id: "psqlFallback", label: "Use the built-in commands when psql is missing", desc: "Read-only catalog commands only.", control: { type: "switch", key: "psqlFallback" } },
      { id: "warnBackslash", label: "Warn before running backslash commands", desc: "Ask before \\! or \\copy … program runs on this computer with your permissions.", control: { type: "switch", key: "warnBackslash" } },
    ],
    callout: "psql commands are not sandboxed. Keep the warning on unless you only run commands you wrote yourself.",
  },
  {
    id: "agents",
    title: "AI agents (MCP)",
    sub: "Let an agent (Claude Code, Codex, Cursor, Claude Desktop, ...) list your connections, read the schema and run queries.",
    rows: [
      { id: "mcpClaude", label: "Add to Claude Code", desc: "Copies the claude mcp add command.", control: { type: "button", text: "Copy command", action: "copyMcpClaude" } },
      { id: "mcpCodex", label: "Add to Codex", desc: "Copies the codex mcp add command.", control: { type: "button", text: "Copy command", action: "copyMcpCodex" } },
      { id: "mcpJson", label: "Add to another agent", desc: "Copies an mcpServers entry for the agent's MCP config file.", control: { type: "button", text: "Copy JSON", action: "copyMcpJson" } },
    ],
    callout: "Agents never see passwords and only get read access. Add --allow-writes to the command to let them write; connections that are read-only or prod stay read-only.",
  },
  {
    id: "shortcuts",
    title: "Shortcuts",
    sub: "Click a shortcut, then press the new keys. Esc cancels.",
    rows: [
      { id: "execute", label: "Execute", desc: "Runs the editor contents.", control: { type: "keys", id: "execute" } },
      { id: "save", label: "Save query", desc: "Opens the Save Query dialog.", control: { type: "keys", id: "save" } },
      { id: "find", label: "Search in results", desc: "Highlights matches in every column.", control: { type: "keys", id: "find" } },
      { id: "palette", label: "Command palette", desc: "Jump to anything.", control: { type: "keys", id: "palette" } },
      { id: "settings", label: "Settings", desc: "Opens this window.", control: { type: "keys", id: "settings" } },
    ],
  },
  {
    id: "data",
    title: "Data & privacy",
    sub: "Where Sauron keeps things, and import / export.",
    rows: [
      { id: "folder", label: "App data folder", desc: "Connections, saved items, settings and history live here.", control: { type: "button", text: "Copy path", action: "copyFolder" } },
      { id: "export", label: "Export connections and saved items", desc: "Writes a JSON file you can import on another computer.", control: { type: "button", text: "Export…", action: "export" } },
      { id: "import", label: "Import from file", desc: "Adds items; existing ones are kept.", control: { type: "button", text: "Import…", action: "import" } },
      { id: "exportPasswordsByDefault", label: "Include passwords in exports by default", desc: "They are written in plain text.", control: { type: "switch", key: "exportPasswordsByDefault" } },
      {
        id: "historyKeep",
        label: "Keep query history",
        desc: "Stored locally. It contains the SQL text, never the results.",
        control: { type: "select", key: "historyKeep", options: [{ value: "off", label: "Off" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "forever", label: "Forever" }] },
      },
      { id: "clearHistory", label: "Clear query history", desc: "", control: { type: "button", text: "Clear…", action: "clearHistory", danger: true } },
    ],
  },
  {
    id: "about",
    title: "About",
    sub: "",
    rows: [
      { id: "version", label: `Sauron v${version}`, desc: "Postgres and ClickHouse search client · MIT", control: { type: "button", text: "Check for updates", action: "checkUpdate" } },
    ],
  },
];

/** Current value of a row as short text ("on", "5,000", "⌘↵") for the command palette. */
export function settingValueText(row: Row, settings: Settings): string {
  const c = row.control;
  if (c.type === "keys") return comboLabels(settings.shortcuts[c.id]).join("");
  if (c.type === "swatch") return settings.accent === "Auto" ? "theme" : settings.accent;
  if (c.type === "themes") return themeById(settings.theme).name;
  if ("key" in c) {
    const value = settings[c.key];
    if (typeof value === "boolean") return value ? "on" : "off";
    if (c.type === "select" && c.numeric && typeof value === "number") return `${value.toLocaleString("en-US")}${c.suffix ?? ""}`;
    return String(value);
  }
  return "";
}

export interface SettingsModalProps {
  settings: Settings;
  /** Dark or light as the user wants it right now ("system" already resolved); the theme previews use it. */
  appearance: Appearance;
  initialSection?: SettingsSection;
  /** Scroll to this row and flash it (from the command palette). */
  focusRow?: string;
  version: string;
  dataDir: string | null;
  /** Path of the running executable, for the MCP setup commands. */
  mcpExecutable: string | null;
  historyCount: number;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  onExport: () => void;
  onImport: () => void;
  onClearHistory: () => void;
  /** Result of the last update check, shown under the version. */
  updateStatus: string;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
  onCopy: (text: string, label: string) => void;
  onClose: () => void;
}

/** Shortcuts that are fixed in the app (not rebindable). */
const RESERVED = ["Mod+T", "Mod+O", "Mod+.", "Mod+Shift+W", "Mod+Shift+Enter", "Mod+Alt+Enter", "Mod+Alt+ArrowLeft", "Mod+Alt+ArrowRight", ...Array.from({ length: 9 }, (_, i) => `Mod+${i + 1}`)];

function Keycap({ id, combo, onChange, conflict }: { id: ShortcutId; combo: string; onChange: (combo: string) => void; conflict: (combo: string) => string | null }) {
  const [recording, setRecording] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      // Window capture runs before the dialog's own Escape handler.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return setRecording(false);
      const next = comboFromEvent(event);
      if (!next) return;
      const clash = conflict(next);
      if (clash) {
        setRejected(clash);
        return;
      }
      setRejected(null);
      onChange(next);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange, conflict]);

  return (
    <button
      aria-label={`Shortcut for ${id}. Click to change.`}
      className={`keycap ${recording ? "rec" : ""}`}
      onBlur={() => setRecording(false)}
      onClick={() => setRecording(true)}
      type="button"
    >
      {recording ? <kbd>{rejected ?? "Press keys…"}</kbd> : comboLabels(combo).map((part, index) => <kbd key={index}>{part}</kbd>)}
    </button>
  );
}

export function SettingsModal(props: SettingsModalProps) {
  const { settings, onChange } = props;
  const sections = useMemo(() => settingsSections(props.version), [props.version]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SettingsSection>(props.initialSection ?? "general");
  const [confirmReset, setConfirmReset] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const q = query.trim().toLowerCase();

  const visible = sections
    .map((section) => ({
      section,
      rows: section.rows.filter((row) => !q || `${row.label} ${row.desc} ${section.title}`.toLowerCase().includes(q)),
    }))
    .filter(({ rows }) => rows.length > 0);

  const scrollTo = (id: SettingsSection) => {
    setActive(id);
    const body = bodyRef.current;
    const el = body?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (body && el) body.scrollTop = el.offsetTop - body.offsetTop;
  };

  useEffect(() => {
    if (props.focusRow) {
      const body = bodyRef.current;
      const row = body?.querySelector<HTMLElement>(`[data-id="${props.focusRow}"]`);
      if (body && row) {
        body.scrollTop = row.offsetTop - body.offsetTop - 80;
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1300);
        const section = row.closest<HTMLElement>("[data-section]")?.dataset.section as SettingsSection | undefined;
        if (section) setActive(section);
      }
    } else if (props.initialSection) scrollTo(props.initialSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    let current = visible[0]?.section.id;
    for (const { section } of visible) {
      const el = body.querySelector<HTMLElement>(`[data-section="${section.id}"]`);
      if (el && el.offsetTop - body.offsetTop - 40 <= body.scrollTop) current = section.id;
    }
    if (current) setActive(current);
  };

  const highlight = (text: string): ReactNode => {
    if (!q) return text;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) return text;
    return (
      <>
        {text.slice(0, at)}
        <mark className="settings-hit">{text.slice(at, at + q.length)}</mark>
        {text.slice(at + q.length)}
      </>
    );
  };

  const isChanged = (row: Row): boolean => {
    const c = row.control;
    if (c.type === "swatch") return settings.accent !== DEFAULT_SETTINGS.accent;
    if (c.type === "themes") return settings.theme !== DEFAULT_SETTINGS.theme;
    if (c.type === "keys") return settings.shortcuts[c.id] !== DEFAULT_SETTINGS.shortcuts[c.id];
    if ("key" in c) return settings[c.key] !== DEFAULT_SETTINGS[c.key];
    return false;
  };

  const renderControl = (row: Row): ReactNode => {
    const c = row.control;
    switch (c.type) {
      case "switch":
        return (
          <button
            aria-checked={Boolean(settings[c.key])}
            aria-label={row.label}
            className={`switch ${settings[c.key] ? "on" : ""}`}
            onClick={() => onChange({ [c.key]: !settings[c.key] } as Partial<Settings>)}
            role="switch"
            type="button"
          >
            <i />
          </button>
        );
      case "seg":
        return (
          <div aria-label={row.label} className="seg" role="group">
            {c.options.map((option) => (
              <button
                aria-pressed={settings[c.key] === option.value}
                className={settings[c.key] === option.value ? "active" : ""}
                key={option.value}
                onClick={() => onChange({ [c.key]: option.value } as Partial<Settings>)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        );
      case "swatch":
        return (
          <div aria-label="Accent color" className="swatches" role="group">
            <button
              aria-label="Theme accent"
              aria-pressed={settings.accent === "Auto"}
              className={`swatch-auto ${settings.accent === "Auto" ? "active" : ""}`}
              onClick={() => onChange({ accent: "Auto" })}
              type="button"
            >
              Theme
            </button>
            {(Object.keys(ACCENTS) as AccentName[]).map((name) => (
              <button
                aria-label={name}
                aria-pressed={settings.accent === name}
                className={settings.accent === name ? "active" : ""}
                key={name}
                onClick={() => onChange({ accent: name })}
                style={{ background: ACCENTS[name], color: ACCENTS[name] }}
                title={name}
                type="button"
              />
            ))}
          </div>
        );
      case "themes":
        return (
          <div aria-label="Theme" className="theme-grid" role="group">
            {THEMES.map((theme) => {
              const { palette: p, appearance } = paletteOf(theme, props.appearance);
              const selected = settings.theme === theme.id;
              return (
                <button
                  aria-pressed={selected}
                  className={`theme-card ${selected ? "active" : ""}`}
                  key={theme.id}
                  onClick={() => onChange({ theme: theme.id })}
                  title={theme.blurb}
                  type="button"
                >
                  <span className="theme-preview" style={{ background: p.bg, borderColor: p.line }}>
                    <i className="tp-side" style={{ background: p.panel, borderColor: p.line }} />
                    <i className="tp-main" style={{ background: p.panel, borderColor: p.line }}>
                      <b style={{ background: p.text }} />
                      <b style={{ background: p.dim }} />
                      <b style={{ background: p.faint }} />
                      <em style={{ background: p.accent }} />
                    </i>
                  </span>
                  <span className="theme-name">
                    {theme.name}
                    {!hasAppearance(theme, props.appearance) ? <small>{appearance} only</small> : null}
                  </span>
                </button>
              );
            })}
          </div>
        );
      case "select": {
        const current = String(settings[c.key]);
        const options = c.options.some((o) => o.value === current) ? c.options : [{ value: current, label: current }, ...c.options];
        return (
          <span className="select-wrap">
            <select
              aria-label={row.label}
              onChange={(event) => onChange({ [c.key]: c.numeric ? Number(event.target.value) : event.target.value } as Partial<Settings>)}
              value={current}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                  {c.suffix ?? ""}
                </option>
              ))}
            </select>
          </span>
        );
      }
      case "text":
        return (
          <input
            aria-label={row.label}
            className={c.wide ? "wide" : ""}
            onChange={(event) => onChange({ [c.key]: event.target.value } as Partial<Settings>)}
            placeholder={c.placeholder}
            spellCheck={false}
            type="text"
            value={String(settings[c.key])}
          />
        );
      case "keys":
        return (
          <Keycap
            combo={settings.shortcuts[c.id]}
            conflict={(next) => {
              if (RESERVED.includes(next)) return "Used by the app";
              const other = (Object.keys(settings.shortcuts) as ShortcutId[]).find((key) => key !== c.id && settings.shortcuts[key] === next);
              return other ? `Already used by “${other}”` : null;
            }}
            id={c.id}
            onChange={(combo) => onChange({ shortcuts: { ...settings.shortcuts, [c.id]: combo } })}
          />
        );
      case "button":
        return (
          <button
            className={`btn settings-button ${c.danger ? "danger" : ""}`}
            disabled={(c.action === "checkUpdate" && props.checkingUpdate) || (c.action.startsWith("copyMcp") && !props.mcpExecutable)}
            onClick={() => {
              if (c.action === "export") props.onExport();
              else if (c.action === "import") props.onImport();
              else if (c.action === "clearHistory") props.onClearHistory();
              else if (c.action === "checkUpdate") props.onCheckUpdate();
              else if (c.action === "copyMcpClaude" && props.mcpExecutable) props.onCopy(mcpSetup(props.mcpExecutable).claude, "the Claude Code command");
              else if (c.action === "copyMcpCodex" && props.mcpExecutable) props.onCopy(mcpSetup(props.mcpExecutable).codex, "the Codex command");
              else if (c.action === "copyMcpJson" && props.mcpExecutable) props.onCopy(mcpSetup(props.mcpExecutable).json, "the MCP config");
              else if (c.action === "copyFolder" && props.dataDir) props.onCopy(props.dataDir, "the folder path");
            }}
            type="button"
          >
            {c.text}
          </button>
        );
      case "value":
        return <span className="settings-value">{c.text}</span>;
    }
  };

  const describe = (row: Row): string => {
    if (row.id === "folder") return props.dataDir ?? row.desc;
    if (row.id === "mcpClaude" && props.mcpExecutable) return mcpSetup(props.mcpExecutable).claude;
    if (row.id === "mcpCodex" && props.mcpExecutable) return mcpSetup(props.mcpExecutable).codex;
    if (row.id === "version" && props.updateStatus) return `${row.desc} · ${props.updateStatus}`;
    if (row.id === "clearHistory") return `${props.historyCount.toLocaleString("en-US")} entr${props.historyCount === 1 ? "y" : "ies"}.`;
    return row.desc;
  };

  return (
    <Modal className="settings-modal" hideTitle onClose={props.onClose} title="Settings">
      <div className="settings-head">
        <div className="settings-search">
          <SearchIcon />
          <input
            aria-label="Search settings"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings…"
            spellCheck={false}
            type="search"
            value={query}
          />
        </div>
        <strong className="settings-title">Settings</strong>
        <button aria-label="Close settings" className="settings-close" onClick={props.onClose} type="button">
          <CloseIcon />
        </button>
      </div>
      <div className="settings-wrap">
        <nav aria-label="Settings sections" className="settings-nav">
          {sections.map((section) => {
            const hits = visible.find((v) => v.section.id === section.id)?.rows.length ?? 0;
            return (
              <button
                className={active === section.id ? "active" : ""}
                disabled={q !== "" && hits === 0}
                key={section.id}
                onClick={() => scrollTo(section.id)}
                type="button"
              >
                {section.title}
                {q && hits > 0 ? <span className="count">{hits}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="settings-body" onScroll={onScroll} ref={bodyRef}>
          {visible.length === 0 ? <p className="settings-empty">No settings match “{query}”.</p> : null}
          {visible.map(({ section, rows }) => (
            <section data-section={section.id} key={section.id}>
              <h4>{section.title}</h4>
              {section.sub && !q ? <p className="settings-sub">{section.sub}</p> : null}
              {rows.map((row) => (
                <div className={`settings-row ${row.control.type === "themes" ? "wide" : ""} ${isChanged(row) ? "is-changed" : ""}`} data-id={row.id} key={row.id}>
                  <div className="settings-label">
                    <span className="lbl">{highlight(row.label)}</span>
                    <span className="desc">{describe(row)}</span>
                  </div>
                  <div className="settings-control">{renderControl(row)}</div>
                </div>
              ))}
              {section.callout && !q ? (
                <div className="settings-callout">
                  <WarningIcon />
                  <span>{section.callout}</span>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
      <div className="settings-foot">
        {confirmReset ? (
          <>
            <span className="settings-foot-warn" role="alert">
              <WarningIcon />
              Reset every setting to its default? This cannot be undone.
            </span>
            <span className="settings-foot-actions">
              <button className="btn settings-button" onClick={() => setConfirmReset(false)} type="button">
                Cancel
              </button>
              <button
                className="btn settings-button danger"
                onClick={() => {
                  setConfirmReset(false);
                  props.onReset();
                }}
                type="button"
              >
                Reset everything
              </button>
            </span>
          </>
        ) : (
          <>
            <span>Changes apply immediately and are saved automatically.</span>
            <button className="btn settings-button" onClick={() => setConfirmReset(true)} type="button">
              Reset all to defaults
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
