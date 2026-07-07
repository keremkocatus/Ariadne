// Monaco SQL providers. They live OUTSIDE the React tree, registered once at the
// language level, and read which connection to use from the value set by
// `setActiveConnection` (not from a global store) — since App renders only the
// active tab's SqlEditor at a time, that corresponds to that tab's connection.
import * as monaco from "monaco-editor";
import { getCompletions, getSignatureHelp, type CompletionKind } from "@/lib/api";

const LANG = "ariadne-pgsql";
let registered = false;
let activeConnectionId: string | null = null;

export function setActiveConnection(connectionId: string | null) {
  activeConnectionId = connectionId;
}

export function registerSqlProviders() {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider(LANG, {
    triggerCharacters: [".", " ", "(", ","],
    async provideCompletionItems(model, position) {
      const connId = activeConnectionId;
      if (!connId) return { suggestions: [] };

      const offset = model.getOffsetAt(position);
      let res;
      try {
        res = await getCompletions(connId, model.getValue(), offset);
      } catch {
        return { suggestions: [] };
      }

      const startPos = model.getPositionAt(res.replace_range.start);
      const endPos = model.getPositionAt(res.replace_range.end);
      const range = new monaco.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column,
      );

      return {
        suggestions: res.items.map((it) => ({
          label: it.label,
          kind: mapKind(it.kind),
          insertText: it.insert_text,
          insertTextRules: it.is_snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: it.detail ?? undefined,
          // Order comes from Rust; Monaco's own sort is pinned via sortText.
          sortText: it.sort_key,
          range,
        })),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(LANG, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position) {
      const connId = activeConnectionId;
      if (!connId) return null;
      const offset = model.getOffsetAt(position);
      let sig;
      try {
        sig = await getSignatureHelp(connId, model.getValue(), offset);
      } catch {
        return null;
      }
      if (!sig) return null;
      return {
        value: {
          signatures: [
            {
              label: sig.label,
              parameters: sig.parameters.map((p) => ({ label: p })),
            },
          ],
          activeSignature: 0,
          activeParameter: sig.active_parameter,
        },
        dispose() {},
      };
    },
  });
}

function mapKind(kind: CompletionKind): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "table":
      return K.Struct;
    case "view":
      return K.Interface;
    case "column":
      return K.Field;
    case "function":
      return K.Function;
    case "schema":
      return K.Module;
    case "keyword":
      return K.Keyword;
    case "join":
      return K.Snippet;
  }
}
