// Reconstructs a CREATE script for a relation from its catalog details. Postgres has
// no `SHOW CREATE TABLE`, so this is assembled from the same pieces pg_dump uses
// (pg_get_constraintdef / pg_get_indexdef / pg_get_triggerdef). It is meant for
// reading and as a starting point, not as a byte-exact dump.
import type { RelationFull } from "./api";
import { quoteIdent, quoteLiteral } from "./pgFormat";

function qualified(rel: { schema: string; name: string }): string {
  return `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`;
}

function columnLine(c: RelationFull["columns"][number]): string {
  let line = `${quoteIdent(c.name)} ${c.type_name}`;
  if (c.is_generated && c.default_expr) {
    line += ` GENERATED ALWAYS AS (${c.default_expr}) STORED`;
  } else if (c.identity) {
    line += ` GENERATED ${c.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
  } else if (c.default_expr) {
    line += ` DEFAULT ${c.default_expr}`;
  }
  if (c.not_null) line += " NOT NULL";
  return line;
}

export function buildDdl(rel: RelationFull): string {
  const name = qualified(rel);
  const out: string[] = [];

  if (rel.kind === "view" || rel.kind === "mat_view") {
    const kw = rel.kind === "view" ? "CREATE OR REPLACE VIEW" : "CREATE MATERIALIZED VIEW";
    const body = (rel.view_definition ?? "").trim().replace(/;$/, "");
    out.push(`${kw} ${name} AS\n${body};`);
  } else if (rel.kind === "sequence") {
    out.push(`CREATE SEQUENCE ${name};`);
  } else if (rel.partition_of) {
    // A partition inherits its columns and constraints from the parent.
    out.push(
      `CREATE TABLE ${name} PARTITION OF ${qualified(rel.partition_of)}\n    ${rel.partition_bound ?? "DEFAULT"};`,
    );
  } else {
    const lines = [
      ...rel.columns.map(columnLine),
      ...rel.constraints.map((c) => `CONSTRAINT ${quoteIdent(c.name)} ${c.definition}`),
    ];
    const kw = rel.kind === "foreign" ? "CREATE FOREIGN TABLE" : "CREATE TABLE";
    const partition = rel.partition_key ? `\nPARTITION BY ${rel.partition_key}` : "";
    out.push(`${kw} ${name} (\n${lines.map((l) => `    ${l}`).join(",\n")}\n)${partition};`);
  }

  // Indexes that back a constraint are created by that constraint.
  const constraintNames = new Set(rel.constraints.map((c) => c.name));
  const indexes = rel.indexes.filter((ix) => !constraintNames.has(ix.name));
  if (indexes.length) out.push(indexes.map((ix) => `${ix.definition};`).join("\n"));

  if (rel.triggers.length) {
    out.push(
      rel.triggers
        .map((t) => {
          const disable = t.enabled
            ? ""
            : `\nALTER TABLE ${name} DISABLE TRIGGER ${quoteIdent(t.name)};`;
          return `${t.definition};${disable}`;
        })
        .join("\n"),
    );
  }

  const comments: string[] = [];
  if (rel.comment) {
    const kind =
      rel.kind === "view"
        ? "VIEW"
        : rel.kind === "mat_view"
          ? "MATERIALIZED VIEW"
          : rel.kind === "sequence"
            ? "SEQUENCE"
            : "TABLE";
    comments.push(`COMMENT ON ${kind} ${name} IS ${quoteLiteral(rel.comment)};`);
  }
  for (const c of rel.columns) {
    if (c.comment) {
      comments.push(`COMMENT ON COLUMN ${name}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`);
    }
  }
  if (comments.length) out.push(comments.join("\n"));

  return out.join("\n\n") + "\n";
}
