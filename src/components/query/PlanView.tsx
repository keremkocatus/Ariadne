// The execution-plan view: `EXPLAIN (FORMAT JSON)` rendered as a tree with the
// numbers that matter next to each node — where the time (or, without ANALYZE, the
// estimated cost) actually goes, and where the planner's row estimate was wrong.
import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Copy, Play } from "lucide-react";
import { Chip, Segmented } from "@/components/ui/primitives";
import { copyText } from "@/lib/clipboard";
import { errorTitle } from "@/lib/errors";
import { formatCount, formatDuration } from "@/lib/pgFormat";
import { cn } from "@/lib/utils";
import type { PlanState } from "@/stores/tabsStore";

type RawNode = Record<string, unknown> & { Plans?: RawNode[] };

interface PlanNode {
  id: number;
  depth: number;
  type: string;
  /** "on looks l", "using idx_looks_user_created" */
  target: string;
  estRows: number;
  actualRows: number | null;
  loops: number;
  /** Time spent in this node itself, children excluded (ms). Null without ANALYZE. */
  selfMs: number | null;
  totalMs: number | null;
  selfCost: number;
  totalCost: number;
  /** Condition / key lines: filter, index cond, sort key, … */
  details: [string, string][];
  /** actual ÷ estimated rows (≥ 1) when the planner was off; 1 when unknown. */
  misestimate: number;
  neverExecuted: boolean;
  raw: RawNode;
}

interface ParsedPlan {
  nodes: PlanNode[];
  planningMs: number | null;
  executionMs: number | null;
  totalCost: number;
  analyzed: boolean;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/// Properties shown as a line under the node, in this order.
const DETAIL_KEYS = [
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Filter",
  "Sort Key",
  "Group Key",
  "Subplan Name",
  "CTE Name",
] as const;

function nodeTarget(n: RawNode): string {
  const parts: string[] = [];
  const rel = str(n["Relation Name"]);
  const alias = str(n["Alias"]);
  if (rel) parts.push(`on ${rel}${alias && alias !== rel ? ` ${alias}` : ""}`);
  else if (alias) parts.push(`on ${alias}`);
  const index = str(n["Index Name"]);
  if (index) parts.push(`using ${index}`);
  const fn = str(n["Function Name"]);
  if (fn) parts.push(`${fn}()`);
  return parts.join(" ");
}

function nodeType(n: RawNode): string {
  const type = str(n["Node Type"]) || "?";
  const join = str(n["Join Type"]);
  // "Hash Join" + "Left" reads better as "Hash Left Join".
  if (join && join !== "Inner" && type.endsWith("Join")) {
    return `${type.slice(0, -4)}${join} Join`;
  }
  const strategy = str(n["Strategy"]);
  if (type === "Aggregate" && strategy && strategy !== "Plain") return `${strategy} Aggregate`;
  if (n["Parallel Aware"] === true) return `Parallel ${type}`;
  return type;
}

function parsePlan(json: string): ParsedPlan | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  const top = (Array.isArray(root) ? root[0] : root) as Record<string, unknown> | undefined;
  const plan = top?.["Plan"] as RawNode | undefined;
  if (!plan) return null;

  const nodes: PlanNode[] = [];
  const analyzed = "Actual Total Time" in plan;
  const walk = (n: RawNode, depth: number, underLimit: boolean) => {
    const kids = n.Plans ?? [];
    const loops = Math.max(1, num(n["Actual Loops"]));
    // Per-loop times are multiplied out so a node inside a nested loop shows what it
    // really cost in total.
    const totalMs = analyzed ? num(n["Actual Total Time"]) * loops : null;
    const kidsMs = kids.reduce(
      (sum, k) => sum + num(k["Actual Total Time"]) * Math.max(1, num(k["Actual Loops"])),
      0,
    );
    const totalCost = num(n["Total Cost"]);
    const kidsCost = kids.reduce((sum, k) => sum + num(k["Total Cost"]), 0);
    const estRows = num(n["Plan Rows"]);
    const neverExecuted = analyzed && num(n["Actual Loops"]) === 0;
    const actualRows = analyzed ? num(n["Actual Rows"]) : null;
    let misestimate = 1;
    // Below a LIMIT a node is stopped early, so returning fewer rows than planned
    // says nothing about the estimate; only an underestimate counts there.
    const comparable = !underLimit || (actualRows ?? 0) > estRows;
    if (actualRows != null && !neverExecuted && comparable) {
      const hi = Math.max(actualRows, estRows, 1);
      const lo = Math.max(Math.min(actualRows, estRows), 1);
      misestimate = hi / lo;
    }
    const details: [string, string][] = [];
    for (const key of DETAIL_KEYS) {
      const v = n[key];
      if (typeof v === "string") details.push([key, v]);
      else if (Array.isArray(v)) details.push([key, v.join(", ")]);
    }
    const removed = num(n["Rows Removed by Filter"]) + num(n["Rows Removed by Join Filter"]);
    if (removed > 0) details.push(["Rows removed", (removed * loops).toLocaleString()]);
    const read = num(n["Shared Read Blocks"]);
    const hit = num(n["Shared Hit Blocks"]);
    if (kids.length === 0 && read + hit > 0) {
      details.push(["Buffers", `${hit.toLocaleString()} hit · ${read.toLocaleString()} read`]);
    }
    nodes.push({
      id: nodes.length,
      depth,
      type: nodeType(n),
      target: nodeTarget(n),
      estRows,
      actualRows,
      loops,
      selfMs: totalMs == null ? null : Math.max(0, totalMs - kidsMs),
      totalMs,
      selfCost: Math.max(0, totalCost - kidsCost),
      totalCost,
      details,
      misestimate,
      neverExecuted,
      raw: n,
    });
    const limited = underLimit || str(n["Node Type"]) === "Limit";
    for (const k of kids) walk(k, depth + 1, limited);
  };
  walk(plan, 0, false);

