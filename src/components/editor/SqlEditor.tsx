import Editor, { type OnMount } from "@monaco-editor/react";
import { useRef } from "react";
import type { editor } from "monaco-editor";
import { registerSqlProviders } from "@/lib/monaco/providers";
import { getObjectInfo, type ObjectInfo } from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl+Enter / Ctrl+E / F5 ile tetiklenir (design 07 §3, SSMS tarzı). */
  onRun: () => void;
  /** Alt+F1 nesne bilgisi (null = imleçteki identifier çözülemedi). */
  onPeek?: (info: ObjectInfo | null) => void;
}

export function SqlEditor({ value, onChange, onRun, onPeek }: SqlEditorProps) {
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const peekRef = useRef(onPeek);
  peekRef.current = onPeek;

  const handleMount: OnMount = (ed, monaco) => {
    registerSqlProviders();

    // Çalıştırma: Ctrl+Enter (M0 kabul) + Ctrl+E + F5 (SSMS).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => runRef.current());
    ed.addCommand(monaco.KeyCode.F5, () => runRef.current());

    // Alt+F1: nesne bilgisi (design 07 §3). Cache'ten, DB round-trip yok.
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F1, () => {
      void (async () => {
        const connId = useConnectionStore.getState().activeConnectionId;
        const model = ed.getModel();
        const pos = ed.getPosition();
        if (!connId || !model || !pos) return;
        try {
          const info = await getObjectInfo(connId, model.getValue(), model.getOffsetAt(pos));
          peekRef.current?.(info);
        } catch {
          peekRef.current?.(null);
        }
      })();
    });

    // Ctrl+D satırı aşağı kopyala (SSMS/VS); Monaco'nun "select next occurrence"ı
    // Ctrl+Shift+D'ye taşınır (multi-cursor kaybolmaz) — design 07 §3.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, () =>
      ed.trigger("ariadne", "editor.action.copyLinesDownAction", null),
    );
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD, () =>
      ed.trigger("ariadne", "editor.action.addSelectionToNextFindMatch", null),
    );

    ed.focus();
  };

  const options: editor.IStandaloneEditorConstructionOptions = {
    fontSize: 13,
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
    // Öneriler Rust'tan; Monaco'nun kelime-tabanlı önerisi kapalı (design 04).
    wordBasedSuggestions: "off",
  };

  return (
    <Editor
      height="100%"
      defaultLanguage="pgsql"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={options}
    />
  );
}
