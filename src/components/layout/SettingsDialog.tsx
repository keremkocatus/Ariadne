import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useUiStore } from "@/stores/uiStore";
import { checkForUpdateManually } from "@/lib/updater";

// The settings modal. Deliberately minimal — the point is the settings infrastructure
// (modal + store + palette "Open settings"); it can move to a local store if the list grows.
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const settings = useUiStore((s) => s.settings);
  const update = useUiStore((s) => s.updateSettings);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (open) void getVersion().then(setVersion);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Local preferences, stored on this machine.</DialogDescription>

        <div className="mt-4 space-y-4 text-xs">
          <Field label="Theme" hint="Switches the whole UI and the SQL editor.">
            <div className="flex overflow-hidden rounded border border-border">
              {(["dark", "light"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update({ theme: t })}
                  className={
                    settings.theme === t
                      ? "bg-fg px-2.5 py-0.5 capitalize text-bg"
                      : "px-2.5 py-0.5 capitalize text-fg-muted hover:text-fg"
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Editor font size" hint="Applies live to the SQL editor.">
            <input
              type="number"
              min={9}
              max={28}
              value={settings.editorFontSize}
              onChange={(e) => update({ editorFontSize: clamp(9, 28, Math.round(+e.target.value) || 13) })}
              className="w-20 rounded border border-border bg-bg px-1.5 py-0.5 outline-none focus:border-fg-muted"
            />
          </Field>

          <Field
            label="Schema stale threshold (minutes)"
            hint="On switching to an already-open connection, refresh its cached schema in the background when older than this."
          >
            <input
              type="number"
              min={0}
              max={120}
              value={settings.schemaStaleMinutes}
              onChange={(e) => update({ schemaStaleMinutes: clamp(0, 120, Math.round(+e.target.value) || 0) })}
              className="w-20 rounded border border-border bg-bg px-1.5 py-0.5 outline-none focus:border-fg-muted"
            />
          </Field>

          <Field
            label="Long-query notice (seconds)"
            hint="Toast + tab dot when a background tab's query finishes and took at least this long. 0 disables the toast."
          >
            <input
              type="number"
              min={0}
              max={600}
              value={settings.longQueryNoticeSeconds}
              onChange={(e) => update({ longQueryNoticeSeconds: clamp(0, 600, Math.round(+e.target.value) || 0) })}
              className="w-20 rounded border border-border bg-bg px-1.5 py-0.5 outline-none focus:border-fg-muted"
            />
          </Field>

          <div className="border-t border-border pt-3 text-fg-muted">
            <div className="font-medium text-fg">Result paging</div>
            <div className="mt-0.5 text-[11px]">
              Up to 100,000 rows are kept per tab; further pages are fetched on scroll. (Tunable in a
              later version.)
            </div>
          </div>

          <Field label="Version" hint={version ? `Ariadne ${version}` : undefined}>
            <button
              onClick={checkForUpdateManually}
              className="rounded border border-border px-2.5 py-0.5 text-fg hover:bg-fg/10"
            >
              Check for updates
            </button>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-fg-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function clamp(min: number, max: number, v: number): number {
  return Math.max(min, Math.min(max, v));
}
