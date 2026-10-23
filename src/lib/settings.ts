/** User preferences, persisted in settings.json (see useSettings). */
import { DEFAULT_THEME, THEME_IDS, type AppearanceSetting, type ThemeId } from "./themes";

export const ACCENTS = {
  Blue: "#3b82f6",
  Violet: "#8b5cf6",
  Teal: "#14b8a6",
  Amber: "#f59e0b",
  Rose: "#f43f5e",
  Green: "#22c55e",
} as const;
export type AccentName = keyof typeof ACCENTS;
/** "Auto" uses the accent of the chosen theme. */
export type AccentChoice = "Auto" | AccentName;

export type Density = "compact" | "comfortable" | "spacious";
export type ExecScope = "script" | "statement";
export type HistoryKeep = "off" | "7" | "30" | "forever";
export type SslDefault = "disable" | "prefer" | "require" | "verify";

export type ShortcutId = "execute" | "save" | "find" | "palette" | "settings";

export interface Settings {
  // General
  theme: ThemeId;
  appearance: AppearanceSetting;
  accent: AccentChoice;
  restoreSession: boolean;
  autoUpdate: boolean;
  /** Version the user chose to skip in the update dialog (offered again when a newer one appears). */
  skippedUpdate: string;
  // Editor
  editorFontSize: number;
  editorFont: string;
  execScope: ExecScope;
  autocomplete: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  // Results
  rowLimit: number;
  density: Density;
  stripes: boolean;
  rowNumbers: boolean;
  nullText: string;
  prettyJson: boolean;
  // Connections
  newConnectionReadOnly: boolean;
  defaultTimeoutSecs: number;
  defaultSslMode: SslDefault;
  highlightProd: boolean;
  confirmProdWrites: boolean;
  // psql
  psqlPath: string;
  psqlFallback: boolean;
  warnBackslash: boolean;
  // Shortcuts (combo strings, see parseCombo)
  shortcuts: Record<ShortcutId, string>;
  // Data
  exportPasswordsByDefault: boolean;
  historyKeep: HistoryKeep;
}

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  execute: "Mod+Enter",
  save: "Mod+S",
  find: "Mod+F",
  palette: "Mod+K",
  settings: "Mod+,",
};

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  appearance: "dark",
  accent: "Auto",
  restoreSession: true,
  autoUpdate: true,
  skippedUpdate: "",
  editorFontSize: 15,
  editorFont: "Monaco",
  execScope: "script",
  autocomplete: true,
  wordWrap: true,
  lineNumbers: false,
  rowLimit: 5_000,
  density: "comfortable",
  stripes: false,
  rowNumbers: false,
  nullText: "null",
  prettyJson: true,
  newConnectionReadOnly: true,
  defaultTimeoutSecs: 60,
  defaultSslMode: "require",
  highlightProd: true,
  confirmProdWrites: true,
  psqlPath: "",
  psqlFallback: true,
  warnBackslash: true,
  shortcuts: DEFAULT_SHORTCUTS,
  exportPasswordsByDefault: false,
  historyKeep: "30",
};

export const ROW_LIMIT_OPTIONS = [500, 1_000, 5_000, 10_000, 50_000, 100_000];
export const EDITOR_FONTS = ["Monaco", "SF Mono", "Menlo", "JetBrains Mono", "Fira Code", "Consolas", "monospace"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const int = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

/** Defensive: a damaged or older settings file never breaks the app, missing keys get defaults. */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!isRecord(raw)) return { ...d, shortcuts: { ...d.shortcuts } };

  const shortcuts = { ...d.shortcuts };
  if (isRecord(raw.shortcuts)) {
    for (const id of Object.keys(shortcuts) as ShortcutId[]) {
      const combo = raw.shortcuts[id];
      if (typeof combo === "string" && parseCombo(combo)) shortcuts[id] = combo;
    }
  }

  return {
    theme: oneOf(raw.theme, THEME_IDS, d.theme),
    appearance: oneOf(raw.appearance, ["dark", "light", "system"], d.appearance),
    // Settings files from before themes always carry "Blue" (the old default), which must not override a theme's own accent.
    accent: raw.theme === undefined && raw.accent === "Blue" ? "Auto" : oneOf(raw.accent, ["Auto", ...(Object.keys(ACCENTS) as AccentName[])], d.accent),
    restoreSession: bool(raw.restoreSession, d.restoreSession),
    autoUpdate: bool(raw.autoUpdate, d.autoUpdate),
    skippedUpdate: typeof raw.skippedUpdate === "string" ? raw.skippedUpdate.slice(0, 40) : d.skippedUpdate,
    editorFontSize: int(raw.editorFontSize, 10, 24, d.editorFontSize),
    editorFont: typeof raw.editorFont === "string" && raw.editorFont.trim() ? raw.editorFont.slice(0, 80) : d.editorFont,
    execScope: oneOf(raw.execScope, ["script", "statement"], d.execScope),
    autocomplete: bool(raw.autocomplete, d.autocomplete),
    wordWrap: bool(raw.wordWrap, d.wordWrap),
    lineNumbers: bool(raw.lineNumbers, d.lineNumbers),
    rowLimit: int(raw.rowLimit, 1, 1_000_000, d.rowLimit),
    density: oneOf(raw.density, ["compact", "comfortable", "spacious"], d.density),
    stripes: bool(raw.stripes, d.stripes),
    rowNumbers: bool(raw.rowNumbers, d.rowNumbers),
    nullText: typeof raw.nullText === "string" ? raw.nullText.slice(0, 20) : d.nullText,
    prettyJson: bool(raw.prettyJson, d.prettyJson),
    newConnectionReadOnly: bool(raw.newConnectionReadOnly, d.newConnectionReadOnly),
    defaultTimeoutSecs: int(raw.defaultTimeoutSecs, 0, 86_400, d.defaultTimeoutSecs),
    defaultSslMode: oneOf(raw.defaultSslMode, ["disable", "prefer", "require", "verify"], d.defaultSslMode),
    highlightProd: bool(raw.highlightProd, d.highlightProd),
    confirmProdWrites: bool(raw.confirmProdWrites, d.confirmProdWrites),
    psqlPath: typeof raw.psqlPath === "string" ? raw.psqlPath.trim().slice(0, 500) : d.psqlPath,
    psqlFallback: bool(raw.psqlFallback, d.psqlFallback),
    warnBackslash: bool(raw.warnBackslash, d.warnBackslash),
    shortcuts,
    exportPasswordsByDefault: bool(raw.exportPasswordsByDefault, d.exportPasswordsByDefault),
    historyKeep: oneOf(raw.historyKeep, ["off", "7", "30", "forever"], d.historyKeep),
  };
}

