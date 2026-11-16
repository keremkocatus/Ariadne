// Scheduled jobs (pg_cron). A two-pane manager in the spirit of SQL Server Agent's job
// list: jobs with their last outcome on the left, the selected job's definition and
// run history on the right. Reads on demand; nothing is cached.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, Clock, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Chip, EmptyState, IconButton, Toggle } from "@/components/ui/primitives";
import {
  cronDeleteJob,
  cronJobRuns,
  cronOverview,
  cronSaveJob,
  cronSetActive,
  isAriadneError,
  listDatabases,
  type CronJob,
  type CronOverview,
  type CronRun,
} from "@/lib/api";
import { describeSchedule, SCHEDULE_PRESETS } from "@/lib/cronSchedule";
import { formatDuration, formatTimestamp, parsePgTimestamp, relativeTime } from "@/lib/pgFormat";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";
import { useUiStore } from "@/stores/uiStore";

const errorText = (e: unknown) => (isAriadneError(e) ? e.message : String(e));
const jobLabel = (j: CronJob) => j.name || `job ${j.job_id}`;

function statusTone(status: string | null | undefined): "ok" | "danger" | "warn" | "neutral" {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "danger";
  if (status) return "warn"; // running / starting / connecting / sending
  return "neutral";
}

function StatusDot({ status, paused }: { status?: string | null; paused?: boolean }) {
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        paused
          ? "border border-fg-subtle"
          : tone === "ok"
            ? "bg-ok"
            : tone === "danger"
              ? "bg-danger"
              : tone === "warn"
                ? "animate-pulse bg-warn"
                : "bg-fg-subtle",
      )}
      title={paused ? "Paused" : (status ?? "No runs yet")}
    />
  );
}

type Editing = { job: CronJob | null } | null;

