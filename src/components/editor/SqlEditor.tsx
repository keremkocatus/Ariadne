import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { registerSqlProviders, setActiveConnection } from "@/lib/monaco/providers";
import { setRunSelectionGetter, setFormatAction, setSnippetPlacer } from "@/lib/editorRun";
import { explainActive } from "@/lib/queryActions";
import { formatSql } from "@/lib/format";
import { toast } from "sonner";
import { getObjectInfo, type ObjectInfo } from "@/lib/api";

/// Format SQL in the editor: the selection if there is one, otherwise the whole
/// document. Applied via `executeEdits` → a single Ctrl+Z reverts it. If nothing
/// changes (already formatted) it's left alone; on invalid SQL the text is preserved + a toast.
function formatInEditor(ed: editor.IStandaloneCodeEditor) {
  const model = ed.getModel();
  if (!model) return;
  const sel = ed.getSelection();
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  const src = model.getValueInRange(range);
  if (!src.trim()) return;
  let formatted: string;
  try {
    formatted = formatSql(src);
  } catch {
    toast.error("Couldn't format — invalid SQL");
    return;
  }
  if (formatted.trimEnd() === src.trimEnd()) return; // already formatted
  ed.executeEdits("ariadne-format", [{ range, text: formatted, forceMoveMarkers: true }]);
  ed.pushUndoStop();
}

/// Line/column (1-based) of a character index in LF-normalized text.
function positionAt(text: string, index: number): { lineNumber: number; column: number } {
  let lineNumber = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) {
    lineNumber++;
    lineStart = i + 1;
  }
  return { lineNumber, column: index - lineStart + 1 };
}

