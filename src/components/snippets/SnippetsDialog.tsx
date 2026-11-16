// Snippets: ten saved queries bound to Ctrl+1 … Ctrl+0. Pressing a slot's shortcut
// writes its query into the editor (unless it is already there) and runs it. Stored
// with the other local settings; edits save as you type.
import { useState } from "react";
import { ClipboardPaste, Eraser } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { getRunSelection } from "@/lib/editorRun";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabsStore";
import { SNIPPET_SLOTS, snippetKey, useUiStore } from "@/stores/uiStore";

function firstLine(sql: string): string {
  return sql.trim().split("\n", 1)[0] ?? "";
}

export function SnippetsDialog() {
  const open = useUiStore((s) => s.snippetsOpen);
  const setOpen = useUiStore((s) => s.setSnippetsOpen);
  const snippets = useUiStore((s) => s.settings.snippets);
  const setSnippet = useUiStore((s) => s.setSnippet);
  const [slot, setSlot] = useState(0);
  const current = snippets[slot] ?? { name: "", sql: "" };

  // Fills the slot from what the user is looking at: the selection, else the whole tab.
  const useEditorText = () => {
    const sql = getRunSelection()?.sql ?? useTabsStore.getState().active()?.sql ?? "";
    if (sql.trim()) setSnippet(slot, { ...current, sql: sql.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[70vh] w-[820px] max-w-[94vw] flex-col gap-0 p-0">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Snippets</DialogTitle>
          <DialogDescription>
            Press <Kbd>Ctrl</Kbd> + a digit to drop a saved query into the editor and run it. If the query
            is already in the editor it just runs.
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-[260px] shrink-0 overflow-auto border-r border-border py-1">
            {Array.from({ length: SNIPPET_SLOTS }, (_, i) => {
              const s = snippets[i];
              const filled = !!s?.sql.trim();
              return (
                <button
                  key={i}
                  onClick={() => setSlot(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover",
                    i === slot && "bg-bg-hover",
                  )}
                >
                  <Kbd dim={!filled}>Ctrl+{snippetKey(i)}</Kbd>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-xs", !filled && "text-fg-subtle")}>
                      {filled ? s.name.trim() || firstLine(s.sql) : "Empty"}
                    </span>
                    {filled && s.name.trim() && (
                      <span className="block truncate font-mono text-[10px] text-fg-subtle">{firstLine(s.sql)}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={current.name}
                onChange={(e) => setSnippet(slot, { ...current, name: e.target.value })}
                placeholder="e.g. Recent errors"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label>SQL</Label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={useEditorText}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
                    title="Use the editor's selection, or its whole text if nothing is selected"
                  >
                    <ClipboardPaste size={11} /> From editor
                  </button>
                  <button
                    onClick={() => setSnippet(slot, { name: "", sql: "" })}
                    disabled={!current.sql && !current.name}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                  >
                    <Eraser size={11} /> Clear
                  </button>
                </div>
              </div>
              <textarea
                // Remount per slot so the caret/scroll of one snippet doesn't carry over.
                key={slot}
                value={current.sql}
                onChange={(e) => setSnippet(slot, { ...current, sql: e.target.value })}
                placeholder={"SELECT *\nFROM error_logs\nORDER BY created_at DESC\nLIMIT 100;"}
                spellCheck={false}
                className="min-h-0 w-full flex-1 resize-none rounded-lg border border-border bg-bg p-2.5 font-mono text-xs leading-relaxed text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
              />
            </div>
            <p className="text-[11px] text-fg-subtle">
              Saved automatically on this machine. A new snippet lands on the cursor's line if that line
              is empty, otherwise on a new line below it.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Kbd({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <kbd
      className={cn(
        "shrink-0 rounded border border-border-strong bg-bg px-1.5 py-px font-mono text-[10px]",
        dim ? "text-fg-subtle" : "text-fg",
      )}
    >
      {children}
    </kbd>
  );
}