export function CronDialog() {
  const open = useUiStore((s) => s.cronOpen);
  const setOpen = useUiStore((s) => s.setCronOpen);
  const connectionId = useTabsStore((s) => s.active()?.connectionId ?? null);
  const live = useConnectionStore((s) => (connectionId ? !!s.connections[connectionId] : false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && (
        <DialogContent className="flex h-[84vh] w-[1040px] max-w-[95vw] flex-col gap-0 p-0">
          {connectionId && live ? (
            <CronBody key={connectionId} connectionId={connectionId} />
          ) : (
            <>
              <DialogTitle className="px-4 pt-4">Scheduled jobs</DialogTitle>
              <EmptyState className="px-4">Connect to a database to see its pg_cron jobs.</EmptyState>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function CronBody({ connectionId }: { connectionId: string }) {
  const readOnly = useConnectionStore((s) => s.isReadOnly(connectionId));
  const [overview, setOverview] = useState<CronOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<CronJob | null>(null);
  // Bumped after anything that may have produced new runs, to reload the history.
  const [runsEpoch, setRunsEpoch] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    cronOverview(connectionId)
      .then((o) => {
        setOverview(o);
        setError(null);
        setSelectedId((cur) => (cur != null && o.jobs.some((j) => j.job_id === cur) ? cur : (o.jobs[0]?.job_id ?? null)));
        setRunsEpoch((n) => n + 1);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [connectionId]);
  useEffect(load, [load]);

  const selected = overview?.jobs.find((j) => j.job_id === selectedId) ?? null;

  const toggleActive = async (job: CronJob) => {
    try {
      await cronSetActive(connectionId, job.job_id, !job.active);
      toast.success(`${jobLabel(job)} ${job.active ? "paused" : "resumed"}`);
      load();
    } catch (e) {
      toast.error("Couldn't change the job", { description: errorText(e) });
    }
  };

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 pr-11">
        <Clock size={15} className="text-fg-muted" />
        <div className="min-w-0">
          <DialogTitle>Scheduled jobs</DialogTitle>
          <DialogDescription className="truncate">
            {overview?.installed
              ? `pg_cron ${overview.version ?? ""} · ${overview.jobs.length} job${overview.jobs.length === 1 ? "" : "s"} · database ${overview.current_database}`
              : "pg_cron"}
          </DialogDescription>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {overview?.installed && (
            <Button
              variant="default"
              disabled={readOnly}
              title={readOnly ? "This profile is read-only" : undefined}
              onClick={() => setEditing({ job: null })}
            >
              <Plus size={12} /> New job
            </Button>
          )}
          <IconButton title="Refresh" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={cn(loading && "animate-spin")} />
          </IconButton>
        </div>
      </header>

      {error ? (
        <EmptyState className="p-5 text-danger">{error}</EmptyState>
      ) : !overview ? (
        <EmptyState className="p-5">Loading…</EmptyState>
      ) : !overview.installed ? (
        <NotInstalled overview={overview} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[320px] shrink-0 overflow-auto border-r border-border py-1">
            {overview.jobs.length === 0 && (
              <EmptyState>No jobs yet. Create one with “New job”.</EmptyState>
            )}
            {overview.jobs.map((j) => (
              <button
                key={j.job_id}
                onClick={() => setSelectedId(j.job_id)}
                className={cn(
                  "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover",
                  j.job_id === selectedId && "bg-bg-hover",
                )}
              >
                <span className="flex items-center gap-2">
                  <StatusDot status={j.last_status} paused={!j.active} />
                  <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", !j.active && "text-fg-muted")}>
                    {jobLabel(j)}
                  </span>
                  {!j.active && <Chip>paused</Chip>}
                  {j.recent_failures > 0 && (
                    <Chip tone="danger" title={`${j.recent_failures} of the last ${j.recent_runs} runs failed`}>
                      {j.recent_failures} failed
                    </Chip>
                  )}
                </span>
                <span className="flex items-center gap-2 pl-4 text-[10px] text-fg-muted">
                  <span className="truncate">{describeSchedule(j.schedule) ?? j.schedule}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-fg-subtle">
                    {j.last_start ? relativeTime(parsePgTimestamp(j.last_start)) : "never ran"}
                  </span>
                </span>
              </button>
            ))}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <JobDetail
                key={selected.job_id}
                connectionId={connectionId}
                job={selected}
                readOnly={readOnly}
                hasRunDetails={overview.has_run_details}
                runsEpoch={runsEpoch}
                onEdit={() => setEditing({ job: selected })}
                onToggle={() => void toggleActive(selected)}
                onDelete={() => setDeleting(selected)}
              />
            ) : (
              <EmptyState className="p-5">Select a job to see its definition and run history.</EmptyState>
            )}
          </section>
        </div>
      )}

      {editing && overview && (
        <JobEditDialog
          connectionId={connectionId}
          job={editing.job}
          existingNames={overview.jobs.map((j) => j.name ?? "")}
          currentDatabase={overview.current_database}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setSelectedId(id);
            load();
          }}
        />
      )}
      {deleting && (
        <DeleteJobDialog
          connectionId={connectionId}
          job={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={load}
        />
      )}
    </>
  );
}

function NotInstalled({ overview }: { overview: CronOverview }) {
  const elsewhere = overview.cron_database && overview.cron_database !== overview.current_database;
  return (
    <div className="max-w-xl space-y-2 p-5 text-xs text-fg-muted">
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <AlertTriangle size={14} className="text-warn" /> pg_cron isn't available in{" "}
        {overview.current_database}
      </p>
      {elsewhere ? (
        <p>
          pg_cron keeps its jobs in a single database, and this server is configured to use{" "}
          <code className="font-mono text-fg">{overview.cron_database}</code>. Switch to that database
          from the Explorer's database menu and open this window again — jobs can still run commands in
          any database.
        </p>
      ) : (
        <>
          <p>
            The extension isn't installed here. A superuser can enable it once the server loads the
            library:
          </p>
          <pre className="select-text rounded-lg border border-border bg-bg p-2.5 font-mono text-[11px] text-fg">
            {`-- postgresql.conf (needs a restart)\nshared_preload_libraries = 'pg_cron'\ncron.database_name = '${overview.current_database}'\n\n-- then, in that database\nCREATE EXTENSION pg_cron;`}
          </pre>
          <p>Managed services (RDS, Cloud SQL, Supabase, …) expose this as a setting in their console.</p>
        </>
      )}
    </div>
  );
}

function JobDetail({
  connectionId,
  job,
  readOnly,
  hasRunDetails,
  runsEpoch,
  onEdit,
  onToggle,
  onDelete,
}: {
  connectionId: string;
  job: CronJob;
  readOnly: boolean;
  hasRunDetails: boolean;
  runsEpoch: number;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [runs, setRuns] = useState<CronRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!hasRunDetails) return;
    let cancelled = false;
    cronJobRuns(connectionId, job.job_id, 200)
      .then((r) => !cancelled && (setRuns(r), setRunsError(null)))
      .catch((e) => !cancelled && setRunsError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, job.job_id, hasRunDetails, runsEpoch]);

  const openInTab = () => {
    const tabs = useTabsStore.getState();
    const id = tabs.addTab(job.command, connectionId);
    tabs.renameTab(id, jobLabel(job));
    useUiStore.getState().setCronOpen(false);
    toast.message("Command opened in a new tab — run it there to test it");
  };

  const succeeded = runs?.filter((r) => r.status === "succeeded").length ?? 0;
  const failed = runs?.filter((r) => r.status === "failed").length ?? 0;
  const description = describeSchedule(job.schedule);

  return (
    <>
      <div className="shrink-0 space-y-2.5 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusDot status={job.last_status} paused={!job.active} />
          <h3 className="min-w-0 truncate text-sm font-semibold">{jobLabel(job)}</h3>
          <span className="shrink-0 text-[11px] text-fg-subtle">#{job.job_id}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button onClick={onToggle} disabled={readOnly} title={job.active ? "Stop scheduling this job" : "Schedule this job again"}>
              {job.active ? <Pause size={11} /> : <Play size={11} />} {job.active ? "Pause" : "Resume"}
            </Button>
            <Button onClick={onEdit} disabled={readOnly}>
              <Pencil size={11} /> Edit
            </Button>
            <IconButton className="hover:text-danger" title="Delete job" disabled={readOnly} onClick={onDelete}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-fg-subtle">Schedule</dt>
          <dd>
            <code className="rounded bg-fg/8 px-1.5 py-px font-mono text-[11px]">{job.schedule}</code>
            {description && <span className="ml-2 text-fg-muted">{description}</span>}
          </dd>
          <dt className="text-fg-subtle">Runs in</dt>
          <dd className="text-fg-muted">
            database <span className="text-fg">{job.database}</span> as <span className="text-fg">{job.username}</span>
          </dd>
          <dt className="text-fg-subtle">Last run</dt>
          <dd className="text-fg-muted">
            {job.last_start ? (
              <>
                <span className={cn(statusTone(job.last_status) === "danger" ? "text-danger" : "text-fg")}>
                  {job.last_status}
                </span>{" "}
                · {formatTimestamp(job.last_start)}
                {job.last_duration_ms != null && <> · {formatDuration(job.last_duration_ms)}</>}
              </>
            ) : (
              "never"
            )}
          </dd>
        </dl>

        <div className="relative">
          <pre className="max-h-28 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-2.5 pr-24 font-mono text-[11px] leading-relaxed">
            {job.command}
          </pre>
          <button
            className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-bg-elev px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:text-fg"
            onClick={openInTab}
            title="Open the command in a query tab"
          >
            <ArrowUpRight size={10} /> Open in tab
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
        Run history
        {runs && runs.length > 0 && (
          <span className="font-normal normal-case tracking-normal text-fg-subtle">
            last {runs.length} · {succeeded} succeeded{failed > 0 && <span className="text-danger"> · {failed} failed</span>}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-border">
        {!hasRunDetails ? (
          <EmptyState className="px-4">
            Run history isn't readable (cron.job_run_details is missing or you lack SELECT on it).
          </EmptyState>
        ) : runsError ? (
          <EmptyState className="px-4 text-danger">{runsError}</EmptyState>
        ) : runs === null ? (
          <EmptyState className="px-4">Loading…</EmptyState>
        ) : runs.length === 0 ? (
          <EmptyState className="px-4">This job hasn't run yet.</EmptyState>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <tbody>
              {runs.map((r) => {
                const tone = statusTone(r.status);
                const open = expanded === r.run_id;
                return (
                  <tr
                    key={r.run_id}
                    className={cn("cursor-pointer align-top hover:bg-bg-hover/60", open && "bg-bg-hover/60")}
                    onClick={() => setExpanded(open ? null : r.run_id)}
                  >
                    <td className="w-6 border-b border-border/40 py-1.5 pl-4">
                      <StatusDot status={r.status} />
                    </td>
                    <td
                      className={cn(
                        "w-24 border-b border-border/40 py-1.5 pr-3",
                        tone === "danger" ? "text-danger" : tone === "ok" ? "text-fg" : "text-warn",
                      )}
                    >
                      {r.status}
                    </td>
                    <td
                      className="w-44 whitespace-nowrap border-b border-border/40 py-1.5 pr-3 tabular-nums text-fg-muted"
                      title={relativeTime(parsePgTimestamp(r.start_time))}
                    >
                      {formatTimestamp(r.start_time)}
                    </td>
                    <td className="w-20 whitespace-nowrap border-b border-border/40 py-1.5 pr-3 text-right tabular-nums text-fg-muted">
                      {r.duration_ms != null ? formatDuration(r.duration_ms) : "—"}
                    </td>
                    <td className="max-w-0 border-b border-border/40 py-1.5 pr-4 font-mono text-[11px] text-fg-muted">
                      <div className={cn(open ? "select-text whitespace-pre-wrap break-words" : "truncate")}>
                        {r.message ?? ""}
                      </div>
                      {open && r.command !== job.command && (
                        <div className="mt-1 select-text whitespace-pre-wrap break-words text-fg-subtle">
                          command at the time: {r.command}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function JobEditDialog({
  connectionId,
  job,
  existingNames,
  currentDatabase,
  onClose,
  onSaved,
}: {
  connectionId: string;
  job: CronJob | null;
  /** Names already in use: pg_cron's schedule() silently replaces a job of the same name. */
  existingNames: string[];
  currentDatabase: string;
  onClose: () => void;
  onSaved: (jobId: number) => void;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 3 * * *");
  const [command, setCommand] = useState(job?.command ?? "");
  const [database, setDatabase] = useState(job?.database ?? currentDatabase);
  const [active, setActive] = useState(job?.active ?? true);
  const [databases, setDatabases] = useState<string[]>([job?.database ?? currentDatabase]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listDatabases(connectionId)
      .then((d) => alive && setDatabases(d.map((x) => x.name)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connectionId]);

  const description = useMemo(() => describeSchedule(schedule), [schedule]);
  const nameTaken = !job && name.trim() !== "" && existingNames.includes(name.trim());
  const valid =
    schedule.trim() !== "" && command.trim() !== "" && (job != null || (name.trim() !== "" && !nameTaken));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await cronSaveJob(connectionId, {
        job_id: job?.job_id ?? null,
        name: name.trim(),
        schedule: schedule.trim(),
        command: command.trim(),
        // Only name the database when it isn't the default, so pg_cron's plain
        // schedule() is used wherever possible.
        database: database === currentDatabase && !job ? null : database,
        active,
      });
      toast.success(job ? "Job updated" : "Job created");
      onSaved(id);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="w-[600px] space-y-3" hideClose={busy}>
        <DialogTitle>{job ? `Edit ${jobLabel(job)}` : "New scheduled job"}</DialogTitle>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              autoFocus={!job}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nightly-cleanup"
              // pg_cron has no rename; the name identifies the job.
              disabled={!!job}
              title={job ? "A job can't be renamed — delete and recreate it" : undefined}
              className={cn(job && "opacity-60", nameTaken && "border-danger focus:border-danger")}
            />
            {nameTaken && (
              <p className="text-[10px] text-danger">A job with this name exists — edit that one instead.</p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Database</Label>
            <select
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              className="h-[26px] w-full rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-fg-muted"
            >
              {[...new Set([database, ...databases])].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1">
          <Label>Schedule</Label>
          <div className="flex items-center gap-2">
            <Input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="*/5 * * * *"
              className="w-44 font-mono"
              spellCheck={false}
            />
            <span className={cn("truncate text-[11px]", description ? "text-fg" : "text-fg-subtle")}>
              {description ?? "minute hour day-of-month month day-of-week — or “N seconds”"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1 pt-0.5">
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.schedule}
                type="button"
                onClick={() => setSchedule(p.schedule)}
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-[10px] transition-colors",
                  schedule.trim() === p.schedule
                    ? "border-fg bg-fg text-bg"
                    : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-fg-subtle">Times follow the server's cron.timezone (GMT unless changed).</p>
        </div>

        <div className="space-y-1">
          <Label>Command</Label>
          <textarea
            autoFocus={!!job}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="DELETE FROM events WHERE created_at < now() - interval '30 days'"
            spellCheck={false}
            className="h-36 w-full resize-y rounded-lg border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
          />
        </div>

        <Toggle checked={active} onChange={setActive} label="Active" hint="A paused job keeps its definition but is not scheduled" />

        {error && (
          <p className="select-text whitespace-pre-wrap break-words rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => void save()} disabled={busy || !valid}>
            {busy ? "Saving…" : job ? "Save changes" : "Create job"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteJobDialog({
  connectionId,
  job,
  onClose,
  onDeleted,
}: {
  connectionId: string;
  job: CronJob;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    try {
      await cronDeleteJob(connectionId, job.job_id);
      toast.success(`${jobLabel(job)} deleted`);
      onDeleted();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="w-[420px] space-y-3" hideClose={busy}>
        <DialogTitle className="flex items-center gap-2 text-danger">
          <AlertTriangle size={15} /> Delete {jobLabel(job)}
        </DialogTitle>
        <p className="text-xs text-fg-muted">
          The job stops running and its definition is removed. Past runs stay in the history table.
        </p>
        {error && <p className="select-text text-[11px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            {busy ? "Deleting…" : "Delete job"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