/** Hex of the accent the user picked, or null when the theme's own accent is used. */
export const accentOverride = (choice: AccentChoice): string | null => (choice === "Auto" ? null : ACCENTS[choice]);

export const DENSITY_PADDING: Record<Density, number> = { compact: 6, comfortable: 12, spacious: 18 };
/** Estimated table row height per density (the virtualizer measures real rows anyway). */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = { compact: 30, comfortable: 42, spacious: 54 };

// --- keyboard shortcuts -------------------------------------------------------------------------

export interface Combo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** "Mod+Shift+K" -> parts. `Mod` is Cmd on macOS and Ctrl elsewhere. Null if malformed. */
export function parseCombo(combo: string): Combo | null {
  const parts = combo.split("+");
  // "Mod++" would be Mod and "+": handle a trailing empty segment.
  let key = parts.pop() ?? "";
  if (key === "" && parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
    key = "+";
  }
  if (!key) return null;
  const mods = new Set(parts);
  for (const m of mods) if (!["Mod", "Shift", "Alt"].includes(m)) return null;
  if (!mods.has("Mod") && !mods.has("Alt")) return null; // bare keys would break typing
  return { mod: mods.has("Mod"), shift: mods.has("Shift"), alt: mods.has("Alt"), key };
}

export const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

const normalizeKey = (key: string) => (key.length === 1 ? key.toUpperCase() : key);

export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const c = parseCombo(combo);
  if (!c) return false;
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  // With Alt held macOS produces special characters in `key`; compare the physical key instead.
  const key = c.alt && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : normalizeKey(event.key);
  return mod === c.mod && event.shiftKey === c.shift && event.altKey === c.alt && key === normalizeKey(c.key);
}

/** Combo for a keydown event, or null while only modifiers are held / the combo has no modifier. */
export function comboFromEvent(event: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return null;
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if (!mod && !event.altKey) return null;
  const key = event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : normalizeKey(event.key);
  return [mod ? "Mod" : "", event.shiftKey ? "Shift" : "", event.altKey ? "Alt" : "", key].filter(Boolean).join("+");
}

const KEY_LABEL: Record<string, string> = { Enter: "↵", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "⌫", " ": "Space" };

/** Keycap labels, e.g. ["⌘", "↵"] on macOS or ["Ctrl", "Enter"] elsewhere. */
export function comboLabels(combo: string): string[] {
  const c = parseCombo(combo);
  if (!c) return [combo];
  const mac = isMac();
  const out: string[] = [];
  if (mac) {
    if (c.alt) out.push("⌥");
    if (c.shift) out.push("⇧");
    if (c.mod) out.push("⌘");
    out.push(KEY_LABEL[c.key] ?? c.key);
  } else {
    if (c.mod) out.push("Ctrl");
    if (c.alt) out.push("Alt");
    if (c.shift) out.push("Shift");
    out.push(c.key === "Enter" ? "Enter" : (KEY_LABEL[c.key] ?? c.key));
  }
  return out;
}

export const comboText = (combo: string) => comboLabels(combo).join(isMac() ? "" : "+");

/** Matches a rebindable shortcut. The default Execute also keeps working with Ctrl on macOS (the old hint). */
export function matchesShortcut(event: KeyboardEvent, id: ShortcutId, shortcuts: Record<ShortcutId, string>): boolean {
  if (matchesCombo(event, shortcuts[id])) return true;
  return id === "execute" && shortcuts[id] === DEFAULT_SHORTCUTS.execute && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key === "Enter";
}
