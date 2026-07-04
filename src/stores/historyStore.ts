import { create } from "zustand";

// Cap on retained entries — history is a convenience log, not an archive.
const MAX_ENTRIES = 200;

export interface HistoryEntry {
  id: string;
  /// The SQL that actually ran (a selection if one was run, else the full tab text).
  sql: string;
  /// The connection the query ran on, resolved to a human label at record time
  /// (profile name, falling back to the database). The connection may be gone later.
  connectionLabel: string;
  /// Epoch milliseconds when the run finished.
  at: number;
  status: "ok" | "error";
  /// Rows fetched (SELECT) or affected (DML); null when neither applies.
  rowCount: number | null;
  elapsedMs: number;
  errorMessage?: string;
}

interface HistoryState {
  entries: HistoryEntry[];
  add: (entry: Omit<HistoryEntry, "id">) => void;
  clear: () => void;
}

/// Query history is intentionally session-only: a plain store with NO persist
/// middleware, so it starts empty on every launch.
export const useHistoryStore = create<HistoryState>((set) => ({
  entries: [],
  add: (entry) =>
    set((s) => ({
      entries: [{ ...entry, id: crypto.randomUUID() }, ...s.entries].slice(0, MAX_ENTRIES),
    })),
  clear: () => set({ entries: [] }),
}));