  return {
    nodes,
    planningMs: typeof top?.["Planning Time"] === "number" ? (top["Planning Time"] as number) : null,
    executionMs: typeof top?.["Execution Time"] === "number" ? (top["Execution Time"] as number) : null,
    totalCost: num(plan["Total Cost"]),
    analyzed,
  };
}

/// The planner's estimate is called out once it is off by this factor.
const MISESTIMATE_FLAG = 10;

export function PlanView({
  plan,
  onClose,
  onRerun,
}: {
  plan: PlanState;
  onClose: () => void;
  /** Re-runs the same statement with or without ANALYZE. */
  onRerun: (analyze: boolean) => void;
}) {
  const [mode, setMode] = useState<"tree" | "json">("tree");
  const parsed = useMemo(() => (plan.json ? parsePlan(plan.json) : null), [plan.json]);
  const pretty = useMemo(() => {
    if (!plan.json) return "";
    try {
      return JSON.stringify(JSON.parse(plan.json), null, 2);
    } catch {
      return plan.json;
    }
  }, [plan.json]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-bg-elev/40 px-3 text-xs">
        <span className="font-medium">Execution plan</span>
        <Chip tone={plan.analyze ? "strong" : "neutral"}>{plan.analyze ? "analyze" : "estimate"}</Chip>
        {parsed && (
          <span className="truncate text-[11px] tabular-nums text-fg-muted">
            {parsed.executionMs != null && <>execution {formatDuration(parsed.executionMs)} · </>}
            {parsed.planningMs != null && <>planning {formatDuration(parsed.planningMs)} · </>}
            cost {parsed.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {plan.json && (
            <>
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: "tree", label: "Tree" },
                  { value: "json", label: "JSON" },
                ]}
              />
              <button
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
                onClick={() => void copyText(pretty, "Plan copied")}
                title="Copy the plan as JSON"
              >
                <Copy size={11} /> Copy
              </button>
            </>
          )}
          <button
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
            onClick={() => onRerun(!plan.analyze)}
            title={
              plan.analyze
                ? "Plan only — the statement is not executed"
                : "Runs the statement for real timings; its changes are rolled back"
            }
          >
            <Play size={11} /> {plan.analyze ? "Estimate only" : "Analyze"}
          </button>
          <button
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
            onClick={onClose}
          >
            <ArrowLeft size={11} /> Results
          </button>
        </div>
      </div>

      {plan.error ? (
        <div className="overflow-auto p-3 font-mono text-xs">
          <div className="font-semibold text-danger">
            {errorTitle(plan.error)}
            {plan.error.sqlstate && <span className="font-normal text-fg-muted"> · {plan.error.sqlstate}</span>}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-danger">{plan.error.message}</p>
          {plan.error.hint && <p className="mt-1 whitespace-pre-wrap text-warn">HINT: {plan.error.hint}</p>}
        </div>
      ) : mode === "json" || !parsed ? (
        <pre className="min-h-0 flex-1 select-text overflow-auto p-3 font-mono text-[11px] leading-relaxed">
          {pretty}
        </pre>
      ) : (
        <PlanTree plan={parsed} />
      )}
    </div>
  );
}

