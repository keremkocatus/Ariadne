// The dialogs behind the Roles panel: create/edit a role, manage its privileges, drop
// it. Each one builds its statements with lib/roleSql and shows them before running,
// so there is never a hidden side effect.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Chip, EmptyState, IconButton, Segmented, Toggle } from "@/components/ui/primitives";
import {
  executeStatements,
  getRoleGrants,
  isAriadneError,
  type RoleGrant,
  type RoleInfo,
} from "@/lib/api";
import {
  alterRoleSql,
  createRoleSql,
  dropRoleSql,
  emptyRoleForm,
  grantSql,
  maskPasswords,
  presetSql,
  revokeSql,
  roleToForm,
  SCOPE_LABELS,
  SCOPE_PRIVILEGES,
  type GrantScope,
  type RoleForm,
} from "@/lib/roleSql";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";

const errorText = (e: unknown) => (isAriadneError(e) ? e.message : String(e));

/// The statements a dialog is about to run. Passwords are masked for display only.
function SqlPreview({ statements, empty }: { statements: string[]; empty: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg">
      <div className="border-b border-border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
        SQL to run
      </div>
      {statements.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] text-fg-subtle">{empty}</div>
      ) : (
        <pre className="max-h-32 select-text overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-muted">
          {statements.map((s) => `${maskPasswords(s)};`).join("\n")}
        </pre>
      )}
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11px] text-danger">
      <AlertTriangle size={12} className="mt-px shrink-0" />
      <span className="min-w-0 select-text whitespace-pre-wrap break-words">{message}</span>
    </p>
  );
}

