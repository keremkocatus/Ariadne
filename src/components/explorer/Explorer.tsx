import { useEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import { Pin, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { fuzzyMatch } from "@/lib/fuzzy";
import { useSchemaStore } from "@/stores/schemaStore";
import { refreshSchema, type SnapFn, type SnapRel } from "@/lib/api";
import { buildTree, flatten, type TreeNode } from "./tree";
import { iconFor } from "./icons";
import { NodeRow } from "./NodeRow";
import { PeekPanel } from "./PeekPanel";

const EMPTY_PINS: string[] = [];

interface Props {
  connectionId: string | null;
  profileId: string | null;
  onOpenRelation: (schema: string, name: string) => void;
  onOpenFunction: (fn: SnapFn) => void;
}

interface PeekTarget {
  schema: string;
  rel: SnapRel;
}

export function Explorer({ connectionId, profileId, onOpenRelation, onOpenFunction }: Props) {
  const entry = useSchemaStore((s) => (connectionId ? s.byConnection[connectionId] : undefined));
  const search = useSchemaStore((s) => s.search);
  const setSearch = useSchemaStore((s) => s.setSearch);
  // Selector'dan yeni [] döndürmek yasak (zustand v5/useSyncExternalStore sonsuz
  // döngü uyarısı); pins objesini seçip stabil sabitle default'la.
  const pinsMap = useSchemaStore((s) => s.pins);
  const pins = (profileId ? pinsMap[profileId] : undefined) ?? EMPTY_PINS;
  const togglePin = useSchemaStore((s) => s.togglePin);

  const searchRef = useRef<HTMLInputElement>(null);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
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

  // Tek tık = peek (zararsız, sadece bilgi); çift tık = aç (design 15 §P1-U3).
  const peekNode = (node: TreeNode) => {
    if (node.ntype === "relation" && node.rel && node.schema) {
      setPeek({ schema: node.schema, rel: node.rel });
    }
  };
  const activateNode = (node: TreeNode) => {
    if (node.ntype === "relation" && node.rel && node.schema) {
      onOpenRelation(node.schema, node.rel.name);
    } else if (node.ntype === "function" && node.fn) {
      onOpenFunction(node.fn);
    }
  };

  const pinnedRels = useMemo(() => {
    if (!snapshot) return [];
    const set = new Set(pins);
    const out: TreeNode[] = [];
    for (const sc of snapshot.schemas) {
      for (const r of sc.relations) {
        if (set.has(`${sc.name}.${r.name}`)) {
          out.push({
            id: `pin:${sc.name}.${r.name}`,
            name: r.name,
            ntype: "relation",
            schema: sc.name,
            rel: r,
          });
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
                  onClick={() => peekNode(n)}
                  onDoubleClick={() => activateNode(n)}
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
                    onClick={() => peekNode(n)}
                    onDoubleClick={() => activateNode(n)}
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
                      onPeek={peekNode}
                      onActivate={activateNode}
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

          {peek && (
            <PeekPanel
              schema={peek.schema}
              rel={peek.rel}
              connectionId={connectionId}
              onClose={() => setPeek(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- Küçük yerel sunum yardımcıları (yalnız bu dosyada kullanılır) ----

function Row({
  icon,
  label,
  sub,
  onClick,
  onDoubleClick,
  onPin,
  pinned,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  onPin?: () => void;
  pinned?: boolean;
}) {
  return (
    <div
      className="group flex h-6 cursor-pointer items-center gap-1.5 px-2 text-xs hover:bg-bg-elev"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
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
  return (
    <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">{children}</div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-3 text-xs text-fg-muted">{text}</div>;
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