/// Puts a snippet into the document and selects it: an existing identical copy is
/// reused; otherwise it is written on the cursor's line when that line is blank, or
/// on a new line right below it. Everything is compared in LF form because the model
/// may hold CRLF, where a line break is two characters.
function placeSnippetInEditor(ed: editor.IStandaloneCodeEditor, monaco: Monaco, raw: string) {
  const model = ed.getModel();
  const snippet = raw.trim().replace(/\r\n?/g, "\n");
  if (!model || !snippet) return null;
  const snippetLines = snippet.split("\n");

  const rangeFrom = (start: { lineNumber: number; column: number }) => {
    const endLine = start.lineNumber + snippetLines.length - 1;
    const lastLen = snippetLines[snippetLines.length - 1].length;
    const endColumn = snippetLines.length === 1 ? start.column + lastLen : lastLen + 1;
    return new monaco.Range(start.lineNumber, start.column, endLine, endColumn);
  };

  const doc = model.getValue(monaco.editor.EndOfLinePreference.LF);
  const found = doc.indexOf(snippet);
  let range;
  if (found !== -1) {
    range = rangeFrom(positionAt(doc, found));
  } else {
    const line = (ed.getPosition() ?? model.getFullModelRange().getEndPosition()).lineNumber;
    const lineEnd = model.getLineMaxColumn(line);
    const blank = model.getLineContent(line).trim() === "";
    const edit = blank
      ? { range: new monaco.Range(line, 1, line, lineEnd), text: snippet }
      : { range: new monaco.Range(line, lineEnd, line, lineEnd), text: `\n${snippet}` };
    ed.pushUndoStop();
    ed.executeEdits("ariadne-snippet", [{ ...edit, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    range = rangeFrom({ lineNumber: blank ? line : line + 1, column: 1 });
  }
  ed.setSelection(range);
  ed.revealRangeInCenterIfOutsideViewport(range);
  return {
    sql: model.getValueInRange(range),
    selectionOffset: model.getOffsetAt(range.getStartPosition()),
  };
}

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The connection this editor instance is bound to — comes from the tab, NOT the
   * global active connection (completion/peek/signature-help all use this). */
  connectionId: string | null;
  /** Triggered by Ctrl+Enter / Ctrl+E / F5 (SSMS-style). */
  onRun: () => void;
  /** Alt+F1 object info (null = the identifier at the cursor couldn't be resolved). */
  onPeek?: (info: ObjectInfo | null) => void;
  /** SQL error marker: byte offset + message. */
  marker?: { offset: number; message: string } | null;
  /** Editor font size (from settings). */
  fontSize?: number;
  /** UI theme; maps to Monaco's built-in "vs" (light) / "vs-dark". */
  theme?: "light" | "dark";
}

export function SqlEditor({ value, onChange, connectionId, onRun, onPeek, marker, fontSize = 13, theme = "dark" }: SqlEditorProps) {
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const peekRef = useRef(onPeek);
  peekRef.current = onPeek;
  const connIdRef = useRef(connectionId);
  connIdRef.current = connectionId;
  const edRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Tell the Monaco providers which connection to use while this editor is visible
  // (the providers are global at the language level; App renders only the active
  // tab's editor at a time — see lib/monaco/providers.ts).
  useEffect(() => {
    setActiveConnection(connectionId);
  }, [connectionId]);

  // Apply the error marker to the model (red underline + hover message).
  useEffect(() => {
    const ed = edRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model) return;
    if (!marker) {
      monaco.editor.setModelMarkers(model, "ariadne", []);
      return;
    }
    const pos = model.getPositionAt(marker.offset);
    monaco.editor.setModelMarkers(model, "ariadne", [
      {
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: pos.lineNumber,
        startColumn: pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: pos.column + 1,
      },
    ]);
  }, [marker]);

  // Apply the font size live when the setting changes.
  useEffect(() => {
    edRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Register a getter so the run path can read the selection while this editor is
  // visible. On unmount (tab change) it's cleared; the next mount re-registers it.
  useEffect(() => {
    return () => {
      setRunSelectionGetter(null);
      setFormatAction(null);
      setSnippetPlacer(null);
    };
  }, []);

  const handleMount: OnMount = (ed, monaco) => {
    edRef.current = ed;
    monacoRef.current = monaco;
    registerSqlProviders();

    // SSMS semantics: if there's a non-empty selection, run only it (with its offset);
    // otherwise null → the run uses the full text.
    setRunSelectionGetter(() => {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel || sel.isEmpty()) return null;
      const sql = model.getValueInRange(sel);
      if (!sql.trim()) return null;
      return { sql, selectionOffset: model.getOffsetAt(sel.getStartPosition()) };
    });

    setSnippetPlacer((sql) => placeSnippetInEditor(ed, monaco, sql));

    // Execution plan (SSMS: Ctrl+L). Replaces Monaco's "expand line selection"; with
    // Shift it runs EXPLAIN ANALYZE. Also offered in the right-click menu.
    ed.addAction({
      id: "ariadne.explain",
      label: "Explain Plan",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.6,
      run: () => explainActive(false),
    });
    ed.addAction({
      id: "ariadne.explainAnalyze",
      label: "Explain Analyze (runs the statement)",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.7,
      run: () => explainActive(true),
    });

    // Run: Ctrl+Enter + Ctrl+E + F5 (SSMS).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => runRef.current());
    ed.addCommand(monaco.KeyCode.F5, () => runRef.current());

    // Object info for the table/view at the cursor (SSMS Alt+F1). The identifier is
    // resolved from the schema cache; the panel then fetches index details lazily.
    const runObjectInfo = () => {
      void (async () => {
        const connId = connIdRef.current;
        const model = ed.getModel();
        if (!connId) {
          toast.message("Connect a database first");
          return;
        }
        if (!model) return;
        // With a selection, probe its END offset — it lands on the last identifier
        // (so a qualified "schema.table" still resolves the table, with the schema as
        // qualifier) and works regardless of the selection's direction.
        const sel = ed.getSelection();
        const pos = ed.getPosition();
        let offset: number | null = null;
        if (sel && !sel.isEmpty()) {
          offset = model.getOffsetAt(sel.getEndPosition());
        } else if (pos) {
          offset = model.getOffsetAt(pos);
        }
        if (offset == null) return;
        try {
          const info = await getObjectInfo(connId, model.getValue(), offset);
          if (info) peekRef.current?.(info);
          else toast.message("No table or view found at the cursor");
        } catch {
          toast.error("Couldn't load object info");
        }
      })();
    };

    // Expose it in the right-click menu and the F1 command palette (reliable triggers).
    ed.addAction({
      id: "ariadne.objectInfo",
      label: "Object Info (Alt+F1)",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.5,
      run: () => runObjectInfo(),
    });
    // Bind Alt+F1 at the DOM level (capture phase). Monaco ships a built-in Alt+F1
    // ("Show Accessibility Help") that shadows a plain addCommand keybinding, so the key
    // otherwise appears dead — intercept it before Monaco's keybinding service sees it.
    const domNode = ed.getDomNode();
    domNode?.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.altKey && e.key === "F1") {
          e.preventDefault();
          e.stopPropagation();
          runObjectInfo();
        }
      },
      true,
    );

    // Ctrl+D copies the line down (SSMS/VS); Monaco's "select next occurrence" moves
    // to Ctrl+Shift+D (multi-cursor isn't lost).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, () =>
      ed.trigger("ariadne", "editor.action.copyLinesDownAction", null),
    );
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD, () =>
      ed.trigger("ariadne", "editor.action.addSelectionToNextFindMatch", null),
    );

    // Ctrl+K: format SQL. When the editor is focused, Ctrl+K (deferred to Monaco by
    // shortcuts.ts's inEditor() → return) is bound to formatting here; OUTSIDE the
    // editor, global Ctrl+K stays the palette. Formats the selection if there is one,
    // otherwise the whole document; revertible with a single Ctrl+Z; on invalid SQL it
    // warns without touching the text.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => formatInEditor(ed));
    // For the palette's "Format SQL" access (in-editor Ctrl+K already works directly).
    setFormatAction(() => formatInEditor(ed));

    ed.focus();
  };

  const options: editor.IStandaloneEditorConstructionOptions = {
    fontSize,
    fontFamily:
      'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: "on",
    renderLineHighlight: "line",
    automaticLayout: true,
    padding: { top: 10, bottom: 10 },
    tabSize: 2,
    suggestSelection: "first",
    // Suggestions come from Rust; Monaco's word-based suggestions are disabled.
    wordBasedSuggestions: "off",
  };

  return (
    <Editor
      height="100%"
      defaultLanguage="ariadne-pgsql"
      theme={theme === "light" ? "ariadne-light" : "ariadne-dark"}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={options}
    />
  );
}
