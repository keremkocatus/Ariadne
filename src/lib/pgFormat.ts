// Compact renderings of catalog text for narrow UI: type names, partition bounds,
// timestamps. Pure functions.

const TYPE_ALIASES: [RegExp, string][] = [
  [/^character varying/, "varchar"],
  [/^character/, "char"],
  [/^timestamp(\(\d+\))? with time zone/, "timestamptz$1"],
  [/^timestamp(\(\d+\))? without time zone/, "timestamp$1"],
  [/^time(\(\d+\))? with time zone/, "timetz$1"],
  [/^time(\(\d+\))? without time zone/, "time$1"],
  [/^double precision/, "float8"],
  [/^boolean/, "bool"],
  [/^integer/, "int4"],
  [/^bigint/, "int8"],
  [/^smallint/, "int2"],
];

/// `character varying(10)` → `varchar(10)`, `timestamp with time zone` →
/// `timestamptz`. Array suffixes and modifiers are preserved.
export function shortType(typeName: string): string {
  for (const [pattern, alias] of TYPE_ALIASES) {
    if (pattern.test(typeName)) return typeName.replace(pattern, alias);
  }
  return typeName;
}

/// Unquotes one literal of a partition bound and drops a midnight time part, which
/// is noise for the usual day/month/year ranges.
function boundValue(raw: string): string {
  const v = raw.trim().replace(/^'(.*)'$/s, "$1").replace(/''/g, "'");
  return v.replace(/^(\d{4}-\d{2}-\d{2}) 00:00:00(\.0+)?([+-]\d{2}(:\d{2})?)?$/, "$1");
}

/// Splits a parenthesized value list on top-level commas (quotes respected).
function splitValues(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (ch === "," && !quoted && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map(boundValue);
}

/// A partition bound as `pg_get_expr(relpartbound)` prints it, shortened for a tree
/// row or table cell:
///   FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00') → 2026-11-01 → 2026-12-01
///   FOR VALUES IN ('eu', 'uk') → eu, uk
///   FOR VALUES WITH (modulus 4, remainder 0) → hash 0/4
///   DEFAULT → default
export function formatBound(bound: string | null | undefined): string {
  if (!bound) return "";
  const b = bound.trim();
  if (/^DEFAULT$/i.test(b)) return "default";
  const range = /^FOR VALUES FROM \((.*)\) TO \((.*)\)$/is.exec(b);
  if (range) return `${splitValues(range[1]).join(", ")} → ${splitValues(range[2]).join(", ")}`;
  const list = /^FOR VALUES IN \((.*)\)$/is.exec(b);
  if (list) return splitValues(list[1]).join(", ");
  const hash = /^FOR VALUES WITH \(modulus (\d+), remainder (\d+)\)$/i.exec(b);
  if (hash) return `hash ${hash[2]}/${hash[1]}`;
  return b.replace(/^FOR VALUES\s+/i, "");
}

/// A partition's name without the parent's name as prefix (`event_logs_y2026m11`
/// under `event_logs` → `y2026m11`). Falls back to the full name when it doesn't
/// follow that convention.
export function partitionLabel(name: string, parentName: string): string {
  for (const sep of ["_", "-", "$"]) {
    const prefix = parentName + sep;
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  }
  return name;
}

/// Row-count estimate for display: 1234 → 1.2K. Negative (never analyzed) → "—".
export function formatCount(n: number): string {
  if (n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/// Parses a timestamptz as Postgres prints it (`2026-11-15 03:00:00.12+00`). The
/// space separator and the hour-only offset are not valid ISO 8601, so they are
/// normalized first.
export function parsePgTimestamp(text: string | null | undefined): Date | null {
  if (!text) return null;
  const iso = text
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/// "3m ago" / "in 2h" for a past or future instant; a date for anything older.
export function relativeTime(date: Date | null, now = Date.now()): string {
  if (!date) return "—";
  const diff = now - date.getTime();
  const abs = Math.abs(diff);
  const fmt = (n: number, unit: string) => (diff >= 0 ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (abs < 60_000) return diff >= 0 ? "just now" : "in <1m";
  if (abs < 3_600_000) return fmt(Math.floor(abs / 60_000), "m");
  if (abs < 86_400_000) return fmt(Math.floor(abs / 3_600_000), "h");
  if (abs < 30 * 86_400_000) return fmt(Math.floor(abs / 86_400_000), "d");
  return date.toLocaleDateString();
}

export function formatTimestamp(text: string | null | undefined): string {
  const d = parsePgTimestamp(text);
  return d ? d.toLocaleString() : (text ?? "—");
}

/// Double-quotes an identifier unless it is a plain lower-case name that needs none.
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/// Always-quoted form, for generated statements where predictability beats brevity.
export function quoteIdentAlways(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  const quoted = value.replace(/'/g, "''");
  // A plain '…' literal treats a backslash as an escape when the server runs with
  // standard_conforming_strings = off. The E'…' form means the same under either
  // setting, so it is used whenever a backslash is present.
  return value.includes("\\") ? `E'${quoted.replace(/\\/g, "\\\\")}'` : `'${quoted}'`;
}

export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdentAlways(schema)}.${quoteIdentAlways(name)}`;
}
