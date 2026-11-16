// Users & Roles. The sidebar lists the roles of the server; selecting one shows its
// attributes and the actions on it. Every change goes through a dialog that shows the
// exact SQL before it runs (see RoleDialogs).
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Pencil, Plus, RefreshCw, Search, Shield, Trash2, User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { fuzzyMatch } from "@/lib/fuzzy";
import { listRoles, type RoleInfo } from "@/lib/api";
import { formatTimestamp } from "@/lib/pgFormat";
import { Chip, EmptyState, IconButton, Section } from "@/components/ui/primitives";
import { QuickActionMenu } from "@/components/explorer/QuickActionMenu";
import { useConnectionStore } from "@/stores/connectionStore";
import { DropRoleDialog, PrivilegesDialog, RoleEditDialog } from "./RoleDialogs";

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; role: RoleInfo }
  | { kind: "privileges"; role: RoleInfo }
  | { kind: "drop"; role: RoleInfo }
  | null;

function roleIcon(r: RoleInfo) {
  if (r.is_superuser) return <Shield size={12} className="shrink-0 text-warn" />;
  if (r.can_login) return <User size={12} className="shrink-0 text-fg-muted" />;
  return <Users size={12} className="shrink-0 text-fg-muted" />;
}

export function RolesPanel({ connectionId }: { connectionId: string | null }) {
  const [roles, setRoles] = useState<RoleInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<{ role: RoleInfo; x: number; y: number } | null>(null);
  const readOnly = useConnectionStore((s) => s.isReadOnly(connectionId));

  const load = useCallback(() => {
    if (!connectionId) return;
    setError(false);
    listRoles(connectionId)
      .then(setRoles)
      .catch(() => setError(true));
  }, [connectionId]);

  useEffect(() => {
    setRoles(null);
    setSelected(null);
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!roles) return [];
    const q = search.trim();
    if (!q) return roles;
    return roles
      .map((r) => ({ r, m: fuzzyMatch(q, r.name) }))
      .filter((x) => x.m.matched)
      .sort((a, b) => b.m.score - a.m.score)
      .map((x) => x.r);
  }, [roles, search]);

  // Predefined pg_* roles are grant targets, not things to manage; keep them out of
  // the way unless the user is searching.
  const own = filtered.filter((r) => !r.is_system);
  const system = filtered.filter((r) => r.is_system);
  const sel = roles?.find((r) => r.name === selected) ?? null;

  if (!connectionId) return <EmptyState>Select a connection</EmptyState>;

  const row = (r: RoleInfo) => (
    <button
      key={r.name}
      onClick={() => setSelected(r.name === selected ? null : r.name)}
      onDoubleClick={() => !r.is_system && setDialog({ kind: "edit", role: r })}
      onContextMenu={(e) => {
        e.preventDefault();
        setSelected(r.name);
        setMenu({ role: r, x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "flex h-6 w-full items-center gap-1.5 px-2 text-left text-xs transition-colors hover:bg-bg-hover",
        r.name === selected && "bg-bg-hover",
      )}
    >
      {roleIcon(r)}
      <span className="truncate">{r.name}</span>
      {r.is_current && <Chip tone="strong">you</Chip>}
      {!r.can_login && !r.is_system && (
        <span className="ml-auto shrink-0 text-[10px] text-fg-subtle">group</span>
      )}
    </button>
  );

  return (
    <div
      className="flex h-full flex-col"
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
      }}
    >
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roles…"
            className="w-full rounded-md border border-border bg-bg py-1 pl-6 pr-2 text-xs outline-none transition-colors placeholder:text-fg-subtle focus:border-border-strong"
          />
        </div>
        <button
          title={readOnly ? "This profile is read-only" : "New role"}
          disabled={readOnly}
          onClick={() => setDialog({ kind: "create" })}
          className="rounded-md border border-border p-1 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
        <button
          title="Refresh"
          onClick={load}
          className="rounded-md border border-border p-1 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
        >
          <RefreshCw size={13} className={cn(roles === null && !error && "animate-spin")} />
        </button>
      </div>

      {error ? (
        <EmptyState>Couldn't load roles</EmptyState>
      ) : roles === null ? (
        <EmptyState>Loading roles…</EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {filtered.length === 0 && <EmptyState>No roles</EmptyState>}
          {own.map(row)}
          {system.length > 0 && (
            <Section
              // Remount when a search starts so the group opens to show its matches.
              key={search.trim() ? "open" : "closed"}
              title="Predefined"
              count={system.length}
              defaultOpen={search.trim() !== ""}
              className="mt-1 border-t border-border/60 bg-bg px-2"
            >
              <div className="-mx-2">{system.map(row)}</div>
            </Section>
          )}
        </div>
      )}

      {sel && (
        <RoleDetail
          role={sel}
          readOnly={readOnly}
          onEdit={() => setDialog({ kind: "edit", role: sel })}
          onPrivileges={() => setDialog({ kind: "privileges", role: sel })}
          onDrop={() => setDialog({ kind: "drop", role: sel })}
        />
      )}

      {menu && (
        <QuickActionMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={[
            {
              label: "Edit role…",
              icon: <Pencil size={12} />,
              disabled: readOnly || menu.role.is_system,
              onClick: () => setDialog({ kind: "edit", role: menu.role }),
            },
            {
              label: "Privileges…",
              icon: <KeyRound size={12} />,
              onClick: () => setDialog({ kind: "privileges", role: menu.role }),
            },
            "separator",
            {
              label: "Drop role…",
              icon: <Trash2 size={12} />,
              danger: true,
              disabled: readOnly || menu.role.is_system || menu.role.is_current,
              onClick: () => setDialog({ kind: "drop", role: menu.role }),
            },
          ]}
        />
      )}

      {dialog?.kind === "create" && (
        <RoleEditDialog
          connectionId={connectionId}
          role={null}
          allRoles={roles ?? []}
          onClose={() => setDialog(null)}
          onSaved={(name) => {
            load();
            setSelected(name);
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <RoleEditDialog
          connectionId={connectionId}
          role={dialog.role}
          allRoles={roles ?? []}
          onClose={() => setDialog(null)}
          onSaved={(name) => {
            load();
            setSelected(name);
          }}
        />
      )}
      {dialog?.kind === "privileges" && (
        <PrivilegesDialog
          connectionId={connectionId}
          role={dialog.role}
          readOnly={readOnly}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "drop" && (
        <DropRoleDialog
          connectionId={connectionId}
          role={dialog.role}
          onClose={() => setDialog(null)}
          onDropped={() => {
            setSelected(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RoleDetail({
  role,
  readOnly,
  onEdit,
  onPrivileges,
  onDrop,
}: {
  role: RoleInfo;
  readOnly: boolean;
  onEdit: () => void;
  onPrivileges: () => void;
  onDrop: () => void;
}) {
  const attrs: [string, boolean][] = [
    ["login", role.can_login],
    ["superuser", role.is_superuser],
    ["create db", role.create_db],
    ["create role", role.create_role],
    ["replication", role.replication],
    ["bypass rls", role.bypass_rls],
  ];
  const locked = readOnly || role.is_system;
  return (
    <div className="max-h-[50%] shrink-0 overflow-auto border-t border-border bg-bg-elev p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        {roleIcon(role)}
        <span className="min-w-0 truncate font-medium">{role.name}</span>
        <div className="ml-auto flex shrink-0">
          <IconButton className="h-6 w-6" title={locked ? "Not editable" : "Edit role"} disabled={locked} onClick={onEdit}>
            <Pencil size={12} />
          </IconButton>
          <IconButton className="h-6 w-6" title="Privileges" onClick={onPrivileges}>
            <KeyRound size={12} />
          </IconButton>
          <IconButton
            className="h-6 w-6 hover:text-danger"
            title={role.is_current ? "You are logged in as this role" : "Drop role"}
            disabled={locked || role.is_current}
            onClick={onDrop}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>
      {role.comment && <p className="mt-1 text-[11px] text-fg-muted">{role.comment}</p>}

      <div className="mt-2 flex flex-wrap gap-1">
        {attrs
          .filter(([, on]) => on)
          .map(([label]) => (
            <Chip key={label} tone={label === "superuser" ? "warn" : "strong"}>
              {label}
            </Chip>
          ))}
        {!role.can_login && <Chip>no login</Chip>}
        {!role.inherit && <Chip>no inherit</Chip>}
      </div>

      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-fg-subtle">Member of</dt>
        <dd className="min-w-0 break-words">{role.member_of.length ? role.member_of.join(", ") : "—"}</dd>
        {role.members.length > 0 && (
          <>
            <dt className="text-fg-subtle">Members</dt>
            <dd className="min-w-0 break-words">{role.members.join(", ")}</dd>
          </>
        )}
        <dt className="text-fg-subtle">Connections</dt>
        <dd>{role.connection_limit < 0 ? "unlimited" : `up to ${role.connection_limit}`}</dd>
        <dt className="text-fg-subtle">Password expires</dt>
        <dd>
          {!role.valid_until || role.valid_until === "infinity" ? "never" : formatTimestamp(role.valid_until)}
        </dd>
      </dl>
    </div>
  );
}
