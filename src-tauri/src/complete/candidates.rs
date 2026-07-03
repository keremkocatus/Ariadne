//! Clause'a göre aday üretimi + ranking (design 04 §4-5). Saf fonksiyonlar;
//! SchemaCache okur, DB'ye gitmez.

use crate::cache::{RelKind, SchemaCache, Table};

use super::context::{Clause, CompletionContext, RelRef};
use super::{CompletionItem, CompletionKind};

/// Dahili aday: `filter` fuzzy eşleştirme anahtarı (alias öneki olmadan).
struct Cand {
    label: String,
    insert: String,
    kind: CompletionKind,
    is_snippet: bool,
    detail: Option<String>,
    filter: String,
    base: i32, // clause-içi öncelik (yüksek = üstte)
}

pub fn generate(cache: &SchemaCache, ctx: &CompletionContext) -> Vec<CompletionItem> {
    if ctx.suppress {
        return Vec::new();
    }

    let mut cands: Vec<Cand> = Vec::new();
    match ctx.clause {
        Clause::SelectList | Clause::Where | Clause::Having | Clause::GroupBy | Clause::OrderBy | Clause::Returning => {
            columns_candidates(cache, ctx, &mut cands);
            if ctx.qualifier.is_none() {
                function_candidates(cache, &mut cands, false);
                if ctx.clause == Clause::SelectList {
                    push_kw(&mut cands, &["*", "DISTINCT", "CASE", "COUNT(*)"]);
                }
            }
        }
        Clause::From => {
            relation_candidates(cache, ctx, &mut cands);
            function_candidates(cache, &mut cands, true); // set-returning
        }
        Clause::JoinTarget => {
            join_candidates(cache, ctx, &mut cands);
            relation_candidates(cache, ctx, &mut cands);
        }
        Clause::JoinOn => {
            join_on_candidates(cache, ctx, &mut cands);
        }
        Clause::InsertCols | Clause::UpdateSet => {
            // Hedef tablo: tek relation.
            columns_candidates(cache, ctx, &mut cands);
        }
        Clause::Unknown => {
            push_kw(&mut cands, &["SELECT", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH"]);
            relation_candidates(cache, ctx, &mut cands);
        }
    }

    rank(ctx, cands)
}

// ---- Kolonlar ----

fn columns_candidates(cache: &SchemaCache, ctx: &CompletionContext, out: &mut Vec<Cand>) {
    let multi = ctx.relations.len() > 1;

    // qualifier varsa sadece o relation.
    let rels: Vec<&RelRef> = match &ctx.qualifier {
        Some(q) => ctx.relations.iter().filter(|r| r.matches(q)).collect(),
        None => ctx.relations.iter().collect(),
    };

    for rel in rels {
        let alias = rel.alias.clone().unwrap_or_else(|| rel.name.clone());
        // CTE kolonları
        if rel.is_cte {
            for c in &rel.cte_columns {
                out.push(col_cand(c, &alias, multi && ctx.qualifier.is_none(), None));
            }
            continue;
        }
        if let Some(t) = resolve_rel(cache, rel) {
            let prefix_alias = multi && ctx.qualifier.is_none();
            for c in &t.columns {
                let detail = format!("{}{}", c.type_name, if c.not_null { ", not null" } else { "" });
                out.push(col_cand(&c.name, &alias, prefix_alias, Some(detail)));
            }
        }
    }
}

fn col_cand(col: &str, alias: &str, prefix_alias: bool, detail: Option<String>) -> Cand {
    let (label, insert) = if prefix_alias {
        (format!("{alias}.{col}"), format!("{alias}.{col}"))
    } else {
        (col.to_string(), col.to_string())
    };
    Cand {
        label,
        insert,
        kind: CompletionKind::Column,
        is_snippet: false,
        detail,
        filter: col.to_string(),
        base: 100,
    }
}

// ---- İlişkiler (FROM) ----

fn relation_candidates(cache: &SchemaCache, ctx: &CompletionContext, out: &mut Vec<Cand>) {
    // CTE adları (aynı statement'ta tanımlı).
    for r in &ctx.relations {
        if r.is_cte {
            out.push(Cand {
                label: r.name.clone(),
                insert: r.name.clone(),
                kind: CompletionKind::Table,
                is_snippet: false,
                detail: Some("cte".into()),
                filter: r.name.clone(),
                base: 90,
            });
        }
    }

    for t in cache.tables.values() {
        if t.kind == RelKind::Sequence {
            continue;
        }
        let in_path = cache.search_path.iter().any(|s| s == &t.schema || s == "$user");
        let label = if in_path { t.name.clone() } else { format!("{}.{}", t.schema, t.name) };
        let kind = match t.kind {
            RelKind::View | RelKind::MatView => CompletionKind::View,
            _ => CompletionKind::Table,
        };
        let detail = if t.estimated_rows > 0 {
            Some(format!("{} · ~{} rows", t.schema, t.estimated_rows))
        } else {
            Some(t.schema.clone())
        };
        out.push(Cand {
            label: label.clone(),
            insert: label,
            kind,
            is_snippet: false,
            detail,
            filter: t.name.clone(),
            base: if in_path { 80 } else { 60 },
        });
    }
    let _ = ctx;
}

// ---- FK-güdümlü JOIN (design 04 §4 ⭐) ----

fn join_candidates(cache: &SchemaCache, ctx: &CompletionContext, out: &mut Vec<Cand>) {
    let taken: Vec<String> = ctx
        .relations
        .iter()
        .filter_map(|r| r.alias.clone().or_else(|| Some(r.name.clone())))
        .collect();

    for rel in &ctx.relations {
        let Some(t) = resolve_rel(cache, rel) else { continue };
        let a_r = rel.alias.clone().unwrap_or_else(|| t.name.clone());
        let Some(edges) = cache.fk_adjacency.get(&t.id) else { continue };

        for e in edges {
            // Karşı tabloyu ve ON kolon çiftlerini yönüne göre belirle.
            let (other_id, r_cols, o_cols) = if e.from_table == t.id {
                (e.to_table, &e.from_cols, &e.to_cols)
            } else {
                (e.from_table, &e.to_cols, &e.from_cols)
            };
            let Some(other) = cache.tables.get(&other_id) else { continue };
            let a_o = gen_alias(&other.name, &taken);

            // Yeni (join edilen) tablonun kolonu önce: "orders o ON o.user_id = u.id".
            let on: Vec<String> = r_cols
                .iter()
                .zip(o_cols.iter())
                .filter_map(|(&rc, &oc)| {
                    Some(format!(
                        "{a_o}.{} = {a_r}.{}",
                        other.columns.get(oc)?.name,
                        t.columns.get(rc)?.name
                    ))
                })
                .collect();
            if on.is_empty() {
                continue;
            }
            let on_str = on.join(" AND ");
            let insert = format!("{} {a_o} ON {on_str}", other.name);
            out.push(Cand {
                label: insert.clone(),
                insert,
                kind: CompletionKind::Join,
                is_snippet: false,
                detail: Some(format!("FK {}", e.constraint_name)),
                filter: other.name.clone(),
                base: 200, // FK bağlı tablo her şeyin üstünde
            });
        }
    }
}

fn join_on_candidates(cache: &SchemaCache, ctx: &CompletionContext, out: &mut Vec<Cand>) {
    // Önce FK eşleşen tam koşul (design 04 §4 JoinOn).
    let resolved: Vec<(&RelRef, &Table)> = ctx
        .relations
        .iter()
        .filter_map(|r| resolve_rel(cache, r).map(|t| (r, t)))
        .collect();

    for (ri, ti) in &resolved {
        let ai = ri.alias.clone().unwrap_or_else(|| ti.name.clone());
        if let Some(edges) = cache.fk_adjacency.get(&ti.id) {
            for e in edges {
                let (other_id, i_cols, o_cols) = if e.from_table == ti.id {
                    (e.to_table, &e.from_cols, &e.to_cols)
                } else {
                    (e.from_table, &e.to_cols, &e.from_cols)
                };
                if let Some((rj, tj)) = resolved.iter().find(|(_, t)| t.id == other_id) {
                    let aj = rj.alias.clone().unwrap_or_else(|| tj.name.clone());
                    let cond: Vec<String> = i_cols
                        .iter()
                        .zip(o_cols.iter())
                        .filter_map(|(&ic, &oc)| {
                            Some(format!("{ai}.{} = {aj}.{}", ti.columns.get(ic)?.name, tj.columns.get(oc)?.name))
                        })
                        .collect();
                    if !cond.is_empty() {
                        let s = cond.join(" AND ");
                        out.push(Cand {
                            label: s.clone(),
                            insert: s,
                            kind: CompletionKind::Column,
                            is_snippet: false,
                            detail: Some("FK".into()),
                            filter: tj.name.clone(),
                            base: 300,
                        });
                    }
                }
            }
        }
    }
    // Sonra iki taraftaki kolonlar.
    columns_candidates(cache, ctx, out);
}

// ---- Fonksiyonlar ----

fn function_candidates(cache: &SchemaCache, out: &mut Vec<Cand>, set_returning_only: bool) {
    for f in cache.functions.values() {
        if set_returning_only && !f.return_type.to_lowercase().starts_with("setof") {
            continue;
        }
        let in_path = cache.search_path.iter().any(|s| s == &f.schema || s == "$user");
        let name = if in_path { f.name.clone() } else { format!("{}.{}", f.schema, f.name) };
        out.push(Cand {
            label: f.signature(),
            insert: format!("{name}(${{0}})"),
            kind: CompletionKind::Function,
            is_snippet: true,
            detail: Some(f.return_type.clone()),
            filter: f.name.clone(),
            base: 40,
        });
    }
}

// ---- Keyword'ler ----

fn push_kw(out: &mut Vec<Cand>, kws: &[&str]) {
    for k in kws {
        out.push(Cand {
            label: k.to_string(),
            insert: k.to_string(),
            kind: CompletionKind::Keyword,
            is_snippet: false,
            detail: None,
            filter: k.to_string(),
            base: 10,
        });
    }
}

// ---- Yardımcılar ----

fn resolve_rel<'a>(cache: &'a SchemaCache, rel: &RelRef) -> Option<&'a Table> {
    if rel.is_cte || rel.name.is_empty() {
        return None;
    }
    super::resolve_named(cache, rel.schema.as_deref(), &rel.name)
}

