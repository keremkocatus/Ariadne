// The Details view for one relation: everything the catalog knows about it, on
// tabs. Opened from the Explorer (right-click → View details, or the peek panel's
// expand button). Reads on demand — nothing here is cached.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Copy, KeyRound, RefreshCw, Search, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Chip, EmptyState, IconButton } from "@/components/ui/primitives";
import { relationIcon } from "@/components/explorer/icons";
import {
  getRelationFull,
  isAriadneError,
  type ConstraintKind,
  type IndexInfo,
  type RelationFull,
} from "@/lib/api";
import { buildDdl } from "@/lib/ddl";
import { copyText } from "@/lib/clipboard";
import { formatBytes } from "@/lib/format";
import {
  formatBound,
  formatCount,
  formatTimestamp,
  parsePgTimestamp,
  qualifiedName,
  relativeTime,
} from "@/lib/pgFormat";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabsStore";
import { useUiStore, type DetailsTarget } from "@/stores/uiStore";

type TabId = "columns" | "indexes" | "constraints" | "triggers" | "partitions" | "definition";

const KIND_LABELS: Record<RelationFull["kind"], string> = {
  table: "table",
  view: "view",
  mat_view: "materialized view",
  foreign: "foreign table",
  partitioned: "partitioned table",
  sequence: "sequence",
  other: "relation",
};

const CONSTRAINT_LABELS: Record<ConstraintKind, string> = {
  primary_key: "primary key",
  unique: "unique",
  check: "check",
  foreign_key: "foreign key",
  exclusion: "exclusion",
  other: "constraint",
};

