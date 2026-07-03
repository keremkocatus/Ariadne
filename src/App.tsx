import { useCallback, useState } from "react";
import { SqlEditor } from "./components/editor/SqlEditor";
import {
  isAriadneError,
  runQuery,
  type AriadneError,
  type RunResult,
  type StatementResult,
} from "./lib/api";

// M0 kabul kriteri: bu sorguyu yazıp Ctrl+Enter → sonucu gör.
const INITIAL_SQL = "SELECT version();";

export default function App() {
  const [sql, setSql] = useState(INITIAL_SQL);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<AriadneError | null>(null);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await runQuery(sql);
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(
        isAriadneError(e)
          ? e
          : { kind: "internal", message: String(e) },
      );
    } finally {
      setRunning(false);
    }
  }, [sql, running]);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Başlık şeridi */}
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-xs tracking-wide text-fg-muted">
          ariadne <span className="opacity-40">— M0</span>
        </span>
        <button
          onClick={run}
          disabled={running}
          className="rounded border border-border bg-bg-elev px-3 py-1 text-xs font-medium hover:border-fg-muted disabled:opacity-40"
          title="Ctrl+Enter / Ctrl+E"
        >
          {running ? "Running…" : "Run ▸"}
        </button>
      </header>

      {/* Editör */}
      <div className="min-h-0 flex-[3] border-b border-border">
        <SqlEditor value={sql} onChange={setSql} onRun={run} />
      </div>

      {/* Sonuç / hata — M0: ham <pre> (design 10 M0) */}
      <div className="min-h-0 flex-[2] overflow-auto bg-bg-elev p-3">
        {error ? (
          <ErrorView error={error} />
        ) : result ? (
          <ResultView result={result} />
        ) : (
          <p className="font-mono text-xs text-fg-muted">
            Sonuç burada görünecek. Ctrl+Enter ile çalıştır.
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorView({ error }: { error: AriadneError }) {
  return (
    <pre className="font-mono text-xs whitespace-pre-wrap text-danger">
      [{error.kind}
      {error.sqlstate ? ` ${error.sqlstate}` : ""}] {error.message}
      {error.hint ? `\nHINT: ${error.hint}` : ""}
      {error.detail ? `\n\n${error.detail}` : ""}
    </pre>
  );
}

function ResultView({ result }: { result: RunResult }) {
  return (
    <div className="space-y-4">
      {result.statements.map((s, i) => (
        <pre
          key={i}
          className="font-mono text-xs whitespace-pre text-fg"
        >
          {formatStatement(s)}
        </pre>
      ))}
      <p className="font-mono text-[11px] text-fg-muted">
        tx: {result.tx_status}
      </p>
    </div>
  );
}

function formatStatement(s: StatementResult): string {
  switch (s.kind) {
    case "affected":
      return `${s.command} — ${s.row_count} row(s)`;
    case "empty":
      return `${s.command}`;
    case "rows": {
      const header = s.columns.map((c) => c.name).join("\t");
      const sep = s.columns.map((c) => "─".repeat(c.name.length)).join("\t");
      const body = s.first_page.rows
        .map((row) => row.map((v) => (v === null ? "∅" : v)).join("\t"))
        .join("\n");
      const footer = `\n(${s.first_page.fetched_total} row(s), ${s.first_page.elapsed_ms} ms)`;
      return `${header}\n${sep}\n${body}${footer}`;
    }
  }
}