fn gen_alias(name: &str, taken: &[String]) -> String {
    let lower = name.to_lowercase();
    for len in 1..=lower.len() {
        let cand: String = lower.chars().take(len).collect();
        if !taken.iter().any(|t| t.eq_ignore_ascii_case(&cand)) {
            return cand;
        }
    }
    lower
}

// ---- Ranking (design 04 §5) ----

fn rank(ctx: &CompletionContext, cands: Vec<Cand>) -> Vec<CompletionItem> {
    let prefix = ctx.prefix.to_lowercase();
    let mut scored: Vec<(i32, Cand)> = cands
        .into_iter()
        .filter_map(|c| {
            let fs = fuzzy_score(&prefix, &c.filter.to_lowercase())?;
            Some((c.base + fs, c))
        })
        .collect();

    // Skora göre azalan; eşitlikte alfabetik.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.label.cmp(&b.1.label)));
    scored.truncate(50);

    scored
        .into_iter()
        .enumerate()
        .map(|(i, (_, c))| CompletionItem {
            label: c.label,
            kind: c.kind,
            insert_text: c.insert,
            is_snippet: c.is_snippet,
            detail: c.detail,
            sort_key: format!("{i:04}"),
        })
        .collect()
}

/// Skorlu subsequence eşleşmesi; eşleşmezse None (design 04 §5).
fn fuzzy_score(prefix: &str, text: &str) -> Option<i32> {
    if prefix.is_empty() {
        return Some(0);
    }
    if text == prefix {
        return Some(1000);
    }
    if text.starts_with(prefix) {
        return Some(500 - (text.len() as i32 - prefix.len() as i32));
    }
    let pb = prefix.as_bytes();
    let tb = text.as_bytes();
    let mut qi = 0;
    let mut score = 0;
    let mut prev = -2i32;
    let mut word_start = true;
    for (ti, &c) in tb.iter().enumerate() {
        if qi < pb.len() && c == pb[qi] {
            let mut s = 5;
            if ti as i32 == prev + 1 {
                s += 10;
            }
            if word_start {
                s += 15;
            }
            score += s;
            prev = ti as i32;
            qi += 1;
        }
        word_start = c == b'_' || c == b'.';
    }
    if qi == pb.len() {
        Some(score - text.len() as i32)
    } else {
        None
    }
}
