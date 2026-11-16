import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/primitives";
import { LogoMark } from "@/components/brand/Logo";
import { findLogo, LOGOS } from "@/components/brand/logos";
import { useUiStore } from "@/stores/uiStore";
import { checkForUpdateManually } from "@/lib/updater";
import { cn } from "@/lib/utils";

// The settings modal: local preferences only, persisted with the UI store.
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const settings = useUiStore((s) => s.settings);
  const update = useUiStore((s) => s.updateSettings);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (open) void getVersion().then(setVersion);
  }, [open]);

  const usedSnippets = settings.snippets.filter((s) => s.sql.trim()).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[88vh] w-[540px] flex-col gap-0 p-0">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Local preferences, stored on this machine.</DialogDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4 text-xs">
          <Group title="Appearance">
            <Field label="Theme" hint="Switches the whole UI and the SQL editor.">
              <Segmented
                value={settings.theme}
                onChange={(theme) => update({ theme })}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </Field>

            <div>
              <div className="font-medium">Logo</div>
              <div className="mt-0.5 text-[11px] text-fg-muted">
                {findLogo(settings.logo).note} Used in the toolbar and as the window icon.
              </div>
              <div className="mt-2 grid grid-cols-6 gap-1.5">
                {LOGOS.map((logo) => {
                  const selected = logo.id === findLogo(settings.logo).id;
                  return (
                    <button
                      key={logo.id}
                      onClick={() => update({ logo: logo.id })}
                      title={logo.name}
                      aria-pressed={selected}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-lg border px-1 pb-1 pt-2 transition-colors",
                        selected
                          ? "border-fg bg-bg text-fg"
                          : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                      )}
                    >
                      <LogoMark id={logo.id} size={30} />
                      <span className="w-full truncate text-center text-[9px]">{logo.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Field label="Editor font size" hint="Applies live to the SQL editor.">
              <NumberInput
                min={9}
                max={28}
                value={settings.editorFontSize}
                onChange={(v) => update({ editorFontSize: v })}
                fallback={13}
              />
            </Field>
          </Group>

          <Group title="Behavior">
            <Field
              label="Schema stale threshold (minutes)"
              hint="On switching to an already-open connection, refresh its cached schema in the background when older than this."
            >
              <NumberInput
                min={0}
                max={120}
                value={settings.schemaStaleMinutes}
                onChange={(v) => update({ schemaStaleMinutes: v })}
                fallback={0}
              />
            </Field>

            <Field
              label="Long-query notice (seconds)"
              hint="Toast + tab dot when a background tab's query finishes and took at least this long. 0 disables the toast."
            >
              <NumberInput
                min={0}
                max={600}
                value={settings.longQueryNoticeSeconds}
                onChange={(v) => update({ longQueryNoticeSeconds: v })}
                fallback={0}
              />
            </Field>

            <Field
              label="Snippets"
              hint={`Saved queries on Ctrl+1 … Ctrl+0 — ${usedSnippets} of ${settings.snippets.length} slots in use.`}
            >
              <TextButton
                onClick={() => {
                  setOpen(false);
                  useUiStore.getState().setSnippetsOpen(true);
                }}
              >
                Edit snippets
              </TextButton>
            </Field>

            <div className="text-fg-muted">
              <div className="font-medium text-fg">Result paging</div>
              <div className="mt-0.5 text-[11px]">
                Up to 100,000 rows are kept per tab; further pages are fetched on scroll.
              </div>
            </div>
          </Group>

          <Group title="About">
            <Field label="Version" hint={version ? `Ariadne ${version}` : undefined}>
              <TextButton onClick={checkForUpdateManually}>Check for updates</TextButton>
            </Field>
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
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

function TextButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-border px-2.5 py-1 text-fg transition-colors hover:bg-bg-hover"
    >
      {children}
    </button>
  );
}

function NumberInput({
  min,
  max,
  value,
  onChange,
  fallback,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  /** Used when the field is cleared or holds something that isn't a number. */
  fallback: number;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(+e.target.value) || fallback)))}
      className="w-20 rounded-md border border-border bg-bg px-1.5 py-1 outline-none transition-colors focus:border-border-strong"
    />
  );
}
