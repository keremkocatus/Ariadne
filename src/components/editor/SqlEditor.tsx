import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { registerSqlProviders, setActiveConnection } from "@/lib/monaco/providers";
import { setRunSelectionGetter } from "@/lib/editorRun";
import { getObjectInfo, type ObjectInfo } from "@/lib/api";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Bu editör örneğinin bağlı olduğu bağlantı (design 12 §P1-M1) — tab'dan gelir,
   * global aktif bağlantıdan DEĞİL (completion/peek/signature-help hep bunu kullanır). */
  connectionId: string | null;
  /** Ctrl+Enter / Ctrl+E / F5 ile tetiklenir (design 07 §3, SSMS tarzı). */
  onRun: () => void;
  /** Alt+F1 nesne bilgisi (null = imleçteki identifier çözülemedi). */
  onPeek?: (info: ObjectInfo | null) => void;
  /** SQL hata marker'ı (design 05 hata sunumu): byte offset + mesaj. */
  marker?: { offset: number; message: string } | null;
}

export function SqlEditor({ value, onChange, connectionId, onRun, onPeek, marker }: SqlEditorProps) {
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const peekRef = useRef(onPeek);
  peekRef.current = onPeek;
  const connIdRef = useRef(connectionId);
  connIdRef.current = connectionId;
  const edRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Bu editör örneği görünürken Monaco provider'larının hangi bağlantıyı
  // kullanacağını bildirir (provider'lar dil-seviyesinde global; App bir seferde
  // yalnız aktif tab'ın editörünü render eder — bkz. lib/monaco/providers.ts).
  useEffect(() => {
    setActiveConnection(connectionId);
  }, [connectionId]);

  // Hata marker'ını modele işle (kırmızı alt çizgi + hover mesajı).
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

  // Bu editör görünürken çalıştırma yolunun seçimi okuyabilmesi için getter kaydı
  // (design 15 §P1-U2). Editör unmount olunca (tab değişince, bir sonraki mount
  // hemen yeniden kaydeder) temizlenir.
  useEffect(() => {
    return () => setRunSelectionGetter(null);
  }, []);

  const handleMount: OnMount = (ed, monaco) => {
    edRef.current = ed;
    monacoRef.current = monaco;
    registerSqlProviders();

    // SSMS semantiği: boş olmayan bir seçim varsa yalnız onu koştur (offset'iyle);
    // yoksa null → çalıştırma tam metni kullanır.
    setRunSelectionGetter(() => {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel || sel.isEmpty()) return null;
      const sql = model.getValueInRange(sel);
      if (!sql.trim()) return null;
      return { sql, selectionOffset: model.getOffsetAt(sel.getStartPosition()) };
    });

    // Çalıştırma: Ctrl+Enter (M0 kabul) + Ctrl+E + F5 (SSMS).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => runRef.current());
    ed.addCommand(monaco.KeyCode.F5, () => runRef.current());

    // Alt+F1: nesne bilgisi (design 07 §3). Cache'ten, DB round-trip yok.
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F1, () => {
      void (async () => {
        const connId = connIdRef.current;
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
