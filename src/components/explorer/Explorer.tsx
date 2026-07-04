import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // Returning a fresh [] from a selector is forbidden (zustand v5/useSyncExternalStore
  // infinite-loop warning); select the pins object and default to a stable constant.
  const pinsMap = useSchemaStore((s) => s.pins);
  const pins = (profileId ? pinsMap[profileId] : undefined) ?? EMPTY_PINS;
  const togglePin = useSchemaStore((s) => s.togglePin);
  // The Explorer group filter: name/kind filter via right-click.
  const filter = useSchemaStore((s) => (connectionId ? s.filters[connectionId] : undefined)) ?? EMPTY_FILTER;
  const [filterMenu, setFilterMenu] = useState<{ which: "rel" | "fn"; x: number; y: number } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  // Right-click a schema node → "New query here" menu.
  const [schemaMenu, setSchemaMenu] = useState<{ schema: string; x: number; y: number } | null>(null);
  const { ref: sizeRef, height } = useSize();

  const snapshot = entry?.snapshot;
  const treeData = useMemo(
    () => (snapshot ? buildTree(filterSnapshot(snapshot, filter)) : []),
    [snapshot, filter],
  );
  // The active schema + its Tables are open initially. key={connectionId} re-applies
  // this when the connection changes.
  const initialOpen = useMemo(() => (snapshot ? defaultOpenState(snapshot) : {}), [snapshot]);

  const which = (node: TreeNode): "rel" | "fn" => (node.name.startsWith("Functions") ? "fn" : "rel");
  // Right-click: category → filter popover; schema → "New query here".
  const openFilterMenu = (node: TreeNode, e: React.MouseEvent) => {
    if (node.ntype === "category") {
      e.preventDefault();
      setFilterMenu({ which: which(node), x: e.clientX, y: e.clientY });
    } else if (node.ntype === "schema") {
      e.preventDefault();
      setSchemaMenu({ schema: node.name, x: e.clientX, y: e.clientY });
    }
  };
  // Click the "more" node → open that category's filter popover.
  const openMoreFilter = (node: TreeNode, e: React.MouseEvent) => {
    setFilterMenu({ which: node.moreWhich ?? "rel", x: e.clientX, y: e.clientY });
  };
  const isCatFiltered = (node: TreeNode) =>
    node.ntype === "category" && isCategoryActive(filter[which(node)]);

  // A flat list while searching (drop the nesting).
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

  // Single click = peek (harmless, info only); double click = open. The single-click
  // peek is DEBOUNCED: the peek panel is an in-flow flex child (max-h-42%), and
  // opening it shrinks the tree area and shifts the rows; that shift landed the two
  // clicks of a double-click on different rows, so `dblclick` never fired. Delaying
  // the peek lets a double-click cancel the pending timer → the peek does NOT open,
  // there's no shift, and activate runs immediately.
  const clickTimer = useRef<number | null>(null);
  const cancelPendingPeek = () => {
    if (clickTimer.current != null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  };
  useEffect(() => cancelPendingPeek, []);
  const peekRelation = (node: TreeNode) => {
    if (node.ntype === "relation" && node.rel && node.schema) {
      setPeek({ schema: node.schema, rel: node.rel });
    }
  };
  const peekNode = (node: TreeNode) => {
    cancelPendingPeek();
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      peekRelation(node);
    }, 220);
  };
  const activateNode = (node: TreeNode) => {
    cancelPendingPeek(); // double-click: cancel the pending peek (avoid the shift)
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
      // The webview's own right-click menu (Back/Reload/Print/Inspect) isn't wanted on
      // any Explorer node. Category/schema nodes open their own menus in
      // openFilterMenu; this suppression cuts the default menu for leaves/empty
      // space/pinned rows. The paste menu is preserved over the search box (narrow scope).
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
      }}
    >
      {/* Server ▸ database context bar */}
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

// ---- Right-click filter popover ----

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
    // Full-screen overlay: clicking outside or Escape closes it.
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

// ---- Small local presentation helpers (used only in this file) ----

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

// Measures the container size and gives react-arborist a height. Uses a **callback
// ref**: the measured div is rendered only in the snapshot-READY branch; an observer
// set up in a mount-time `useEffect([])` would run while the div is still absent
// (Loading), see `null`, and never attach again → when the snapshot arrived, height
// stayed 0 and the tree drew empty (a tab-switch remount accidentally "fixed" it). A
// callback ref attaches the moment the node mounts, with no deps race → the tree
// appears IMMEDIATELY on a new connection.
function useSize() {
  const [height, setHeight] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (node) {
      const ro = new ResizeObserver((entries) => setHeight(entries[0].contentRect.height));
      ro.observe(node);
      roRef.current = ro;
    }
  }, []);
  return { ref, height };
}
