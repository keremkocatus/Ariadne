// Monaco'yu CDN'den DEĞİL, bundle'dan yükle (local-first prensibi, design 00 §5).
// @monaco-editor/react varsayılan olarak monaco'yu CDN'den çeker; loader.config ile
// npm paketindeki monaco'ya yönlendiriyoruz.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Sadece temel editör worker'ı gerekiyor (M0'da dil servisi/completion yok).
// Vite'ın ?worker import'u worker'ı ayrı bir bundle olarak üretir.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });

export {};
