// The Explorer bottom panel: a relation's columns (instant, from the cache) +
// indexes/triggers/size (loaded lazily on demand). Built for a narrow sidebar:
// every row is name-left / detail-right and truncates instead of wrapping.
import { useEffect, useMemo, useState } from "react";
import { KeyRound, Maximize2, X } from "lucide-react";
import {
  getRelationDetails,
  type IndexInfo,
  type RelationDetails,
  type SchemaSnapshot,
  type SnapRel,
  type TriggerInfo,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { formatBound, formatCount, partitionLabel, shortType } from "@/lib/pgFormat";
import { Chip, IconButton, Section } from "@/components/ui/primitives";
import { relationIcon } from "./icons";
import { findParent, findPartitions } from "./tree";

interface Props {
  schema: string;
  rel: SnapRel;
  connectionId: string | null;
  snapshot: SchemaSnapshot;
  onClose: () => void;
  /** Opens the full Details view for this relation. */
  onDetails: () => void;
  /** Moves the peek to another relation (a partition or the parent table). */
  onNavigate: (schema: string, rel: SnapRel) => void;
}

// Above this column count, show a filter box (client-side filter — we have the data).
const COLUMN_FILTER_THRESHOLD = 40;

const KIND_LABELS: Record<SnapRel["kind"], string> = {
  table: "table",
  view: "view",
  mat_view: "materialized view",
  foreign: "foreign table",
  partitioned: "partitioned table",
  sequence: "sequence",
};

export function PeekPanel({ schema, rel, connectionId, snapshot, onClose, onDetails, onNavigate }: Props) {
  const [details, setDetails] = useState<RelationDetails | null>(null);
  const [detailErr, setDetailErr] = useState(false);
  const [colFilter, setColFilter] = useState("");

  // Re-fetch details when schema.name changes (peek moved to another table).
  useEffect(() => {
    setDetails(null);
    setDetailErr(false);
    setColFilter("");
    if (!connectionId) return;
    let cancelled = false;
    getRelationDetails(connectionId, schema, rel.name)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => !cancelled && setDetailErr(true));
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, rel.name]);

  const cols = useMemo(() => {
    const q = colFilter.trim().toLowerCase();
    return q ? rel.columns.filter((c) => c.name.toLowerCase().includes(q)) : rel.columns;
  }, [rel.columns, colFilter]);

  const parent = useMemo(() => findParent(snapshot, rel), [snapshot, rel]);
  const partitions = useMemo(() => findPartitions(snapshot, rel), [snapshot, rel]);
  const lazyState = detailErr ? "error" : details ? "ready" : "loading";

  return (
    <div className="flex max-h-[46%] flex-col overflow-hidden border-t border-border bg-bg-elev text-xs">
      <header className="flex shrink-0 items-center gap-1.5 pl-2.5 pr-1 pt-1.5">
        {relationIcon(rel.kind, 13)}
        <span className="min-w-0 truncate font-medium" title={`${schema}.${rel.name}`}>
          {rel.name}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          <IconButton className="h-6 w-6" onClick={onDetails} title="Open details">
            <Maximize2 size={12} />
          </IconButton>
          <IconButton className="h-6 w-6" onClick={onClose} title="Close">
            <X size={13} />
          </IconButton>
        </div>
      </header>

      <div className="shrink-0 truncate px-2.5 pb-1.5 text-[10px] text-fg-muted">
        {KIND_LABELS[rel.kind]}
        {details && details.size_bytes > 0 && <> · {formatBytes(details.size_bytes)}</>}
        {details && details.live_rows >= 0 && rel.kind !== "view" && rel.kind !== "sequence" && (
          <> · ~{formatCount(details.live_rows)} rows</>
        )}
      </div>
      {parent && (
        <button
          className="mx-2.5 mb-1.5 flex shrink-0 items-baseline gap-1 truncate text-left text-[10px] text-fg-muted hover:text-fg"
          onClick={() => onNavigate(parent.schema, parent.rel)}
          title={rel.partition_bound ?? undefined}
        >
          <span className="shrink-0">partition of</span>
          <span className="truncate font-mono text-fg">{parent.rel.name}</span>
          <span className="truncate">· {formatBound(rel.partition_bound)}</span>
        </button>
      )}
      {rel.comment && (
        <p className="shrink-0 px-2.5 pb-1.5 text-[11px] leading-snug text-fg-muted">{rel.comment}</p>
      )}

      <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto border-t border-border/60 bg-bg-elev px-2.5">
        {/* Columns — instant, from the cache */}
        <Section title="Columns" count={rel.columns.length} defaultOpen>
          {rel.columns.length > COLUMN_FILTER_THRESHOLD && (
            <input
              value={colFilter}
              onChange={(e) => setColFilter(e.target.value)}
              placeholder="Filter columns…"
              className="mb-1 w-full rounded-md border border-border bg-bg px-1.5 py-0.5 text-xs outline-none focus:border-fg-muted"
            />
          )}
          {cols.map((c) => (
            <div
              key={c.name}
              className="flex h-[22px] items-center gap-1.5"
              title={`${c.name} ${c.type_name}${c.not_null ? " NOT NULL" : ""}`}
            >
              <span className="flex w-3 shrink-0 justify-center">
                {c.is_pk && <KeyRound size={10} className="text-warn" />}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{c.name}</span>
              <span className="max-w-[55%] shrink-0 truncate font-mono text-[10px] text-fg-muted">
                {shortType(c.type_name)}
                {!c.not_null && <span className="text-fg-subtle">?</span>}
              </span>
            </div>
          ))}
          {cols.length === 0 && <Hint>No matching columns</Hint>}
          {cols.some((c) => !c.not_null) && (
            <div className="pt-1 text-[10px] text-fg-subtle">? = nullable</div>
          )}
        </Section>

        {partitions.length > 0 && (
          <Section title="Partitions" count={partitions.length}>
            {partitions.map((p) => {
              const label = partitionLabel(p.rel.name, rel.name);
              const bound = formatBound(p.rel.partition_bound);
              return (
                <button
                  key={p.rel.oid}
                  className="flex h-[22px] w-full items-center gap-2 text-left hover:text-fg"
                  onClick={() => onNavigate(p.schema, p.rel)}
                  title={`${p.rel.name} — ${p.rel.partition_bound ?? ""}`}
                >
                  <span className="shrink-0 font-mono text-[11px]">{label}</span>
                  {bound !== label && (
                    <span className="min-w-0 flex-1 truncate text-[10px] text-fg-muted">{bound}</span>
                  )}
                  {p.rel.estimated_rows > 0 && (
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-fg-muted">
                      ~{formatCount(p.rel.estimated_rows)}
                    </span>
                  )}
                </button>
              );
            })}
          </Section>
        )}

        {/* Indexes — lazy */}
        <Section title="Indexes" count={details?.indexes.length}>
          <Lazy state={lazyState} empty={details?.indexes.length === 0}>
            <div className="space-y-1.5">
              {details?.indexes.map((ix) => <IndexRow key={ix.name} ix={ix} />)}
            </div>
          </Lazy>
        </Section>

        {/* Triggers — lazy */}
        <Section title="Triggers" count={details?.triggers.length}>
          <Lazy state={lazyState} empty={details?.triggers.length === 0}>
            <div className="space-y-1.5">
              {details?.triggers.map((tg) => <TriggerRow key={tg.name} tg={tg} />)}
            </div>
          </Lazy>
        </Section>
      </div>
    </div>
  );
}

