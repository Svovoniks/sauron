import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { registerSchemaCompletion, type CompletionSource } from "../lib/sqlCompletion";
import { statementAt } from "../lib/sql/analyze";
import { splitSqlRanges } from "../lib/sql/splitStatements";
import { matchesShortcut, type Settings } from "../lib/settings";
import type { MonacoThemeData } from "../lib/themes";
import type { DbType } from "../types/app";

/** The part of Settings the editor reacts to. */
export type EditorSettings = Pick<Settings, "editorFontSize" | "editorFont" | "wordWrap" | "lineNumbers" | "shortcuts">;

export type RunKind = "default" | "script" | "statement" | "explain";

/** What a run should send: the selection, the statement at the cursor, or everything. */
export interface RunTarget {
  text: string;
  /** Offset of `text` inside the full editor text. */
  offset: number;
  source: "selection" | "statement" | "script";
}

const editorOptions = (s: EditorSettings): Monaco.editor.IStandaloneEditorConstructionOptions => ({
  fontSize: s.editorFontSize,
  fontFamily: `${s.editorFont.includes(" ") ? `"${s.editorFont}"` : s.editorFont}, Menlo, Consolas, monospace`,
  wordWrap: s.wordWrap ? "on" : "off",
  lineNumbers: s.lineNumbers ? "on" : "off",
  lineNumbersMinChars: s.lineNumbers ? 3 : 0,
  lineDecorationsWidth: s.lineNumbers ? 8 : "0px",
});

interface EditorParams {
  activeTabId: string | null;
  /** Text and dialect of a tab, read when its model is created. */
  tabInfo: (tabId: string) => { sql: string; dbType: DbType } | null;
  /** The language of the active tab changed (its connection changed). */
  activeDbType: DbType;
  onTextChange: (tabId: string, text: string) => void;
  onRun: (kind: RunKind) => void;
  /** App-wide shortcuts (palette, settings, tabs, ...) that Monaco must not swallow; true = handled. */
  onShortcut: (event: KeyboardEvent) => boolean;
  settings: EditorSettings;
  /** Colors of the editor (follows the app theme). */
  theme: MonacoThemeData;
  /** Schema for autocomplete (of the active tab's connection). */
  completion: CompletionSource;
  /** Highlight the statement under the cursor when the script has several. */
  outlineStatements: boolean;
}

/**
 * One Monaco editor with one model per tab (so every tab keeps its own undo history and cursor).
 * Text flows editor -> state only; to change the text from outside use `replaceText`.
 */
