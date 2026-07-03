import Editor, { type OnMount } from "@monaco-editor/react";
import { useRef } from "react";
import type { editor } from "monaco-editor";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl+Enter / Ctrl+E ile tetiklenir (design 07 §3, SSMS tarzı). */
  onRun: () => void;
}

export function SqlEditor({ value, onChange, onRun }: SqlEditorProps) {
  // onRun'ın en güncel referansını monaco komutunun içinden okuyabilmek için ref.
  const runRef = useRef(onRun);
  runRef.current = onRun;

  const handleMount: OnMount = (ed, monaco) => {
    // Çalıştırma kısayolları: Ctrl+Enter (M0 kabul) + Ctrl+E (SSMS tarzı).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      runRef.current(),
    );
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () =>
      runRef.current(),
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
    // M0: dil servisi/completion yok — sade editör.
    quickSuggestions: false,
    wordBasedSuggestions: "off",
  };

  return (
    <Editor
      height="100%"
      defaultLanguage="sql"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={options}
    />
  );
}