/// Two lines: the index name with its badges, then what it covers.
function IndexRow({ ix }: { ix: IndexInfo }) {
  return (
    <div title={ix.definition}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-[11px]">{ix.name}</span>
        {ix.is_primary ? (
          <Chip tone="warn">PK</Chip>
        ) : ix.is_unique ? (
          <Chip tone="strong">unique</Chip>
        ) : null}
        {!ix.is_valid && <Chip tone="danger">invalid</Chip>}
        <span className="ml-auto shrink-0 text-[10px] text-fg-subtle">{ix.method}</span>
      </div>
      <div className="truncate pl-2 font-mono text-[10px] text-fg-muted">
        {ix.key_columns.join(", ")}
        {ix.include_columns.length > 0 && (
          <span className="text-fg-subtle"> + {ix.include_columns.join(", ")}</span>
        )}
      </div>
      {ix.predicate && (
        <div className="truncate pl-2 font-mono text-[10px] text-fg-subtle">where {ix.predicate}</div>
      )}
    </div>
  );
}

function TriggerRow({ tg }: { tg: TriggerInfo }) {
  return (
    <div title={tg.definition}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-[11px]">{tg.name}</span>
        {!tg.enabled && <Chip tone="danger">disabled</Chip>}
      </div>
      <div className="truncate pl-2 text-[10px] text-fg-muted">
        {tg.timing.toLowerCase()} {tg.events.toLowerCase()} · each {tg.level.toLowerCase()}
      </div>
      <div className="truncate pl-2 font-mono text-[10px] text-fg-subtle">→ {tg.function}()</div>
    </div>
  );
}

function Lazy({
  state,
  empty,
  children,
}: {
  state: "loading" | "error" | "ready";
  empty?: boolean;
  children: React.ReactNode;
}) {
  if (state === "error") return <Hint tone="danger">Couldn't load</Hint>;
  if (state === "loading") return <Hint>Loading…</Hint>;
  if (empty) return <Hint>None</Hint>;
  return <>{children}</>;
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <p className={tone === "danger" ? "text-[11px] text-danger" : "text-[11px] text-fg-subtle"}>
      {children}
    </p>
  );
}