export function RelationDetailsDialog() {
  const target = useUiStore((s) => s.detailsTarget);
  const setTarget = useUiStore((s) => s.setDetailsTarget);
  return (
    <Dialog open={target != null} onOpenChange={(open) => !open && setTarget(null)}>
      {target && (
        <DialogContent className="flex h-[84vh] w-[980px] max-w-[94vw] flex-col gap-0 p-0" hideClose>
          {/* Keyed by relation so navigating to another one starts from a clean state. */}
          <DetailsBody
            key={`${target.connectionId}:${target.schema}.${target.name}`}
            target={target}
            onNavigate={(schema, name) => setTarget({ ...target, schema, name })}
            onClose={() => setTarget(null)}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function DetailsBody({
  target,
  onNavigate,
  onClose,
}: {
  target: DetailsTarget;
  onNavigate: (schema: string, name: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<RelationFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("columns");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getRelationFull(target.connectionId, target.schema, target.name)
      .then(setData)
      .catch((e) => setError(isAriadneError(e) ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [target.connectionId, target.schema, target.name]);
  useEffect(load, [load]);

  const openData = () => {
    const tabs = useTabsStore.getState();
    const id = tabs.addTab(
      `SELECT * FROM ${qualifiedName(target.schema, target.name)} LIMIT 500;`,
      target.connectionId,
    );
    void tabs.run(id);
    onClose();
  };

  const tabs = useMemo(() => {
    if (!data) return [];
    const isQuery = data.kind === "view" || data.kind === "mat_view";
    const list: { id: TabId; label: string; count?: number }[] = [
      { id: "columns", label: "Columns", count: data.columns.length },
    ];
    if (data.kind !== "view" && data.kind !== "sequence") {
      list.push({ id: "indexes", label: "Indexes", count: data.indexes.length });
    }
    if (!isQuery && data.kind !== "sequence") {
      list.push({
        id: "constraints",
        label: "Constraints",
        count: data.constraints.length + data.referenced_by.length,
      });
    }
    if (data.kind !== "sequence") {
      list.push({ id: "triggers", label: "Triggers", count: data.triggers.length });
    }
    if (data.partitions.length > 0) {
      list.push({ id: "partitions", label: "Partitions", count: data.partitions.length });
    }
    list.push({ id: "definition", label: isQuery ? "Definition" : "DDL" });
    return list;
  }, [data]);

  return (
    <>
      <header className="shrink-0 border-b border-border px-5 pb-3 pt-4">
        <div className="flex items-center gap-2">
          {relationIcon(data?.kind, 16)}
          <DialogTitle className="min-w-0 truncate text-[15px]">
            <span className="font-normal text-fg-muted">{target.schema}.</span>
            {target.name}
          </DialogTitle>
          {data && <Chip>{KIND_LABELS[data.kind]}</Chip>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {data && data.kind !== "sequence" && (
              <button
                onClick={openData}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs transition-colors hover:bg-bg-hover"
              >
                <Table2 size={12} /> Open data
              </button>
            )}
            <IconButton
              title="Copy qualified name"
              onClick={() => void copyText(`${target.schema}.${target.name}`, "Name copied")}
            >
              <Copy size={13} />
            </IconButton>
            <IconButton title="Reload" onClick={load} disabled={loading}>
              <RefreshCw size={13} className={cn(loading && "animate-spin")} />
            </IconButton>
            <DialogClose asChild>
              <IconButton title="Close (Esc)">
                <X size={14} />
              </IconButton>
            </DialogClose>
          </div>
        </div>
        <DialogDescription className="mt-1 truncate">
          {data ? (
            <>
              owner <span className="text-fg">{data.owner}</span>
              {data.partition_of && (
                <>
                  {" · partition of "}
                  <button
                    className="font-mono text-fg underline-offset-2 hover:underline"
                    onClick={() => onNavigate(data.partition_of!.schema, data.partition_of!.name)}
                  >
                    {data.partition_of.schema}.{data.partition_of.name}
                  </button>
                  {" · "}
                  {formatBound(data.partition_bound)}
                </>
              )}
              {data.partition_key && <> · partitioned by {data.partition_key}</>}
              {data.comment && <> · {data.comment}</>}
            </>
          ) : (
            "Reading the catalog…"
          )}
        </DialogDescription>
        {data && <StatTiles data={data} />}
      </header>

      {error ? (
        <EmptyState className="p-5 text-danger">{error}</EmptyState>
      ) : !data ? (
        <EmptyState className="p-5">Loading…</EmptyState>
      ) : (
        <>
          <nav className="flex shrink-0 gap-1 border-b border-border px-4" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-2 py-2 text-xs transition-colors",
                  tab === t.id
                    ? "border-fg text-fg"
                    : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {t.label}
                {t.count != null && (
                  <span className="rounded-full bg-fg/8 px-1.5 text-[10px] tabular-nums text-fg-muted">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "columns" && <ColumnsTab data={data} />}
            {tab === "indexes" && <IndexesTab indexes={data.indexes} />}
            {tab === "constraints" && <ConstraintsTab data={data} onNavigate={onNavigate} />}
            {tab === "triggers" && <TriggersTab data={data} />}
            {tab === "partitions" && <PartitionsTab data={data} onNavigate={onNavigate} />}
            {tab === "definition" && (
              <DefinitionTab data={data} connectionId={target.connectionId} onClose={onClose} />
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---- Header stats ----

function StatTiles({ data }: { data: RelationFull }) {
  // A partitioned parent stores nothing itself: its numbers are the sum of its leaves.
  const leaves = data.partitions.filter((p) => p.is_leaf);
  const partitioned = data.kind === "partitioned";
  const rows = partitioned
    ? leaves.reduce((n, p) => n + Math.max(0, p.estimated_rows), 0)
    : data.estimated_rows;
  const total = partitioned ? leaves.reduce((n, p) => n + p.size_bytes, 0) : data.total_bytes;
  const stats = data.stats;
  const lastOf = (a?: string | null, b?: string | null) => {
    const da = parsePgTimestamp(a);
    const db = parsePgTimestamp(b);
    if (da && db) return da > db ? da : db;
    return da ?? db;
  };
  const deadPct =
    stats && stats.live_rows + stats.dead_rows > 0
      ? (stats.dead_rows / (stats.live_rows + stats.dead_rows)) * 100
      : 0;

  if (data.kind === "view" || data.kind === "sequence") return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Tile label="Rows (est.)" value={rows < 0 ? "not analyzed" : `~${formatCount(rows)}`} title={rows >= 0 ? rows.toLocaleString() : undefined} />
      <Tile label="Total size" value={formatBytes(total)} />
      {!partitioned && (
        <>
          <Tile label="Table" value={formatBytes(data.table_bytes)} title="Heap + TOAST" />
          <Tile label="Indexes" value={formatBytes(data.index_bytes)} />
        </>
      )}
      {partitioned && <Tile label="Partitions" value={String(leaves.length)} />}
      {stats && !partitioned && (
        <>
          <Tile
            label="Dead rows"
            value={`${formatCount(stats.dead_rows)}${deadPct >= 1 ? ` · ${deadPct.toFixed(0)}%` : ""}`}
            tone={deadPct >= 20 ? "warn" : undefined}
            title="Rows deleted or updated but not yet vacuumed"
          />
          <Tile
            label="Scans"
            value={`${formatCount(stats.seq_scans)} seq · ${formatCount(stats.index_scans ?? 0)} idx`}
            title="Sequential vs index scans since the last stats reset"
          />
          <Tile
            label="Last vacuum"
            value={relativeTime(lastOf(stats.last_vacuum, stats.last_autovacuum))}
            title={`manual: ${formatTimestamp(stats.last_vacuum)}\nauto: ${formatTimestamp(stats.last_autovacuum)}`}
          />
          <Tile
            label="Last analyze"
            value={relativeTime(lastOf(stats.last_analyze, stats.last_autoanalyze))}
            title={`manual: ${formatTimestamp(stats.last_analyze)}\nauto: ${formatTimestamp(stats.last_autoanalyze)}`}
          />
        </>
      )}
    </div>
  );
}

function Tile({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: "warn" }) {
  return (
    <div className="min-w-[92px] rounded-lg border border-border bg-bg px-2.5 py-1.5" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={cn("mt-0.5 text-xs font-medium tabular-nums", tone === "warn" && "text-warn")}>{value}</div>
    </div>
  );
}

// ---- Tabs ----

const TH = "sticky top-0 z-[1] border-b border-border bg-bg-elev px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-fg-muted";
const TD = "border-b border-border/50 px-3 py-1.5 align-top";

function ColumnsTab({ data }: { data: RelationFull }) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const cols = q
    ? data.columns.filter((c) => c.name.toLowerCase().includes(q) || c.type_name.toLowerCase().includes(q))
    : data.columns;
  const anyComment = data.columns.some((c) => c.comment);
  return (
    <>
      {data.columns.length > 12 && (
        <div className="relative border-b border-border px-3 py-2">
          <Search size={12} className="absolute left-5 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or type…"
            className="w-64 rounded-md border border-border bg-bg py-1 pl-6 pr-2 text-xs outline-none placeholder:text-fg-subtle focus:border-border-strong"
          />
        </div>
      )}
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className={cn(TH, "w-10 text-right")}>#</th>
            <th className={TH}>Name</th>
            <th className={TH}>Type</th>
            <th className={TH}>Nullable</th>
            <th className={TH}>Default</th>
            {anyComment && <th className={TH}>Comment</th>}
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name} className="hover:bg-bg-hover/60">
              <td className={cn(TD, "text-right tabular-nums text-fg-subtle")}>
                {data.columns.indexOf(c) + 1}
              </td>
              <td className={cn(TD, "font-mono")}>
                <span className="inline-flex items-center gap-1.5">
                  {c.is_pk && <KeyRound size={11} className="shrink-0 text-warn" />}
                  {c.name}
                </span>
              </td>
              <td className={cn(TD, "font-mono text-fg-muted")}>{c.type_name}</td>
              <td className={TD}>
                {c.not_null ? <span className="text-fg-muted">not null</span> : <span className="text-fg-subtle">nullable</span>}
              </td>
              <td className={cn(TD, "max-w-[280px] break-words font-mono text-[11px] text-fg-muted")}>
                {c.identity ? (
                  <Chip>identity {c.identity === "always" ? "always" : "by default"}</Chip>
                ) : c.is_generated ? (
                  <>
                    <Chip>generated</Chip> {c.default_expr}
                  </>
                ) : (
                  (c.default_expr ?? <span className="text-fg-subtle">—</span>)
                )}
              </td>
              {anyComment && <td className={cn(TD, "max-w-[260px] text-fg-muted")}>{c.comment}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {cols.length === 0 && <EmptyState>No columns match</EmptyState>}
    </>
  );
}

function IndexBadges({ ix }: { ix: IndexInfo }) {
  return (
    <>
      {ix.is_primary ? <Chip tone="warn">primary</Chip> : ix.is_unique ? <Chip tone="strong">unique</Chip> : null}
      {!ix.is_valid && <Chip tone="danger">invalid</Chip>}
    </>
  );
}

function IndexesTab({ indexes }: { indexes: IndexInfo[] }) {
  if (indexes.length === 0) return <EmptyState className="p-5">No indexes</EmptyState>;
  return (
    <table className="w-full border-separate border-spacing-0 text-xs">
      <thead>
        <tr>
          <th className={TH}>Name</th>
          <th className={TH}>Method</th>
          <th className={TH}>Columns</th>
          <th className={cn(TH, "text-right")}>Size</th>
          <th className={cn(TH, "text-right")}>Scans</th>
          <th className={cn(TH, "w-8")} />
        </tr>
      </thead>
      <tbody>
        {indexes.map((ix) => (
          <tr key={ix.name} className="hover:bg-bg-hover/60">
            <td className={cn(TD, "font-mono")}>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {ix.name}
                <IndexBadges ix={ix} />
              </span>
            </td>
            <td className={cn(TD, "text-fg-muted")}>{ix.method}</td>
            <td className={TD}>
              <div className="flex flex-wrap gap-1">
                {ix.key_columns.map((c, i) => (
                  <code key={i} className="rounded bg-fg/8 px-1.5 py-px font-mono text-[11px]">
                    {c}
                  </code>
                ))}
                {ix.include_columns.map((c, i) => (
                  <code
                    key={`inc-${i}`}
                    className="rounded border border-dashed border-border-strong px-1.5 py-px font-mono text-[11px] text-fg-muted"
                    title="INCLUDE column (stored in the index, not part of the key)"
                  >
                    {c}
                  </code>
                ))}
              </div>
              {ix.predicate && (
                <div className="mt-1 font-mono text-[11px] text-fg-muted">
                  <span className="text-fg-subtle">where</span> {ix.predicate}
                </div>
              )}
            </td>
            <td className={cn(TD, "whitespace-nowrap text-right tabular-nums text-fg-muted")}>
              {formatBytes(ix.size_bytes)}
            </td>
            <td
              className={cn(
                TD,
                "text-right tabular-nums",
                ix.scans === 0 && !ix.is_primary && !ix.is_unique ? "text-warn" : "text-fg-muted",
              )}
              title={ix.scans === 0 ? "Never used since the last stats reset" : undefined}
            >
              {ix.scans == null ? "—" : formatCount(ix.scans)}
            </td>
            <td className={TD}>
              <IconButton
                className="h-5 w-5"
                title="Copy CREATE INDEX"
                onClick={() => void copyText(`${ix.definition};`, "Definition copied")}
              >
                <Copy size={11} />
              </IconButton>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConstraintsTab({
  data,
  onNavigate,
}: {
  data: RelationFull;
  onNavigate: (schema: string, name: string) => void;
}) {
  const goTo = (dotted: string) => {
    const [schema, ...rest] = dotted.split(".");
    onNavigate(schema, rest.join("."));
  };
  if (data.constraints.length === 0 && data.referenced_by.length === 0) {
    return <EmptyState className="p-5">No constraints</EmptyState>;
  }
  return (
    <>
      {data.constraints.length > 0 && (
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className={TH}>Name</th>
              <th className={TH}>Type</th>
              <th className={TH}>Definition</th>
            </tr>
          </thead>
          <tbody>
            {data.constraints.map((c) => (
              <tr key={c.name} className="hover:bg-bg-hover/60">
                <td className={cn(TD, "font-mono")}>{c.name}</td>
                <td className={cn(TD, "whitespace-nowrap")}>
                  <Chip tone={c.kind === "primary_key" ? "warn" : "neutral"}>{CONSTRAINT_LABELS[c.kind]}</Chip>
                </td>
                <td className={cn(TD, "font-mono text-[11px] text-fg-muted")}>
                  {c.definition}
                  {c.ref_table && (
                    <button
                      className="ml-2 inline-flex items-center gap-0.5 text-fg hover:underline"
                      onClick={() => goTo(c.ref_table!)}
                      title={`Open ${c.ref_table}`}
                    >
                      <ArrowUpRight size={11} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.referenced_by.length > 0 && (
        <>
          <h3 className="border-b border-border px-3 pb-1.5 pt-4 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
            Referenced by <span className="font-normal text-fg-subtle">{data.referenced_by.length}</span>
          </h3>
          <table className="w-full border-separate border-spacing-0 text-xs">
            <tbody>
              {data.referenced_by.map((fk) => (
                <tr key={`${fk.table}.${fk.name}`} className="hover:bg-bg-hover/60">
                  <td className={cn(TD, "font-mono")}>
                    <button className="hover:underline" onClick={() => goTo(fk.table)}>
                      {fk.table}
                    </button>
                  </td>
                  <td className={cn(TD, "font-mono text-fg-muted")}>{fk.name}</td>
                  <td className={cn(TD, "font-mono text-[11px] text-fg-muted")}>{fk.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function TriggersTab({ data }: { data: RelationFull }) {
  if (data.triggers.length === 0) return <EmptyState className="p-5">No triggers</EmptyState>;
  return (
    <table className="w-full border-separate border-spacing-0 text-xs">
      <thead>
        <tr>
          <th className={TH}>Name</th>
          <th className={TH}>Timing</th>
          <th className={TH}>Events</th>
          <th className={TH}>For each</th>
          <th className={TH}>Function</th>
          <th className={cn(TH, "w-8")} />
        </tr>
      </thead>
      <tbody>
        {data.triggers.map((t) => (
          <tr key={t.name} className="hover:bg-bg-hover/60">
            <td className={cn(TD, "font-mono")}>
              <span className="inline-flex items-center gap-1.5">
                {t.name}
                {!t.enabled && <Chip tone="danger">disabled</Chip>}
              </span>
            </td>
            <td className={cn(TD, "text-fg-muted")}>{t.timing.toLowerCase()}</td>
            <td className={TD}>
              <div className="flex flex-wrap gap-1">
                {t.events.split(", ").map((e) => (
                  <Chip key={e}>{e}</Chip>
                ))}
              </div>
            </td>
            <td className={cn(TD, "text-fg-muted")}>{t.level.toLowerCase()}</td>
            <td className={cn(TD, "font-mono text-fg-muted")}>{t.function}()</td>
            <td className={TD}>
              <IconButton
                className="h-5 w-5"
                title="Copy CREATE TRIGGER"
                onClick={() => void copyText(`${t.definition};`, "Definition copied")}
              >
                <Copy size={11} />
              </IconButton>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartitionsTab({
  data,
  onNavigate,
}: {
  data: RelationFull;
  onNavigate: (schema: string, name: string) => void;
}) {
  const leaves = data.partitions.filter((p) => p.is_leaf);
  const maxSize = Math.max(1, ...leaves.map((p) => p.size_bytes));
  const totalSize = leaves.reduce((n, p) => n + p.size_bytes, 0);
  const totalRows = leaves.reduce((n, p) => n + Math.max(0, p.estimated_rows), 0);
  return (
    <>
      <div className="border-b border-border px-3 py-2 text-xs text-fg-muted">
        Partitioned by <code className="font-mono text-fg">{data.partition_key}</code> ·{" "}
        {leaves.length} partition{leaves.length === 1 ? "" : "s"} · ~{formatCount(totalRows)} rows ·{" "}
        {formatBytes(totalSize)}
      </div>
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className={TH}>Partition</th>
            <th className={TH}>Bound</th>
            <th className={cn(TH, "text-right")}>Rows (est.)</th>
            <th className={cn(TH, "w-[220px]")}>Size</th>
          </tr>
        </thead>
        <tbody>
          {data.partitions.map((p) => (
            <tr key={`${p.schema}.${p.name}`} className="hover:bg-bg-hover/60">
              <td className={cn(TD, "font-mono")}>
                <button
                  className="hover:underline"
                  style={{ paddingLeft: (p.level - 1) * 14 }}
                  onClick={() => onNavigate(p.schema, p.name)}
                >
                  {p.name}
                </button>
                {!p.is_leaf && <Chip className="ml-1.5">sub-partitioned</Chip>}
              </td>
              <td className={cn(TD, "font-mono text-[11px] text-fg-muted")} title={p.bound ?? undefined}>
                {formatBound(p.bound)}
              </td>
              <td className={cn(TD, "text-right tabular-nums text-fg-muted")}>
                {p.is_leaf ? (p.estimated_rows < 0 ? "—" : p.estimated_rows.toLocaleString()) : ""}
              </td>
              <td className={TD}>
                {p.is_leaf && (
                  <div className="flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-fg/8">
                      <div
                        className="h-full rounded-full bg-fg-muted"
                        style={{ width: `${Math.max(p.size_bytes > 0 ? 2 : 0, (p.size_bytes / maxSize) * 100)}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
                      {formatBytes(p.size_bytes)}
                    </span>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DefinitionTab({
  data,
  connectionId,
  onClose,
}: {
  data: RelationFull;
  connectionId: string;
  onClose: () => void;
}) {
  const ddl = useMemo(() => buildDdl(data), [data]);
  const isQuery = data.kind === "view" || data.kind === "mat_view";
  const openInTab = () => {
    const tabs = useTabsStore.getState();
    const id = tabs.addTab(ddl, connectionId);
    tabs.renameTab(id, data.name);
    toast.message("Opened in a new tab — nothing was run");
    onClose();
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="flex-1 truncate">
          {isQuery
            ? "The stored query, as Postgres prints it."
            : "Reconstructed from the catalog — a readable starting point, not a byte-exact dump."}
        </span>
        <button
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-bg-hover hover:text-fg"
          onClick={() => void copyText(ddl, "Copied")}
        >
          <Copy size={11} /> Copy
        </button>
        <button
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-bg-hover hover:text-fg"
          onClick={openInTab}
        >
          <ArrowUpRight size={11} /> Open in tab
        </button>
      </div>
      <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre p-4 font-mono text-[12px] leading-relaxed text-fg">
        {ddl}
      </pre>
    </div>
  );
}
