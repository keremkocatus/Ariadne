// Load Monaco from the bundle, NOT from a CDN (local-first). @monaco-editor/react
// pulls Monaco from a CDN by default; loader.config points it at the npm package.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import {
  conf as pgsqlConf,
  language as pgsqlLanguage,
} from "monaco-editor/esm/vs/basic-languages/pgsql/pgsql.js";

// Only the base editor worker is needed. Vite's ?worker import emits the worker as a
// separate bundle.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });

// "ariadne-pgsql": Monaco's built-in pgsql tokenizer, extended. The stock keyword
// list holds only PostgreSQL's ~90 RESERVED words — everyday DML/DDL like UPDATE,
// SET, DELETE, INSERT, BEGIN are unreserved in Postgres and would render as plain
// identifiers. A separate language id is used because the built-in registers its
// tokenizer lazily on first use and would overwrite an override under the same id.
monaco.languages.register({ id: "ariadne-pgsql" });
monaco.languages.setLanguageConfiguration("ariadne-pgsql", pgsqlConf);
monaco.languages.setMonarchTokensProvider("ariadne-pgsql", {
  ...pgsqlLanguage,
  tokenizer: {
    ...pgsqlLanguage.tokenizer,
    // The built-in root, with two additions: a lookahead rule tagging `name(` call
    // sites as `function`, and a `type` case for Postgres type names.
    root: [
      { include: "@comments" },
      { include: "@whitespace" },
      { include: "@pseudoColumns" },
      { include: "@numbers" },
      { include: "@strings" },
      { include: "@complexIdentifiers" },
      { include: "@scopes" },
      [/[;,.]/, "delimiter"],
      [/[()]/, "@brackets"],
      // Call sites: a word DIRECTLY followed by '(' (no whitespace — `INSERT INTO
      // t (cols)` writes the column-list paren with a space, `f(x)` doesn't; the
      // pragmatic heuristic every SQL grammar uses). Builtins win over keywords here
      // so `replace(x)` stays a builtin even though REPLACE is also a keyword.
      [
        /[\w@#$]+(?=\()/,
        {
          cases: {
            "@operators": "operator",
            "@builtinVariables": "predefined",
            "@builtinFunctions": "predefined",
            "@keywords": "keyword",
            "@default": "function",
          },
        },
      ],
      // Bare words: keywords win over builtins (CREATE OR REPLACE — REPLACE is a
      // keyword here, not the replace() function), and types win over builtins
      // (`text`/`date` as column types, not the same-named functions).
      [
        /[\w@#$]+/,
        {
          cases: {
            "@operators": "operator",
            "@builtinVariables": "predefined",
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@builtinFunctions": "predefined",
            "@default": "identifier",
          },
        },
      ],
      [/[<>=!%&+\-*/|~^]/, "operator"],
    ],
  },
  // Common Postgres type names (ignoreCase applies). Matched only when the word is
  // not a keyword/builtin, so e.g. INTERVAL stays a keyword in `AT TIME ZONE` use.
  typeKeywords: [
    "SMALLINT", "INTEGER", "INT", "INT2", "INT4", "INT8", "BIGINT",
    "DECIMAL", "NUMERIC", "REAL", "FLOAT4", "FLOAT8", "DOUBLE", "PRECISION", "VARYING",
    "SERIAL", "BIGSERIAL", "SMALLSERIAL", "MONEY",
    "TEXT", "VARCHAR", "CHARACTER", "CHAR", "BPCHAR", "NAME", "CITEXT",
    "BYTEA", "TIMESTAMP", "TIMESTAMPTZ", "DATE", "TIME", "TIMETZ",
    "BOOLEAN", "BOOL", "UUID", "JSON", "JSONB", "XML",
    "INET", "CIDR", "MACADDR", "MACADDR8", "BIT", "VARBIT",
    "TSVECTOR", "TSQUERY", "POINT", "LINE", "LSEG", "BOX", "PATH", "POLYGON", "CIRCLE",
    "OID", "REGCLASS", "REGTYPE", "VOID", "RECORD", "ANYELEMENT", "ANYARRAY",
  ],
  keywords: [
    ...pgsqlLanguage.keywords,
    // Unreserved-in-Postgres words that any SQL editor is expected to color.
    ...["UPDATE", "SET", "DELETE", "INSERT", "VALUES", "TRUNCATE", "MERGE", "REPLACE",
      "BEGIN", "START", "TRANSACTION", "WORK", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
      "ALTER", "DROP", "ADD", "RENAME", "OWNER", "INDEX", "VIEW", "MATERIALIZED",
      "SEQUENCE", "SCHEMA", "DATABASE", "EXTENSION", "TYPE", "DOMAIN",
      "FUNCTION", "PROCEDURE", "TRIGGER", "RETURNS", "RETURNING", "RETURN", "LANGUAGE",
      "IMMUTABLE", "STABLE", "VOLATILE", "STRICT", "SECURITY", "DEFINER", "INVOKER",
      "DECLARE", "CURSOR", "FETCH", "MOVE", "CLOSE", "EXPLAIN", "VACUUM", "REINDEX", "CLUSTER",
      "REVOKE", "COMMENT", "IF", "EXISTS", "TEMP", "TEMPORARY", "UNLOGGED",
      "CASCADE", "RESTRICT", "PARTITION", "OVER", "FILTER", "WITHIN",
      "ROWS", "RANGE", "PRECEDING", "FOLLOWING", "UNBOUNDED",
      "CONFLICT", "NOTHING", "KEY", "IDENTITY", "GENERATED", "STORED", "INCLUDE",
      "EXECUTE", "PREPARE", "DEALLOCATE", "LISTEN", "NOTIFY", "UNLISTEN",
      "COPY", "LOCK", "MODE", "NOWAIT", "SKIP", "LOCKED", "SHOW", "RESET", "CALL",
      "LOOP", "WHILE", "EXCEPTION", "ELSIF", "PERFORM", "RAISE", "NEXT", "QUERY",
      "BY", "NO", "DATA", "REFRESH", "OPTIONS", "AT", "ZONE", "INTERVAL"],
  ],
});

// Custom editor themes matching the app's monochrome palette (src/index.css).
// Monaco's stock vs/vs-dark themes clash with it (saturated #A31515 strings on
// light, blue keywords). The tokenizer emits only: keyword, operator, predefined,
// identifier, identifier.quote, string, number, comment, delimiter.* — rules cover
// exactly those; anything else would never match. The explicit `string.sql` rule is
// load-bearing: the inherited base themes ship a legacy `string.sql = FF0000` rule
// that is MORE specific than a plain `string` rule and would win (red strings).
monaco.editor.defineTheme("ariadne-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "EDEDED" },
    { token: "keyword", foreground: "8FB4D8" },
    { token: "predefined", foreground: "AFA3CE" },
    { token: "function", foreground: "D6D39B" },
    { token: "type", foreground: "6FB8A9" },
    { token: "string", foreground: "A9BE93" },
    { token: "string.sql", foreground: "A9BE93" },
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
    { token: "function", foreground: "795E26" },
    { token: "type", foreground: "2E7D74" },
    { token: "string", foreground: "5F7A54" },
    { token: "string.sql", foreground: "5F7A54" },
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
