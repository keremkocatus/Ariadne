import type { AriadneError, RunResult, StatementResult } from "@/lib/api";

// A simple text/table result view (<pre>). The virtualized grid is ResultGrid.

export function ResultView({
  result,
  error,
}: {
  result: RunResult | null;
  error: AriadneError | null;
}) {
  if (error) {
    return (
      <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-danger">
        [{error.kind}
        {error.sqlstate ? ` ${error.sqlstate}` : ""}] {error.message}
        {error.hint ? `\nHINT: ${error.hint}` : ""}
        {error.detail ? `\n\n${error.detail}` : ""}
      </pre>
    );
  }
  if (!result) {
    return <p className="p-3 font-mono text-xs text-fg-muted">Results will appear here. Run with Ctrl+Enter.</p>;
  }
  return (
    <div className="space-y-3 p-3">
      {result.statements.map((s, i) => (
        <StatementBlock key={i} s={s} />
      ))}
      <p className="font-mono text-[10px] text-fg-muted">tx: {result.tx_status}</p>
    </div>
  );
}

function StatementBlock({ s }: { s: StatementResult }) {
  if (s.kind === "affected") {
    return <p className="font-mono text-xs">{`${s.command} — ${s.row_count} row(s)`}</p>;
  }
  if (s.kind === "empty") {
    return <p className="font-mono text-xs text-fg-muted">{s.command}</p>;
  }
  return (
    <div className="overflow-auto">
      <table className="border-collapse font-mono text-xs">
        <thead>
          <tr>
            {s.columns.map((c) => (
              <th key={c.name} className="border border-border px-2 py-0.5 text-left font-medium">
                {c.name}
                <span className="ml-1 text-[10px] text-fg-muted">{c.type_name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.first_page.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((v, ci) => (
                <td key={ci} className="border border-border px-2 py-0.5">
                  {v === null ? <span className="italic text-fg-muted">NULL</span> : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 font-mono text-[10px] text-fg-muted">
        {s.first_page.fetched_total} row(s) · {s.first_page.elapsed_ms} ms
      </p>
    </div>
  );
}
