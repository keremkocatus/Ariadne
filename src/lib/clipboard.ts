// Rich-copy formatters for the grid. Pure functions: input is a header array + a cell
// matrix, output is text. The ResultGrid context menu and footer both go through this
// single source.

type Cell = string | null;

function delimitedEscape(v: Cell, sep: "," | "\t"): string {
  if (v === null) return "";
  // CSV: a value containing comma/quote/newline is quoted, with inner quotes doubled.
  // TSV has no quoting (Excel/Sheets treat tab as the separator and quotes as literal).
  if (sep === "," && /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toDelimited(headers: string[], rows: Cell[][], sep: "," | "\t"): string {
  const head = headers.map((h) => delimitedEscape(h, sep)).join(sep);
  const body = rows.map((r) => r.map((v) => delimitedEscape(v, sep)).join(sep)).join("\n");
  return rows.length ? `${head}\n${body}` : head;
}

export function toJson(headers: string[], rows: Cell[][]): string {
  // Note: cells are string|null; numbers stay as strings too (the backend type info
  // isn't carried to the grid — a deliberate tradeoff).
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null]))),
    null,
    2,
  );
}

export function toMarkdown(headers: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${headers.map(esc).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${headers.map((_, i) => esc(r[i])).join(" | ")} |`).join("\n");
  return rows.length ? `${head}\n${rule}\n${body}` : `${head}\n${rule}`;
}

export async function copyText(text: string, okLabel: string): Promise<void> {
  // Import toast here so the formatters stay pure.
  const { toast } = await import("sonner");
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okLabel);
  } catch {
    toast.error("Copy failed");
  }
}
