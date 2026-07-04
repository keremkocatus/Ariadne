// Users & Roles görünümü (design 15 §P1-U4, salt-okunur). pg_roles listesi +
// fuzzy arama + satır detayı. CRUD YOK — tek köprü: seçili rol için GRANT/ALTER
// şablonunu yeni tab'da üret (koşturmaz).
import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, Shield, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { fuzzyMatch } from "@/lib/fuzzy";
import { listRoles, type RoleInfo } from "@/lib/api";
import { useTabsStore } from "@/stores/tabsStore";

export function RolesPanel({ connectionId }: { connectionId: string | null }) {
  const [roles, setRoles] = useState<RoleInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => {
    if (!connectionId) return;
    setRoles(null);
    setError(false);
    listRoles(connectionId)
      .then(setRoles)
      .catch(() => setError(true));
  };

  useEffect(() => {
    load();
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

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

  const sel = roles?.find((r) => r.name === selected) ?? null;

  if (!connectionId) return <Empty text="Select a connection" />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roles…"
            className="w-full rounded border border-border bg-bg py-1 pl-6 pr-2 text-xs outline-none focus:border-fg-muted"
          />
        </div>
        <button
          title="Refresh"
          onClick={load}
          className="rounded border border-border p-1 text-fg-muted hover:text-fg"
        >
          <RefreshCw size={13} className={cn(roles === null && !error && "animate-spin")} />
        </button>
      </div>

      {error ? (
        <Empty text="Couldn't load roles" />
      ) : roles === null ? (
        <Empty text="Loading roles…" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {filtered.length === 0 && <Empty text="No roles" />}
          {filtered.map((r) => (
            <button
              key={r.name}
              onClick={() => setSelected(r.name === selected ? null : r.name)}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-bg-elev",
                r.name === selected && "bg-bg-elev",
              )}
            >
              {r.is_superuser ? (
                <Shield size={12} className="shrink-0 text-warn" />
              ) : (
                <User size={12} className="shrink-0 text-fg-muted" />
              )}
              <span className="truncate">{r.name}</span>
              {!r.can_login && <span className="ml-auto shrink-0 text-[9px] text-fg-muted">no login</span>}
            </button>
          ))}
        </div>
      )}

      {sel && <RoleDetail role={sel} connectionId={connectionId} />}
    </div>
  );
}

function RoleDetail({ role, connectionId }: { role: RoleInfo; connectionId: string }) {
  const attrs: [string, boolean][] = [
    ["SUPERUSER", role.is_superuser],
    ["LOGIN", role.can_login],
    ["CREATEDB", role.create_db],
    ["CREATEROLE", role.create_role],
    ["REPLICATION", role.replication],
  ];
  const openTemplate = () => {
    const q = role.name;
    const sql =
      `-- Templates for role "${q}" — edit and run manually (nothing is executed for you).\n` +
      `-- GRANT USAGE ON SCHEMA public TO "${q}";\n` +
      `-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${q}";\n` +
      `-- ALTER ROLE "${q}" WITH LOGIN;\n` +
      `-- ALTER ROLE "${q}" VALID UNTIL 'infinity';\n`;
    const id = useTabsStore.getState().addTab(sql, connectionId);
    useTabsStore.getState().renameTab(id, `role: ${q}`);
  };

  return (
    <div className="max-h-[45%] overflow-auto border-t border-border bg-bg-elev p-2 text-xs">
      <div className="mb-1 font-medium">{role.name}</div>
      <div className="mb-2 flex flex-wrap gap-1">
        {attrs.map(([label, on]) => (
          <span
            key={label}
            className={cn(
              "rounded px-1 text-[9px]",
              on ? "bg-fg/10 text-fg" : "bg-transparent text-fg-muted line-through opacity-60",
            )}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="text-[11px] text-fg-muted">
        Valid until: {role.valid_until ?? "—"}
      </div>
      <div className="mt-1 text-[11px] text-fg-muted">
        Member of: {role.member_of.length > 0 ? role.member_of.join(", ") : "—"}
      </div>
      <button
        onClick={openTemplate}
        className="mt-2 rounded border border-border px-2 py-1 text-[11px] hover:border-fg-muted"
      >
        Generate GRANT/ALTER template →
      </button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-3 text-xs text-fg-muted">{text}</div>;
}
