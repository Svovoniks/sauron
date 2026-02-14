import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { LanguageIdEnum, vsPlusTheme } from "monaco-sql-languages";
import "monaco-sql-languages/esm/languages/flink/flink.contribution";
import "monaco-sql-languages/esm/languages/hive/hive.contribution";
import "monaco-sql-languages/esm/languages/impala/impala.contribution";
import "monaco-sql-languages/esm/languages/mysql/mysql.contribution";
import "monaco-sql-languages/esm/languages/pgsql/pgsql.contribution";
import "monaco-sql-languages/esm/languages/spark/spark.contribution";
import "monaco-sql-languages/esm/languages/trino/trino.contribution";

export function useSqlEditor(
  queryText: string,
  setQueryText: (value: string) => void,
  onExecuteQuery: () => void,
) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const onExecuteQueryRef = useRef(onExecuteQuery);

  useEffect(() => {
    onExecuteQueryRef.current = onExecuteQuery;
  }, [onExecuteQuery]);

  useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let disposed = false;

    const initEditor = async () => {
      const container = editorContainerRef.current;
      if (!container) return;

      const monaco = (await import("../lib/monaco")).default;
      if (disposed) return;
      monacoRef.current = monaco;

      monaco.editor.defineTheme("sql-dark", vsPlusTheme.darkThemeData);
      const editor = monaco.editor.create(container, {
        lineNumbers: "off",
        minimap: { enabled: false },
        automaticLayout: false,
        theme: "sql-dark",
        scrollbar: { vertical: "hidden", verticalSliderSize: 0, verticalScrollbarSize: 0 },
        language: LanguageIdEnum.FLINK,
        lineDecorationsWidth: "0px",
        find: undefined,
        wordWrap: "on",
        lineNumbersMinChars: 0,
        padding: { top: 5, bottom: 5 },
        renderLineHighlight: "none",
        value: queryText,
        fontSize: 15,
      });

      editor.onDidChangeModelContent(() => setQueryText(editor.getValue()));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onExecuteQueryRef.current());
      resizeObserver = new ResizeObserver(() => editor.layout());
      resizeObserver.observe(container);
      editorRef.current = editor;
    };

    initEditor();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      monacoRef.current?.editor.getModels().forEach((model) => model.dispose());
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  return {
    editorRef,
    editorContainerRef,
  };
}