function PlanTree({ plan }: { plan: ParsedPlan }) {
  const [open, setOpen] = useState<number | null>(null);
  // The bar shows each node's own share: of the execution time when measured,
  // otherwise of the estimated cost.
  const totalSelf = plan.nodes.reduce((sum, n) => sum + (plan.analyzed ? (n.selfMs ?? 0) : n.selfCost), 0) || 1;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-fg-muted">
            <th className="sticky top-0 z-[1] border-b border-border bg-bg px-3 py-1 text-left font-medium">Node</th>
            <th className="sticky top-0 z-[1] w-[150px] border-b border-border bg-bg px-3 py-1 text-right font-medium">
              Rows {plan.analyzed ? "(actual / est.)" : "(est.)"}
            </th>
            <th className="sticky top-0 z-[1] w-[210px] border-b border-border bg-bg px-3 py-1 text-left font-medium">
              {plan.analyzed ? "Self time" : "Self cost"}
            </th>
            {plan.analyzed && (
              <th className="sticky top-0 z-[1] w-[90px] border-b border-border bg-bg px-3 py-1 text-right font-medium">
                Total
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {plan.nodes.map((n) => {
            const self = plan.analyzed ? (n.selfMs ?? 0) : n.selfCost;
            const share = self / totalSelf;
            const hot = share >= 0.5 ? "danger" : share >= 0.2 ? "warn" : null;
            const isOpen = open === n.id;
            return (
              <tr
                key={n.id}
                className={cn("cursor-pointer align-top transition-colors hover:bg-bg-hover/60", isOpen && "bg-bg-hover/60")}
                onClick={() => setOpen(isOpen ? null : n.id)}
              >
                <td className="border-b border-border/50 py-1 pr-3" style={{ paddingLeft: 10 + n.depth * 16 }}>
                  <div className="flex items-center gap-1.5">
                    <ChevronRight
                      size={11}
                      className={cn("shrink-0 text-fg-subtle transition-transform", isOpen && "rotate-90")}
                    />
                    <span className={cn("font-medium", n.neverExecuted && "text-fg-muted line-through")}>
                      {n.type}
                    </span>
                    {n.target && <span className="truncate font-mono text-[11px] text-fg-muted">{n.target}</span>}
                    {n.loops > 1 && <Chip title="Executed this many times">×{formatCount(n.loops)}</Chip>}
                    {n.neverExecuted && <Chip>never executed</Chip>}
                  </div>
                  {n.details.map(([k, v]) => (
                    <div key={k} className="truncate pl-[18px] font-mono text-[10px] text-fg-subtle" title={v}>
                      {k}: <span className="text-fg-muted">{v}</span>
                    </div>
                  ))}
                  {isOpen && <NodeProperties raw={n.raw} />}
                </td>
                <td className="whitespace-nowrap border-b border-border/50 px-3 py-1 text-right tabular-nums">
                  {n.actualRows != null ? (
                    <>
                      {formatCount(n.actualRows)}
                      <span className="text-fg-subtle"> / {formatCount(n.estRows)}</span>
                      {n.misestimate >= MISESTIMATE_FLAG && (
                        <Chip
                          tone="warn"
                          className="ml-1.5"
                          title="The planner's row estimate is far from what really came back — stale statistics or a hard-to-estimate predicate"
                        >
                          {n.misestimate >= 1000 ? ">1000" : Math.round(n.misestimate)}× off
                        </Chip>
                      )}
                    </>
                  ) : (
                    <span className="text-fg-muted">{formatCount(n.estRows)}</span>
                  )}
                </td>
                <td className="border-b border-border/50 px-3 py-1">
                  <div className="flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-fg/8">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          hot === "danger" ? "bg-danger" : hot === "warn" ? "bg-warn" : "bg-fg-muted",
                        )}
                        style={{ width: `${Math.max(self > 0 ? 2 : 0, share * 100)}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "w-[74px] shrink-0 text-right tabular-nums",
                        hot === "danger" ? "text-danger" : hot === "warn" ? "text-warn" : "text-fg-muted",
                      )}
                    >
                      {plan.analyzed
                        ? formatDuration(self)
                        : self.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                    </span>
                  </div>
                </td>
                {plan.analyzed && (
                  <td className="whitespace-nowrap border-b border-border/50 px-3 py-1 text-right tabular-nums text-fg-muted">
                    {formatDuration(n.totalMs ?? 0)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/// Everything else the planner reported for a node, for the expanded row.
function NodeProperties({ raw }: { raw: RawNode }) {
  const entries = Object.entries(raw).filter(
    ([k, v]) => k !== "Plans" && k !== "Node Type" && v !== null && typeof v !== "object",
  );
  return (
    <div
      className="mt-1.5 grid cursor-auto select-text grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 rounded-md border border-border bg-bg p-2 pl-[18px] font-mono text-[10px]"
      onClick={(e) => e.stopPropagation()}
    >
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-fg-subtle">{k}</span>
          <span className="break-all text-fg-muted">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}
