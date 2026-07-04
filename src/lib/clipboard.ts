// Grid'den zengin kopyalama biçimlendiricileri (design 17 §P1-V2 Ö3). Saf
// fonksiyonlar: girdi başlık dizisi + hücre matrisi, çıktı metin. ResultGrid'in
// context menüsü ve footer'ı bu tek kaynaktan geçer. (İleride vitest gelirse ilk
// müşteriler bunlar.)

type Cell = string | null;

function delimitedEscape(v: Cell, sep: "," | "\t"): string {
  if (v === null) return "";
  // CSV: virgül/tırnak/yeni satır içeren değer tırnaklanır, iç tırnak ikizlenir.
  // TSV'de tırnaklama yoktur (Excel/Sheets tab'ı ayraç, tırnağı literal alır).
  if (sep === "," && /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toDelimited(headers: string[], rows: Cell[][], sep: "," | "\t"): string {
  const head = headers.map((h) => delimitedEscape(h, sep)).join(sep);
  const body = rows.map((r) => r.map((v) => delimitedEscape(v, sep)).join(sep)).join("\n");
  return rows.length ? `${head}\n${body}` : head;
}

export function toJson(headers: string[], rows: Cell[][]): string {
  // Not: hücreler string|null; sayılar da string kalır (backend tip bilgisi
  // grid'e taşınmıyor — design 17 §P1-V2 bilinçli kabul).
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
  // toast import'u burada tutulur (formatlayıcılar saf kalsın).
  const { toast } = await import("sonner");
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okLabel);
  } catch {
    toast.error("Copy failed");
  }
}
