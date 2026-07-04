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

export {};