export function useSqlEditor(params: EditorParams) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const languageForRef = useRef<((dbType: DbType) => string) | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const modelsRef = useRef(new Map<string, { model: Monaco.editor.ITextModel; subscription: Monaco.IDisposable }>());
  const viewStates = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  const shownTabRef = useRef<string | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const [ready, setReady] = useState(false);

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const updateOutline = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const collection = decorationsRef.current;
    if (!editor || !model || !collection) return;
    const p = paramsRef.current;
    const dbType = p.tabInfo(shownTabRef.current ?? "")?.dbType ?? p.activeDbType;
    const ranges = splitSqlRanges(model.getValue(), dbType);
    if (!p.outlineStatements || ranges.length < 2) return collection.clear();
    const position = editor.getPosition();
    const index = statementAt(ranges, position ? model.getOffsetAt(position) : 0);
    const range = ranges[index];
    if (!range) return collection.clear();
    const start = model.getPositionAt(range.start);
    const end = model.getPositionAt(range.end);
    collection.set([{ range: { startLineNumber: start.lineNumber, startColumn: 1, endLineNumber: end.lineNumber, endColumn: model.getLineMaxColumn(end.lineNumber) }, options: { isWholeLine: true, className: "stmt-current", linesDecorationsClassName: "stmt-current-bar" } }]);
  }, []);

  // --- create the editor ------------------------------------------------------------------------
  useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    const disposables: Monaco.IDisposable[] = [];

    const init = async () => {
      const container = editorContainerRef.current;
      if (!container) return;

      const { default: monaco, languageFor, applyEditorTheme } = await import("../lib/monaco");
      if (disposed) return;
      monacoRef.current = monaco;
      languageForRef.current = languageFor;

      editor = monaco.editor.create(container, {
        model: null,
        minimap: { enabled: false },
        automaticLayout: false,
        theme: applyEditorTheme(paramsRef.current.theme),
        scrollbar: { vertical: "hidden", verticalSliderSize: 0, verticalScrollbarSize: 0 },
        contextmenu: false,
        padding: { top: 5, bottom: 5 },
        renderLineHighlight: "none",
        fixedOverflowWidgets: true,
        ...editorOptions(paramsRef.current.settings),
      });

      // The Execute shortcut is rebindable (Settings), so it cannot be a fixed Monaco command.
      editor.onKeyDown((event) => {
        const e = event.browserEvent;
        const p = paramsRef.current;
        let kind: RunKind | null = null;
        if (e.key === "Enter" && e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey) kind = "explain";
        else if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) kind = "script";
        else if (matchesShortcut(e, "execute", p.settings.shortcuts)) kind = "default";
        if (kind) {
          event.preventDefault();
          event.stopPropagation();
          p.onRun(kind);
        } else if (p.onShortcut(e)) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      editor.onDidChangeCursorPosition(updateOutline);
      decorationsRef.current = editor.createDecorationsCollection();

      disposables.push(...registerSchemaCompletion(monaco, ["pgsql", "sql"], () => paramsRef.current.completion));

      resizeObserver = new ResizeObserver(() => editor?.layout());
      resizeObserver.observe(container);
      editorRef.current = editor;
      // Handy for poking at the editor from the browser console / automated checks in `bun run dev`.
      if (import.meta.env.DEV) (window as unknown as { __editor?: unknown }).__editor = editor;
      setReady(true);
    };

    init().catch((error) => console.error("Failed to start the SQL editor.", error));
    const models = modelsRef.current;

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      disposables.forEach((d) => d.dispose());
      models.forEach(({ model, subscription }) => {
        subscription.dispose();
        model.dispose();
      });
      models.clear();
      editor?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
      setReady(false);
    };
  }, [updateOutline]);

  const modelFor = useCallback(
    (tabId: string) => {
      const existing = modelsRef.current.get(tabId);
      if (existing && !existing.model.isDisposed()) return existing.model;
      if (existing) {
        existing.subscription.dispose();
        modelsRef.current.delete(tabId);
      }
      const monaco = monacoRef.current;
      const languageFor = languageForRef.current;
      const info = paramsRef.current.tabInfo(tabId);
      if (!monaco || !languageFor || !info) return null;
      const model = monaco.editor.createModel(info.sql, languageFor(info.dbType));
      const subscription = model.onDidChangeContent(() => {
        monacoRef.current?.editor.setModelMarkers(model, "sauron", []);
        paramsRef.current.onTextChange(tabId, model.getValue());
        if (shownTabRef.current === tabId) updateOutline();
      });
      modelsRef.current.set(tabId, { model, subscription });
      return model;
    },
    [updateOutline],
  );

  // --- show the active tab's model ---------------------------------------------------------------
  /**
   * Make sure the editor shows a live model of the active tab. Normally this only runs when the active tab changes,
   * but a model can get lost in between (a tab closed while its text was on screen, a model rebuilt), which leaves a
   * blank editor you cannot type into. So it is also called when you press the mouse in the editor.
   */
  const showActiveModel = useCallback(() => {
    const editor = editorRef.current;
    const tabId = paramsRef.current.activeTabId;
    if (!editor || !tabId) return;
    const model = modelFor(tabId);
    if (!model) return;
    const current = editor.getModel();
    if (current === model && !model.isDisposed()) return;
    const previous = shownTabRef.current;
    if (previous && previous !== tabId && current && !current.isDisposed()) viewStates.current.set(previous, editor.saveViewState());
    shownTabRef.current = tabId;
    editor.setModel(model);
    const view = viewStates.current.get(tabId);
    if (view) editor.restoreViewState(view);
    updateOutline();
  }, [modelFor, updateOutline]);

  const { activeTabId } = params;
  useEffect(() => {
    if (ready) showActiveModel();
  }, [ready, activeTabId, showActiveModel]);

  useEffect(() => {
    const container = editorContainerRef.current;
    if (!ready || !container) return;
    const heal = () => {
      showActiveModel();
      editorRef.current?.layout();
    };
    container.addEventListener("mousedown", heal, true);
    return () => container.removeEventListener("mousedown", heal, true);
  }, [ready, showActiveModel]);

  // Drop models of tabs that are gone.
  const dropModel = useCallback((tabId: string) => {
    const entry = modelsRef.current.get(tabId);
    if (!entry) return;
    entry.subscription.dispose();
    entry.model.dispose();
    modelsRef.current.delete(tabId);
    viewStates.current.delete(tabId);
    if (shownTabRef.current === tabId) shownTabRef.current = null;
  }, []);

  // Follow the app theme.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    void import("../lib/monaco").then(({ applyEditorTheme }) => applyEditorTheme(params.theme));
  }, [params.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(params.settings));
  }, [params.settings.editorFontSize, params.settings.editorFont, params.settings.wordWrap, params.settings.lineNumbers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch the SQL dialect when the active tab's connection changes.
  useEffect(() => {
    const monaco = monacoRef.current;
    const languageFor = languageForRef.current;
    const model = editorRef.current?.getModel();
    if (monaco && languageFor && model) monaco.editor.setModelLanguage(model, languageFor(params.activeDbType));
    updateOutline();
  }, [params.activeDbType, ready, activeTabId, updateOutline]);

  useEffect(() => updateOutline(), [params.outlineStatements, updateOutline]);

  /** Replace the whole text but keep it undoable (Ctrl+Z brings the previous query back). */
  const replaceText = useCallback((text: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.pushUndoStop();
    editor.executeEdits("replace", [{ range: model.getFullModelRange(), text }]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.revealLine(1);
  }, []);

  /** Insert at the cursor (replacing the selection). */
  const insertText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.pushUndoStop();
    editor.executeEdits("insert", [{ range: selection, text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
  }, []);

  const focus = useCallback(() => editorRef.current?.focus(), []);

  /** What to run right now. `kind: "script"` always means everything. */
  const getRunTarget = useCallback((kind: RunKind, scope: Settings["execScope"]): RunTarget => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return { text: "", offset: 0, source: "script" };
    const full = model.getValue();
    const selection = editor.getSelection();
    if (kind !== "script" && selection && !selection.isEmpty()) {
      const start = model.getOffsetAt(selection.getStartPosition());
      return { text: model.getValueInRange(selection), offset: start, source: "selection" };
    }
    const effective = kind === "statement" ? "statement" : kind === "script" ? "script" : scope;
    if (effective === "script") return { text: full, offset: 0, source: "script" };
    const dbType = paramsRef.current.tabInfo(shownTabRef.current ?? "")?.dbType ?? paramsRef.current.activeDbType;
    const ranges = splitSqlRanges(full, dbType);
    if (ranges.length <= 1) return { text: full, offset: 0, source: "script" };
    const position = editor.getPosition();
    const range = ranges[statementAt(ranges, position ? model.getOffsetAt(position) : 0)];
    return range ? { text: range.text, offset: range.start, source: "statement" } : { text: full, offset: 0, source: "script" };
  }, []);

  /** Squiggle under `[offset, offset + length)` of the active model, and move the cursor there on request. */
  const markError = useCallback((offset: number, length: number, message: string, reveal = false) => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!monaco || !editor || !model) return;
    const start = model.getPositionAt(Math.max(0, offset));
    const end = model.getPositionAt(Math.max(0, offset) + Math.max(1, length));
    monaco.editor.setModelMarkers(model, "sauron", [
      { severity: monaco.MarkerSeverity.Error, message, startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
    ]);
    if (reveal) {
      editor.setPosition(start);
      editor.revealLineInCenterIfOutsideViewport(start.lineNumber);
      editor.focus();
    }
  }, []);

  const clearMarkers = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (model) monacoRef.current?.editor.setModelMarkers(model, "sauron", []);
  }, []);

  /** Replace `[offset, offset + length)` with `text` (quick fixes). */
  const replaceRange = useCallback((offset: number, length: number, text: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const start = model.getPositionAt(offset);
    const end = model.getPositionAt(offset + length);
    editor.pushUndoStop();
    editor.executeEdits("quick-fix", [{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text }]);
    editor.pushUndoStop();
  }, []);

  return { editorRef, editorContainerRef, ready, replaceText, insertText, focus, getRunTarget, markError, clearMarkers, replaceRange, dropModel };
}