/// Runs `statements` and reports through the returned state; shared by all dialogs.
function useApply(connectionId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback(
    async (statements: string[]): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await executeStatements(connectionId, statements);
        return true;
      } catch (e) {
        setError(errorText(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [connectionId],
  );
  return { busy, error, apply, clearError: () => setError(null) };
}

// ---- Create / edit ----

export function RoleEditDialog({
  connectionId,
  role,
  allRoles,
  onClose,
  onSaved,
}: {
  connectionId: string;
  /** Null creates a new role. */
  role: RoleInfo | null;
  allRoles: RoleInfo[];
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const before = useMemo(() => (role ? roleToForm(role) : null), [role]);
  const [form, setForm] = useState<RoleForm>(() => before ?? emptyRoleForm());
  const [showPassword, setShowPassword] = useState(false);
  const [groupFilter, setGroupFilter] = useState("");
  const { busy, error, apply } = useApply(connectionId);
  const set = <K extends keyof RoleForm>(key: K, value: RoleForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const name = form.name.trim();
  const statements = useMemo(
    () => (name ? (before ? alterRoleSql(before, form) : createRoleSql(form)) : []),
    [before, form, name],
  );
  const groups = allRoles.filter(
    (r) => r.name !== role?.name && r.name.toLowerCase().includes(groupFilter.trim().toLowerCase()),
  );
  const toggleGroup = (g: string) =>
    set("memberOf", form.memberOf.includes(g) ? form.memberOf.filter((x) => x !== g) : [...form.memberOf, g]);

  const save = async () => {
    if (await apply(statements)) {
      toast.success(role ? `Role ${name} updated` : `Role ${name} created`);
      onSaved(name);
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-[560px] flex-col gap-0 p-0" hideClose={busy}>
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>{role ? `Edit role ${role.name}` : "New role"}</DialogTitle>
          <DialogDescription>
            {role ? "Only what you change is sent to the server." : "A role is a user when it can log in, a group otherwise."}
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="app_user" />
            </div>
            <div className="space-y-1">
              <Label>{role ? "New password" : "Password"}</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder={role ? "leave blank to keep" : "optional"}
                  autoComplete="new-password"
                  className="pr-7"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
                  title={showPassword ? "Hide" : "Show"}
                >
                  {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            </div>
          </div>

          <div>
            <Label>Attributes</Label>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-2">
              <Toggle checked={form.canLogin} onChange={(v) => set("canLogin", v)} label="Can log in" />
              <Toggle
                checked={form.inherit}
                onChange={(v) => set("inherit", v)}
                label="Inherits privileges"
                hint="Uses the privileges of the roles it is a member of without SET ROLE"
              />
              <Toggle checked={form.createDb} onChange={(v) => set("createDb", v)} label="Create databases" />
              <Toggle checked={form.createRole} onChange={(v) => set("createRole", v)} label="Create roles" />
              <Toggle checked={form.replication} onChange={(v) => set("replication", v)} label="Replication" />
              <Toggle
                checked={form.bypassRls}
                onChange={(v) => set("bypassRls", v)}
                label="Bypass row-level security"
              />
              <Toggle
                checked={form.superuser}
                onChange={(v) => set("superuser", v)}
                label="Superuser"
                hint="Bypasses every permission check"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Connection limit</Label>
              <Input
                type="number"
                min={-1}
                value={form.connectionLimit}
                onChange={(e) => set("connectionLimit", Math.max(-1, Math.trunc(+e.target.value || 0)))}
              />
              <p className="text-[10px] text-fg-subtle">-1 = unlimited</p>
            </div>
            <div className="space-y-1">
              <Label>Password valid until</Label>
              <Input
                value={form.validUntil}
                onChange={(e) => set("validUntil", e.target.value)}
                placeholder="never"
              />
              <p className="text-[10px] text-fg-subtle">e.g. 2027-01-01 or 2027-01-01 12:00+03</p>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label>Member of</Label>
              {allRoles.length > 12 && (
                <input
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                  placeholder="Filter roles…"
                  className="w-36 rounded-md border border-border bg-bg px-1.5 py-0.5 text-[11px] outline-none placeholder:text-fg-subtle focus:border-border-strong"
                />
              )}
            </div>
            <div className="flex max-h-24 flex-wrap gap-1 overflow-auto rounded-lg border border-border bg-bg p-1.5">
              {groups.length === 0 && <span className="px-1 text-[11px] text-fg-subtle">No other roles</span>}
              {groups.map((g) => {
                const on = form.memberOf.includes(g.name);
                return (
                  <button
                    key={g.name}
                    type="button"
                    onClick={() => toggleGroup(g.name)}
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                      on
                        ? "border-fg bg-fg text-bg"
                        : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                    )}
                  >
                    {g.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label>Comment</Label>
            <Input value={form.comment} onChange={(e) => set("comment", e.target.value)} placeholder="optional" />
          </div>

          <SqlPreview statements={statements} empty={name ? "No changes" : "Enter a name"} />
          <ErrorLine message={error} />
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => void save()} disabled={busy || statements.length === 0}>
            {busy ? "Applying…" : role ? "Save changes" : "Create role"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Drop ----

export function DropRoleDialog({
  connectionId,
  role,
  onClose,
  onDropped,
}: {
  connectionId: string;
  role: RoleInfo;
  onClose: () => void;
  onDropped: () => void;
}) {
  const [dropOwned, setDropOwned] = useState(false);
  const { busy, error, apply } = useApply(connectionId);
  const statements = dropRoleSql(role.name, dropOwned);
  const drop = async () => {
    if (await apply(statements)) {
      toast.success(`Role ${role.name} dropped`);
      onDropped();
      onClose();
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="w-[440px] space-y-3" hideClose={busy}>
        <DialogTitle className="flex items-center gap-2 text-danger">
          <AlertTriangle size={15} /> Drop role {role.name}
        </DialogTitle>
        <p className="text-xs text-fg-muted">
          This cannot be undone. Postgres refuses to drop a role that still owns objects or holds
          privileges.
        </p>
        <Toggle
          checked={dropOwned}
          onChange={setDropOwned}
          label="Drop what it owns in this database first"
          hint="DROP OWNED BY removes the role's objects and revokes its privileges in the current database"
        />
        {dropOwned && (
          <p className="text-[11px] text-warn">
            Tables, views and functions owned by {role.name} in this database will be deleted.
          </p>
        )}
        <SqlPreview statements={statements} empty="" />
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void drop()} disabled={busy}>
            {busy ? "Dropping…" : "Drop role"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Privileges ----

type GrantMode = "read_only" | "read_write" | "custom";

const TYPE_ORDER: RoleGrant["object_type"][] = ["database", "schema", "table", "view", "sequence", "function"];
const TYPE_TITLES: Record<RoleGrant["object_type"], string> = {
  database: "Database",
  schema: "Schemas",
  table: "Tables",
  view: "Views",
  sequence: "Sequences",
  function: "Functions",
};

export function PrivilegesDialog({
  connectionId,
  role,
  readOnly,
  onClose,
}: {
  connectionId: string;
  role: RoleInfo;
  readOnly: boolean;
  onClose: () => void;
}) {
  const database = useConnectionStore((s) => s.connections[connectionId]?.database ?? "");
  const snapshot = useSchemaStore((s) => s.byConnection[connectionId]?.snapshot);
  const schemas = useMemo(
    () => (snapshot?.schemas ?? []).filter((s) => !s.is_system),
    [snapshot],
  );

  const [grants, setGrants] = useState<RoleGrant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    getRoleGrants(connectionId, role.name)
      .then((g) => {
        setGrants(g);
        setLoadError(null);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [connectionId, role.name]);
  useEffect(load, [load]);

  const [mode, setMode] = useState<GrantMode>("read_only");
  const [schema, setSchema] = useState(() => schemas.find((s) => s.name === "public")?.name ?? schemas[0]?.name ?? "public");
  const [scope, setScope] = useState<GrantScope>("all_tables");
  const [table, setTable] = useState("");
  const [privileges, setPrivileges] = useState<string[]>(["SELECT"]);
  const [future, setFuture] = useState(true);
  const { busy, error, apply, clearError } = useApply(connectionId);

  const tables = useMemo(
    () =>
      (schemas.find((s) => s.name === schema)?.relations ?? [])
        .filter((r) => r.kind !== "sequence")
        .map((r) => r.name),
    [schemas, schema],
  );
  // Privileges differ per scope; keep only the ones that still apply when it changes.
  const changeScope = (next: GrantScope) => {
    setScope(next);
    setPrivileges((cur) => {
      const valid = cur.filter((p) => SCOPE_PRIVILEGES[next].includes(p));
      return valid.length ? valid : [SCOPE_PRIVILEGES[next][0]];
    });
  };
  const togglePrivilege = (p: string) =>
    setPrivileges((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const statements = useMemo(() => {
    if (mode !== "custom") return presetSql(mode, role.name, schema, future);
    if (scope === "table" && !table) return [];
    return grantSql({ role: role.name, scope, privileges, database, schema, table, future });
  }, [mode, role.name, schema, future, scope, table, privileges, database]);

  const grant = async () => {
    if (await apply(statements)) {
      toast.success(`Privileges granted to ${role.name}`);
      load();
    }
  };
  const revoke = async (g: RoleGrant) => {
    if (await apply([revokeSql(role.name, g)])) {
      toast.success(`Revoked on ${g.name}`);
      load();
    }
  };

  const grouped = TYPE_ORDER.map((type) => ({
    type,
    items: (grants ?? []).filter((g) => g.object_type === type),
  })).filter((g) => g.items.length > 0);
  const schemaWide = mode !== "custom" || scope.startsWith("all_");

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex h-[82vh] w-[720px] flex-col gap-0 p-0">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Privileges of {role.name}</DialogTitle>
          <DialogDescription>
            Granted directly to this role in <span className="text-fg">{database}</span>. Privileges that
            come from group membership{role.member_of.length ? ` (${role.member_of.join(", ")})` : ""} or
            from PUBLIC are not listed.
          </DialogDescription>
        </div>

        {!readOnly && (
          <div className="shrink-0 space-y-3 border-b border-border bg-bg/40 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">Grant</span>
              <Segmented
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  clearError();
                }}
                options={[
                  { value: "read_only", label: "Read only", title: "USAGE on the schema, SELECT on its tables and sequences" },
                  { value: "read_write", label: "Read & write", title: "USAGE on the schema, SELECT/INSERT/UPDATE/DELETE on its tables" },
                  { value: "custom", label: "Custom" },
                ]}
              />
              {mode === "custom" && (
                <Select value={scope} onChange={(v) => changeScope(v as GrantScope)}>
                  {(Object.keys(SCOPE_LABELS) as GrantScope[]).map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
              {(mode !== "custom" || scope !== "database") && (
                <>
                  <span className="text-[11px] text-fg-muted">in schema</span>
                  <Select
                    value={schema}
                    onChange={(next) => {
                      setSchema(next);
                      // The chosen table belonged to the previous schema.
                      setTable("");
                    }}
                  >
                    {schemas.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </>
              )}
              {mode === "custom" && scope === "table" && (
                <Select value={table} onChange={setTable}>
                  <option value="">choose a table…</option>
                  {tables.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            {mode === "custom" && (
              <div className="flex flex-wrap gap-1">
                {SCOPE_PRIVILEGES[scope].map((p) => {
                  const on = privileges.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePrivilege(p)}
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                        on
                          ? "border-fg bg-fg text-bg"
                          : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                      )}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            )}

            {schemaWide && (
              <Toggle
                checked={future}
                onChange={setFuture}
                label="Also apply to objects created later"
                hint="ALTER DEFAULT PRIVILEGES — covers objects YOU create in this schema from now on"
              />
            )}

            <SqlPreview statements={statements} empty="Choose what to grant" />
            <ErrorLine message={error} />
            <div className="flex justify-end">
              <Button variant="default" onClick={() => void grant()} disabled={busy || statements.length === 0}>
                {busy ? "Applying…" : "Grant"}
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {loadError ? (
            <ErrorLine message={loadError} />
          ) : grants === null ? (
            <EmptyState className="p-0">Loading…</EmptyState>
          ) : grouped.length === 0 ? (
            <EmptyState className="p-0">
              No direct privileges in this database.
              {role.is_superuser && " A superuser doesn't need any — it bypasses permission checks."}
            </EmptyState>
          ) : (
            grouped.map((g) => (
              <div key={g.type} className="mb-3 last:mb-0">
                <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                  {TYPE_TITLES[g.type]} <span className="font-normal text-fg-subtle">{g.items.length}</span>
                </h3>
                {g.items.map((it) => (
                  <div
                    key={`${it.schema ?? ""}.${it.name}`}
                    className="group flex min-h-7 items-center gap-2 border-b border-border/40 py-1 text-xs"
                  >
                    <span className="min-w-0 shrink truncate font-mono text-[11px]" title={it.name}>
                      {it.schema && <span className="text-fg-subtle">{it.schema}.</span>}
                      {it.name}
                    </span>
                    <div className="ml-auto flex flex-wrap justify-end gap-1">
                      {it.privileges.map((p) => (
                        <Chip key={p}>{p}</Chip>
                      ))}
                    </div>
                    {!readOnly && (
                      <IconButton
                        className="h-5 w-5 opacity-0 hover:text-danger group-hover:opacity-100"
                        title={`Revoke all on ${it.name}`}
                        disabled={busy}
                        onClick={() => void revoke(it)}
                      >
                        <Trash2 size={11} />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 max-w-[220px] rounded-md border border-border bg-bg px-1.5 text-xs text-fg outline-none focus:border-border-strong"
    >
      {children}
    </select>
  );
}
