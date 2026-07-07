import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  isAriadneError,
  testConnection,
  type ConnectionProfile,
  type ProfileInput,
  type SslMode,
} from "@/lib/api";

const SSL_MODES: SslMode[] = ["disable", "prefer", "require", "verify_ca", "verify_full"];

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The profile to edit; if absent, a new profile. */
  existing?: ConnectionProfile | null;
  /** Connect immediately after saving. */
  onSaved?: (profileId: string) => void;
}

export function ProfileDialog({ open, onOpenChange, existing, onSaved }: Props) {
  const saveProfile = useConnectionStore((s) => s.saveProfile);
  const profiles = useConnectionStore((s) => s.profiles);
  const hasLiveConnections = useConnectionStore(
    (s) => !!existing && Object.values(s.connections).some((c) => c.profile_id === existing.id),
  );
  const [busy, setBusy] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [f, setF] = useState(() => initialForm(existing));

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  function toInput(): ProfileInput {
    return {
      id: existing?.id,
      name: f.name.trim() || `${f.user}@${f.host}`,
      color: f.color || null,
      host: f.host.trim(),
      port: Number(f.port) || 5432,
      database: f.database.trim(),
      user: f.user.trim(),
      ssl_mode: f.ssl_mode,
      statement_timeout_ms: null,
      read_only: f.read_only,
      options: {},
    };
  }

  async function onTest() {
    setBusy(true);
    try {
      const r = await testConnection(toInput(), f.password || undefined);
      toast.success("Connection successful", {
        description: `PostgreSQL ${r.server_version} · ${r.latency_ms} ms`,
      });
    } catch (e) {
      toast.error("Connection failed", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  async function onSave(connectAfter: boolean) {
    if (!f.host || !f.database || !f.user) {
      toast.error("Host, database and user are required");
      return;
    }
    // Same fallback as toInput(): a blank name becomes user@host.
    const name = f.name.trim() || `${f.user}@${f.host}`;
    if (profiles.some((p) => p.name === name && p.id !== existing?.id)) {
      toast.error(`A profile named "${name}" already exists`);
      return;
    }
    setBusy(true);
    try {
      const saved = await saveProfile(
        toInput(),
        clearPassword ? undefined : f.password || undefined,
        clearPassword,
      );
      toast.success("Profile saved");
      onOpenChange(false);
      if (connectAfter) onSaved?.(saved.id);
    } catch (e) {
      toast.error("Could not save", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{existing ? "Edit connection" : "New connection"}</DialogTitle>
        <DialogDescription>Password is stored in the OS keychain, never on disk.</DialogDescription>
        {hasLiveConnections && (
          <p className="mt-2 rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-fg-muted">
            This profile has active connections — changes apply on the next connect.
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <Field label="Name" className="col-span-2">
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="prod-analytics" />
          </Field>
          <Field label="Host" className="col-span-2">
            <Input value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="localhost" />
          </Field>
          <Field label="Port">
            <Input value={f.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Database">
            <Input value={f.database} onChange={(e) => set("database", e.target.value)} placeholder="postgres" />
          </Field>
          <Field label="User">
            <Input value={f.user} onChange={(e) => set("user", e.target.value)} placeholder="postgres" />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={clearPassword ? "" : f.password}
              disabled={clearPassword}
              onChange={(e) => set("password", e.target.value)}
              placeholder={existing ? "(leave blank to keep)" : ""}
            />
            {existing && (
              <label className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                />
                Clear stored password
              </label>
            )}
          </Field>
          <Field label="SSL mode">
            <select
              value={f.ssl_mode}
              onChange={(e) => set("ssl_mode", e.target.value as SslMode)}
              className="w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-fg-muted"
            >
              {SSL_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Strip color (prod cue)">
            <Input value={f.color ?? ""} onChange={(e) => set("color", e.target.value)} placeholder="#e5484d" />
          </Field>
          <label className="col-span-2 mt-1 flex items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              checked={f.read_only}
              onChange={(e) => set("read_only", e.target.checked)}
            />
            Read-only (prod safety — <span className="text-fg-muted">default_transaction_read_only=on</span>)
          </label>
        </div>

        <div className="mt-4 flex justify-between">
          <Button onClick={onTest} disabled={busy}>
            Test
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => onSave(false)} disabled={busy}>
              Save
            </Button>
            <Button variant="default" onClick={() => onSave(true)} disabled={busy}>
              Save & Connect
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function initialForm(p?: ConnectionProfile | null) {
  return {
    name: p?.name ?? "",
    host: p?.host ?? "localhost",
    port: String(p?.port ?? 5432),
    database: p?.database ?? "postgres",
    user: p?.user ?? "postgres",
    password: "",
    ssl_mode: (p?.ssl_mode ?? "prefer") as SslMode,
    read_only: p?.read_only ?? false,
    color: p?.color ?? "",
  };
}

function errMsg(e: unknown): string {
  return isAriadneError(e) ? e.message : String(e);
}
