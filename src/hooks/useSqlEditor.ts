import { useCallback, useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { DbType } from "../types/app";

/**
 * Mounts a Monaco editor in `editorContainerRef`.
 * `initialValue` is only read once; use `editorRef.current?.setValue()` to replace the text.
 */
export function useSqlEditor(
  initialValue: string,
  dbType: DbType,
  onChange: (value: string) => void,
  onExecute: () => void,
) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const languageForRef = useRef<((dbType: DbType) => string) | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const onExecuteRef = useRef(onExecute);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(initialValue);
  const dbTypeRef = useRef(dbType);

  useEffect(() => {
    onExecuteRef.current = onExecute;
    onChangeRef.current = onChange;
    dbTypeRef.current = dbType;
  });

  useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;

    const init = async () => {
      const container = editorContainerRef.current;
      if (!container) return;

      const { default: monaco, languageFor, SQL_DARK_THEME } = await import("../lib/monaco");
      if (disposed) return;
      monacoRef.current = monaco;
      languageForRef.current = languageFor;

      editor = monaco.editor.create(container, {
        lineNumbers: "off",
        minimap: { enabled: false },
        automaticLayout: false,
        theme: SQL_DARK_THEME,
        scrollbar: { vertical: "hidden", verticalSliderSize: 0, verticalScrollbarSize: 0 },
        language: languageFor(dbTypeRef.current),
        lineDecorationsWidth: "0px",
        contextmenu: false,
        wordWrap: "on",
        lineNumbersMinChars: 0,
        padding: { top: 5, bottom: 5 },
        renderLineHighlight: "none",
        value: initialValueRef.current,
        fontSize: 15,
      });

      editor.onDidChangeModelContent(() => onChangeRef.current(editor!.getValue()));
      const run = () => onExecuteRef.current();
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Enter, run);
      resizeObserver = new ResizeObserver(() => editor?.layout());
      resizeObserver.observe(container);
      editorRef.current = editor;
    };

    init().catch((error) => console.error("Failed to start the SQL editor.", error));

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      // Dispose only what this hook created (not every model in the page).
      editor?.getModel()?.dispose();
      editor?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  // Switch the SQL dialect when the active connection changes.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const languageFor = languageForRef.current;
    const model = editor?.getModel();
    if (monaco && languageFor && model) monaco.editor.setModelLanguage(model, languageFor(dbType));
  }, [dbType]);

  /** Replace the whole text but keep it undoable (Ctrl+Z brings the previous query back). */
  const replaceText = useCallback((text: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.pushUndoStop();
    editor.executeEdits("open-file", [{ range: model.getFullModelRange(), text }]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.revealLine(1);
  }, []);

  return { editorRef, editorContainerRef, replaceText };
}
