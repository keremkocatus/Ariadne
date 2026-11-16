// A thin bridge that carries the active editor's selection state to the run path
// ("run selection"). SqlEditor registers a getter on mount; the Toolbar and App read
// the selection from here when running. Same pattern as `setActiveConnection` in the
// Monaco providers — App renders only the active tab's editor at a time, so one
// getter is enough.

export interface RunSelection {
  /** The selected text (if there's a selection, only it runs). */
  sql: string;
  /** The selection's start offset in the full text (to place the error marker correctly). */
  selectionOffset: number;
}

let getter: (() => RunSelection | null) | null = null;

export function setRunSelectionGetter(fn: (() => RunSelection | null) | null) {
  getter = fn;
}

/** Returns the active editor's non-empty selection, or null. */
export function getRunSelection(): RunSelection | null {
  return getter ? getter() : null;
}

// SQL formatting in the active editor. SqlEditor registers the action on mount; the
// palette's "Format SQL" triggers it from here. In-editor Ctrl+K runs the Monaco
// command directly; this bridge is only for palette access.
let formatAction: (() => void) | null = null;

export function setFormatAction(fn: (() => void) | null) {
  formatAction = fn;
}

/** Runs formatting in the active editor (if registered). */
export function runFormatActive(): void {
  formatAction?.();
}

// Snippet placement in the active editor. A Ctrl+<digit> snippet must end up in the
// document (so the run is visible and repeatable) without duplicating itself: the
// placer finds an existing copy or inserts a new one, and reports where it is.
export interface PlacedSnippet {
  /** The snippet text exactly as it sits in the document. */
  sql: string;
  /** Its start offset in the full text. */
  selectionOffset: number;
}

let snippetPlacer: ((sql: string) => PlacedSnippet | null) | null = null;

export function setSnippetPlacer(fn: ((sql: string) => PlacedSnippet | null) | null) {
  snippetPlacer = fn;
}

/** Finds or inserts `sql` in the active editor. Null if no editor is mounted. */
export function placeSnippet(sql: string): PlacedSnippet | null {
  return snippetPlacer ? snippetPlacer(sql) : null;
}
