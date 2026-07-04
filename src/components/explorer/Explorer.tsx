import { useEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import { Pin, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { fuzzyMatch } from "@/lib/fuzzy";
import {
  useSchemaStore,
  EMPTY_FILTER,
  isCategoryActive,
  type CategoryFilter,
} from "@/stores/schemaStore";
import { refreshSchema, type SnapFn, type SnapRel } from "@/lib/api";
import { buildTree, defaultOpenState, filterSnapshot, flatten, type TreeNode } from "./tree";
import { iconFor } from "./icons";
import { NodeRow } from "./NodeRow";
import { PeekPanel } from "./PeekPanel";
import { ContextBar } from "./ContextBar";
import { QuickActionMenu } from "./QuickActionMenu";
import { useTabsStore } from "@/stores/tabsStore";

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
  // Explorer grup filtresi (design 15 §P1-U3): sağ-tık ile ad/tür filtresi.
  const filter = useSchemaStore((s) => (connectionId ? s.filters[connectionId] : undefined)) ?? EMPTY_FILTER;
  const [filterMenu, setFilterMenu] = useState<{ which: "rel" | "fn"; x: number; y: number } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  // Şema düğümü sağ-tık → "New query here" menüsü (design 18 §P1-W3 N7).
  const [schemaMenu, setSchemaMenu] = useState<{ schema: string; x: number; y: number } | null>(null);
  const { ref: sizeRef, height } = useSize();

  const snapshot = entry?.snapshot;
  const treeData = useMemo(
    () => (snapshot ? buildTree(filterSnapshot(snapshot, filter)) : []),
    [snapshot, filter],
  );
  // Açılışta aktif şema + Tables açık (design 18 §P1-W2 N3). key={connectionId}
  // bağlantı değişince yeniden uygular.
  const initialOpen = useMemo(() => (snapshot ? defaultOpenState(snapshot) : {}), [snapshot]);

  const which = (node: TreeNode): "rel" | "fn" => (node.name.startsWith("Functions") ? "fn" : "rel");
  // Sağ-tık: kategori → filtre popover'ı; şema → "New query here" (design 18 §P1-W3).
  const openFilterMenu = (node: TreeNode, e: React.MouseEvent) => {
    if (node.ntype === "category") {
      e.preventDefault();
      setFilterMenu({ which: which(node), x: e.clientX, y: e.clientY });
    } else if (node.ntype === "schema") {
      e.preventDefault();
      setSchemaMenu({ schema: node.name, x: e.clientX, y: e.clientY });
    }
  };
  // "more" düğümüne tık → o kategorinin filtre popover'ını aç (design 18 §P1-W2 N4).
  const openMoreFilter = (node: TreeNode, e: React.MouseEvent) => {
    setFilterMenu({ which: node.moreWhich ?? "rel", x: e.clientX, y: e.clientY });
  };
  const isCatFiltered = (node: TreeNode) =>
    node.ntype === "category" && isCategoryActive(filter[which(node)]);

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
    <div
      className="flex h-full flex-col"
      // Explorer'da webview'in kendi sağ-tık menüsü (Geri/Yenile/Yazdır/İncele)
      // hiçbir düğümde istenmiyor (design 19 N3). Kategori/şema kendi menülerini
      // openFilterMenu içinde açar; buradaki bastırma yaprak/boşluk/pinned için
      // varsayılan menüyü keser. Arama kutusunda paste menüsü korunur (dar kapsam).
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
      }}
    >
      {/* Server ▸ database bağlam çubuğu (design 18 §P1-W3) */}
      <ContextBar connectionId={connectionId} />

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
                  key={connectionId}
                  data={treeData}
                  initialOpenState={initialOpen}
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
                      onContextMenu={openFilterMenu}
                      onMore={openMoreFilter}
                      isFiltered={isCatFiltered}
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

      {filterMenu && connectionId && (
        <FilterPopover
          which={filterMenu.which}
          x={filterMenu.x}
          y={filterMenu.y}
          filter={filter[filterMenu.which]}
          connectionId={connectionId}
          onClose={() => setFilterMenu(null)}
        />
      )}

      {schemaMenu && connectionId && (
        <QuickActionMenu
          x={schemaMenu.x}
          y={schemaMenu.y}
          onClose={() => setSchemaMenu(null)}
          actions={[
            {
              label: "New query here",
              onClick: () => useTabsStore.getState().addTab("", connectionId),
            },
          ]}
        />
      )}
    </div>
  );
}

// ---- Sağ-tık filtre popover'ı (design 15 §P1-U3) ----

const REL_KINDS: [string, string][] = [
  ["table", "Table"],
  ["view", "View"],
  ["mat_view", "Materialized"],
  ["foreign", "Foreign"],
  ["partitioned", "Partitioned"],
  ["sequence", "Sequence"],
];
const FN_KINDS: [string, string][] = [
  ["function", "Function"],
  ["procedure", "Procedure"],
  ["aggregate", "Aggregate"],
  ["window", "Window"],
  ["trigger", "Trigger fn"],
];

function FilterPopover({
  which,
  x,
  y,
  filter,
  connectionId,
  onClose,
}: {
  which: "rel" | "fn";
  x: number;
  y: number;
  filter: CategoryFilter;
  connectionId: string;
  onClose: () => void;
}) {
  const setFilter = useSchemaStore((s) => s.setFilter);
  const clearFilter = useSchemaStore((s) => s.clearFilter);
  const kinds = which === "fn" ? FN_KINDS : REL_KINDS;
  const toggleKind = (k: string) => {
    const set = new Set(filter.kinds);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    setFilter(connectionId, which, { kinds: [...set] });
  };

  return (
    // Tam ekran örtü: dışına tık ya da Escape kapatır.
    <div
      className="fixed inset-0 z-40"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="absolute w-52 rounded-md border border-border bg-bg-elev p-2 text-xs shadow-2xl"
        style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 240) }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-muted">
          Filter {which === "fn" ? "functions" : "tables"}
        </div>
        <input
          autoFocus
          value={filter.name}
          onChange={(e) => setFilter(connectionId, which, { name: e.target.value })}
          placeholder="Name contains…"
          className="mb-2 w-full rounded border border-border bg-bg px-1.5 py-0.5 outline-none focus:border-fg-muted"
        />
        <div className="space-y-0.5">
          {kinds.map(([k, label]) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={filter.kinds.includes(k)}
                onChange={() => toggleKind(k)}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="mt-2 flex justify-between">
          <button
            className="text-fg-muted hover:text-fg"
            onClick={() => clearFilter(connectionId, which)}
          >
            Clear
          </button>
          <button className="text-fg-muted hover:text-fg" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
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
