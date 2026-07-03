import { useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import {
  ChevronRight,
  Table2,
  Eye,
  Layers,
  Hash,
  FunctionSquare,
  Folder,
  Pin,
  RefreshCw,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fuzzyMatch } from "@/lib/fuzzy";
import { useSchemaStore } from "@/stores/schemaStore";
import { refreshSchema, type SchemaSnapshot, type SnapFn, type SnapRel } from "@/lib/api";

const EMPTY_PINS: string[] = [];

interface Props {
  connectionId: string | null;
  profileId: string | null;
  onOpenRelation: (schema: string, name: string) => void;
}

interface TreeNode {
  id: string;
  name: string;
  ntype: "schema" | "category" | "relation" | "function";
  schema?: string;
  rel?: SnapRel;
  fn?: SnapFn;
  isSystem?: boolean;
  children?: TreeNode[];
}

export function Explorer({ connectionId, profileId, onOpenRelation }: Props) {
  const entry = useSchemaStore((s) => (connectionId ? s.byConnection[connectionId] : undefined));
  const search = useSchemaStore((s) => s.search);
  const setSearch = useSchemaStore((s) => s.setSearch);
  // Selector'dan yeni [] döndürmek yasak (zustand v5/useSyncExternalStore sonsuz
  // döngü uyarısı); pins objesini seçip stabil sabitle default'la.
  const pinsMap = useSchemaStore((s) => s.pins);
  const pins = (profileId ? pinsMap[profileId] : undefined) ?? EMPTY_PINS;
  const togglePin = useSchemaStore((s) => s.togglePin);

  const searchRef = useRef<HTMLInputElement>(null);
  const [peek, setPeek] = useState<SnapRel | null>(null);
  const { ref: sizeRef, height } = useSize();

  const snapshot = entry?.snapshot;
  const treeData = useMemo(() => (snapshot ? buildTree(snapshot) : []), [snapshot]);

  // Aramada düz liste (nesting'ten kurtul, design 07 §2).
  const flat = useMemo(() => (snapshot ? flatten(snapshot) : []), [snapshot]);
  const results = useMemo(() => {
    if (!search.trim()) return null;
    return flat
      .map((n) => ({ n, r: fuzzyMatch(search, n.name) }))
      .filter((x) => x.r.matched)
      .sort((a, b) => b.r.score - a.r.score)
      .slice(0, 200)
      .map((x) => x.n);
  }, [flat, search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openNode = (node: TreeNode) => {
    if (node.ntype === "relation" && node.rel && node.schema) {
      setPeek(node.rel);
      onOpenRelation(node.schema, node.rel.name);
    }
  };

  const pinnedRels = useMemo(() => {
    if (!snapshot) return [];
    const set = new Set(pins);
    const out: TreeNode[] = [];
    for (const sc of snapshot.schemas) {
      for (const r of sc.relations) {
        if (set.has(`${sc.name}.${r.name}`)) {
          out.push({ id: `pin:${sc.name}.${r.name}`, name: r.name, ntype: "relation", schema: sc.name, rel: r });
        }
      }
    }
    return out;
  }, [snapshot, pins]);

  return (
    <div className="flex h-full flex-col">
      {/* Arama + refresh */}
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search (Ctrl+P)…"
            className="w-full rounded border border-border bg-bg py-1 pl-6 pr-2 text-xs outline-none focus:border-fg-muted"
          />
        </div>
        <button
          title="Refresh (F5)"
          disabled={!connectionId}
          onClick={() => connectionId && void refreshSchema(connectionId)}
          className="rounded border border-border p-1 text-fg-muted hover:text-fg disabled:opacity-40"
        >
          <RefreshCw size={13} className={cn(entry?.status === "loading" && "animate-spin")} />
        </button>
      </div>

      {!connectionId ? (
        <Empty text="Select a connection" />
      ) : !snapshot ? (
        <Empty text={entry?.status === "loading" ? "Loading schema…" : "No schema"} />
      ) : (
        <>
          {/* Pinned */}
          {pinnedRels.length > 0 && !results && (
            <div className="border-b border-border py-1">
              <SectionLabel>Pinned</SectionLabel>
              {pinnedRels.map((n) => (
                <Row
                  key={n.id}
                  icon={<Pin size={12} className="text-fg-muted" />}
                  label={n.name}
                  sub={n.schema}
                  onClick={() => openNode(n)}
                  onPin={() => profileId && togglePin(profileId, `${n.schema}.${n.name}`)}
                  pinned
                />
              ))}
            </div>
          )}

          <div ref={sizeRef} className="min-h-0 flex-1 overflow-hidden">
            {results ? (
              <div className="h-full overflow-auto py-1">
                {results.length === 0 && <Empty text="No results" />}
                {results.map((n) => (
                  <Row
                    key={n.id}
                    icon={iconFor(n)}
                    label={n.name}
                    sub={n.schema}
                    onClick={() => openNode(n)}
                    onPin={
                      n.ntype === "relation" && profileId
                        ? () => togglePin(profileId, `${n.schema}.${n.name}`)
                        : undefined
                    }
                    pinned={pins.includes(`${n.schema}.${n.name}`)}
                  />
                ))}
              </div>
            ) : (
              height > 0 && (
                <Tree<TreeNode>
                  data={treeData}
                  openByDefault={false}
                  width="100%"
                  height={height}
                  indent={14}
                  rowHeight={24}
                  disableDrag
                  disableDrop
                >
                  {(props) => (
                    <NodeRow
                      {...props}
                      onOpen={openNode}
                      onPin={(node) =>
                        node.rel &&
                        profileId &&
                        togglePin(profileId, `${node.schema}.${node.rel.name}`)
                      }
                      isPinned={(node) =>
                        !!node.rel && pins.includes(`${node.schema}.${node.rel.name}`)
                      }
                    />
                  )}
                </Tree>
              )
            )}
          </div>

          {peek && <PeekPanel rel={peek} onClose={() => setPeek(null)} />}
        </>
      )}
    </div>
  );
}

// ---- Tree node renderer ----

function NodeRow({
  node,
  style,
  onOpen,
  onPin,
  isPinned,
}: NodeRendererProps<TreeNode> & {
  onOpen: (n: TreeNode) => void;
  onPin: (n: TreeNode) => void;
  isPinned: (n: TreeNode) => boolean;
}) {
  const d = node.data;
  const isLeaf = d.ntype === "relation" || d.ntype === "function";
  return (
    <div
      style={style}
      className={cn(
        "group flex h-6 cursor-pointer items-center gap-1 pr-1 text-xs hover:bg-bg-elev",
        node.isSelected && "bg-bg-elev",
      )}
      onClick={() => {
        if (isLeaf) onOpen(d);
        else node.toggle();
      }}
      onDoubleClick={() => isLeaf && onOpen(d)}
    >
      {!isLeaf ? (
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-fg-muted transition-transform", node.isOpen && "rotate-90")}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {iconFor(d)}
      <span className="truncate">{d.name}</span>
      {d.rel && d.rel.estimated_rows > 0 && (
        <span className="ml-auto shrink-0 pl-2 text-[10px] text-fg-muted">
          ~{formatRows(d.rel.estimated_rows)}
        </span>
      )}
      {d.ntype === "relation" && (
        <button
          className={cn(
            "ml-1 shrink-0 opacity-0 group-hover:opacity-100",
            isPinned(d) && "opacity-100 text-fg",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin(d);
          }}
          title="Pin"
        >
          <Pin size={11} className={cn(isPinned(d) ? "fill-current" : "text-fg-muted")} />
        </button>
      )}
    </div>
  );
}

function PeekPanel({ rel, onClose }: { rel: SnapRel; onClose: () => void }) {
  return (
    <div className="max-h-[38%] overflow-auto border-t border-border bg-bg-elev p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">{rel.name}</span>
        <button className="text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>
      {rel.comment && <p className="mb-1 text-[11px] text-fg-muted">{rel.comment}</p>}
      <table className="w-full">
        <tbody>
          {rel.columns.map((c) => (
            <tr key={c.name}>
              <td className="pr-2 font-mono">{c.name}</td>
              <td className="text-fg-muted">{c.type_name}</td>
              <td className="pl-1 text-[10px] text-fg-muted">{c.not_null ? "not null" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Yardımcılar ----

function Row({
  icon,
  label,
  sub,
  onClick,
  onPin,
  pinned,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  onPin?: () => void;
  pinned?: boolean;
}) {
  return (
    <div
      className="group flex h-6 cursor-pointer items-center gap-1.5 px-2 text-xs hover:bg-bg-elev"
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{label}</span>
      {sub && <span className="truncate text-[10px] text-fg-muted">{sub}</span>}
      {onPin && (
        <button
          className={cn("ml-auto opacity-0 group-hover:opacity-100", pinned && "opacity-100")}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
        >
          <Pin size={11} className={cn(pinned ? "fill-current text-fg" : "text-fg-muted")} />
        </button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">{children}</div>;
}
function Empty({ text }: { text: string }) {
  return <div className="p-3 text-xs text-fg-muted">{text}</div>;
}

function iconFor(n: TreeNode) {
  const c = "shrink-0 text-fg-muted";
  switch (n.ntype) {
    case "schema":
      return <Folder size={12} className={c} />;
    case "category":
      return <Folder size={12} className={c} />;
    case "function":
      return <FunctionSquare size={12} className={c} />;
    case "relation":
      switch (n.rel?.kind) {
        case "view":
        case "mat_view":
          return <Eye size={12} className={c} />;
        case "sequence":
          return <Hash size={12} className={c} />;
        case "foreign":
        case "partitioned":
          return <Layers size={12} className={c} />;
        default:
          return <Table2 size={12} className={c} />;
      }
  }
}

function formatRows(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function buildTree(snap: SchemaSnapshot): TreeNode[] {
  return snap.schemas
    .slice()
    .sort((a, b) => Number(a.is_system) - Number(b.is_system) || a.name.localeCompare(b.name))
    .map((sc) => {
      const cats: TreeNode[] = [];
      const group = (label: string, rels: SnapRel[]) => {
        if (rels.length === 0) return;
        cats.push({
          id: `${sc.name}:${label}`,
          name: `${label} (${rels.length})`,
          ntype: "category",
          children: rels.map((r) => ({
            id: `${sc.name}.${r.name}`,
            name: r.name,
            ntype: "relation",
            schema: sc.name,
            rel: r,
          })),
        });
      };
      group("Tables", sc.relations.filter((r) => r.kind === "table" || r.kind === "partitioned" || r.kind === "foreign"));
      group("Views", sc.relations.filter((r) => r.kind === "view"));
      group("Materialized", sc.relations.filter((r) => r.kind === "mat_view"));
      group("Sequences", sc.relations.filter((r) => r.kind === "sequence"));
      if (sc.functions.length > 0) {
        cats.push({
          id: `${sc.name}:Functions`,
          name: `Functions (${sc.functions.length})`,
          ntype: "category",
          children: sc.functions.map((f) => ({
            id: `${sc.name}.fn.${f.oid}`,
            name: f.name,
            ntype: "function",
            schema: sc.name,
            fn: f,
          })),
        });
      }
      return {
        id: `schema:${sc.name}`,
        name: sc.name,
        ntype: "schema" as const,
        isSystem: sc.is_system,
        children: cats,
      };
    });
}

function flatten(snap: SchemaSnapshot): TreeNode[] {
  const out: TreeNode[] = [];
  for (const sc of snap.schemas) {
    for (const r of sc.relations) {
      out.push({ id: `${sc.name}.${r.name}`, name: r.name, ntype: "relation", schema: sc.name, rel: r });
    }
    for (const f of sc.functions) {
      out.push({ id: `${sc.name}.fn.${f.oid}`, name: f.name, ntype: "function", schema: sc.name, fn: f });
    }
  }
  return out;
}

// Container boyutunu ölçüp react-arborist'e height verir.
function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      setHeight(entries[0].contentRect.height);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, height };
}
