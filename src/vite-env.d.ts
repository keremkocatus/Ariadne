/// <reference types="vite/client" />

// monaco-editor ships its basic-languages as untyped ESM; only pgsql is imported
// (monaco-setup.ts extends its tokenizer under the "ariadne-pgsql" language id).
declare module "monaco-editor/esm/vs/basic-languages/pgsql/pgsql.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage & { keywords: string[] };
}
