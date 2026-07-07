// Load Monaco from the bundle, NOT from a CDN (local-first). @monaco-editor/react
// pulls Monaco from a CDN by default; loader.config points it at the npm package.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Only the base editor worker is needed. Vite's ?worker import emits the worker as a
// separate bundle.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });

// Custom editor themes matching the app's monochrome palette (src/index.css).
// Monaco's stock vs/vs-dark themes clash with it (saturated #A31515 strings on
// light, blue keywords). Monaco's basic `pgsql` tokenizer emits only: keyword,
// operator, predefined, identifier, identifier.quote, string, number, comment,
// delimiter.* — rules cover exactly those; anything else would never match.
monaco.editor.defineTheme("ariadne-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "EDEDED" },
    { token: "keyword", foreground: "8FB4D8" },
    { token: "predefined", foreground: "AFA3CE" },
    { token: "string", foreground: "A9BE93" },
    { token: "number", foreground: "D0B17E" },
    { token: "comment", foreground: "6B6B72", fontStyle: "italic" },
    { token: "operator", foreground: "9A9AA2" },
    { token: "identifier", foreground: "EDEDED" },
    { token: "identifier.quote", foreground: "EDEDED" },
    { token: "delimiter", foreground: "8A8A90" },
  ],
  colors: {
    "editor.background": "#0b0b0c",
    "editor.foreground": "#ededed",
    "editor.lineHighlightBackground": "#141416",
    "editor.selectionBackground": "#2e2e33",
    "editor.inactiveSelectionBackground": "#232327",
    "editorLineNumber.foreground": "#4c4c53",
    "editorLineNumber.activeForeground": "#8a8a90",
    "editorCursor.foreground": "#ededed",
    "editorWidget.background": "#141416",
    "editorWidget.border": "#26262a",
    "editorSuggestWidget.selectedBackground": "#26262a",
    "editorIndentGuide.background1": "#1c1c1f",
  },
});

monaco.editor.defineTheme("ariadne-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "", foreground: "18181B" },
    { token: "keyword", foreground: "3B6EA8" },
    { token: "predefined", foreground: "6B5F92" },
    { token: "string", foreground: "5F7A54" },
    { token: "number", foreground: "8A6D33" },
    { token: "comment", foreground: "8E8E95", fontStyle: "italic" },
    { token: "operator", foreground: "52525B" },
    { token: "identifier", foreground: "18181B" },
    { token: "identifier.quote", foreground: "18181B" },
    { token: "delimiter", foreground: "6B6B73" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#18181b",
    "editor.lineHighlightBackground": "#f4f4f5",
    "editor.selectionBackground": "#dcdce1",
    "editorLineNumber.foreground": "#b3b3b9",
    "editorLineNumber.activeForeground": "#6b6b73",
    "editorCursor.foreground": "#18181b",
    "editorWidget.background": "#f4f4f5",
    "editorWidget.border": "#d9d9de",
  },
});

export {};
