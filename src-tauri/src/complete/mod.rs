//! Completion motoru (design 04). Tauri'den bağımsız saf modül — UI olmadan
//! unit test edilir (design 01 §4, 08 §1).

pub mod candidates;
pub mod context;

use serde::Serialize;

use crate::cache::{RelKind, SchemaCache, Table};

// ---- Frontend sözleşmesi (design 02 §3) ----

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionKind {
    Table,
    View,
    Column,
    Function,
    Schema,
    Keyword,
    Join,
}

#[derive(Debug, Serialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: CompletionKind,
    pub insert_text: String,
    pub is_snippet: bool,
    pub detail: Option<String>,
    pub sort_key: String,
}

#[derive(Debug, Serialize)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize)]
pub struct CompletionResult {
    pub items: Vec<CompletionItem>,
    pub replace_range: Range,
}

#[derive(Debug, Serialize)]
pub struct ObjColumn {
    pub name: String,
    pub type_name: String,
    pub not_null: bool,
    pub is_pk: bool,
}

#[derive(Debug, Serialize)]
pub struct ObjFk {
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub constraint_name: String,
}

#[derive(Debug, Serialize)]
pub struct ObjectInfo {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub estimated_rows: i64,
    pub comment: Option<String>,
    pub columns: Vec<ObjColumn>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ObjFk>,
}

#[derive(Debug, Serialize)]
pub struct SignatureHelp {
    pub label: String,
    pub parameters: Vec<String>,
    pub active_parameter: u32,
}

// ---- Orchestration ----

/// Ana completion girişi (design 04 §1).
pub fn complete(cache: &SchemaCache, sql: &str, offset: usize) -> CompletionResult {
    let ctx = context::analyze(sql, offset);
    let items = candidates::generate(cache, &ctx);
    let offset = offset.min(sql.len());
    let start = offset.saturating_sub(ctx.prefix.len());
    CompletionResult {
        items,
        replace_range: Range { start, end: offset },
    }
}

/// Alt+F1: imleçteki identifier'ı (alias dahil) cache'te çözüp nesne bilgisini döner.
pub fn object_info(cache: &SchemaCache, sql: &str, offset: usize) -> Option<ObjectInfo> {
    let (qual, name) = context::identifier_at(sql, offset)?;
    let ctx = context::analyze(sql, offset);

    // Önce alias olarak dene (relations içinde), sonra tablo adı olarak.
    let table = ctx
        .relations
        .iter()
        .find(|r| !r.is_cte && r.matches(&name))
        .and_then(|r| resolve_named(cache, r.schema.as_deref(), &r.name))
        .or_else(|| resolve_named(cache, qual.as_deref(), &name))?;

    Some(build_object_info(cache, table))
}

/// Signature help: imleç fonksiyon çağrısı içindeyse parametre ipucu (design 04 §6).
pub fn signature_help(cache: &SchemaCache, sql: &str, offset: usize) -> Option<SignatureHelp> {
    let (fname, active) = context::call_context(sql, offset)?;
    let ids = cache.function_by_name.get(&fname.to_lowercase())?;
    let f = cache.functions.get(ids.first()?)?;
    let parameters: Vec<String> = f
        .args
        .iter()
        .filter(|a| {
            use crate::cache::ArgMode::*;
            matches!(a.mode, In | InOut | Variadic)
        })
        .map(|a| match &a.name {
            Some(n) => format!("{n} {}", a.type_name),
            None => a.type_name.clone(),
        })
        .collect();
    Some(SignatureHelp {
        label: f.signature(),
        active_parameter: active.min(parameters.len().saturating_sub(1) as u32),
        parameters,
    })
}

fn build_object_info(cache: &SchemaCache, t: &Table) -> ObjectInfo {
    let pk_names: Vec<String> = t
        .primary_key
        .iter()
        .filter_map(|&i| t.columns.get(i).map(|c| c.name.clone()))
        .collect();

    let columns = t
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| ObjColumn {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
            not_null: c.not_null,
            is_pk: t.primary_key.contains(&i),
        })
        .collect();

    // Dışa giden FK'lar (bu tablonun from_table olduğu edge'ler).
    let foreign_keys = cache
        .fk_adjacency
        .get(&t.id)
        .map(|edges| {
            edges
                .iter()
                .filter(|e| e.from_table == t.id)
                .filter_map(|e| {
                    let other = cache.tables.get(&e.to_table)?;
                    Some(ObjFk {
                        columns: e.from_cols.iter().filter_map(|&i| t.columns.get(i).map(|c| c.name.clone())).collect(),
                        ref_table: format!("{}.{}", other.schema, other.name),
                        ref_columns: e.to_cols.iter().filter_map(|&i| other.columns.get(i).map(|c| c.name.clone())).collect(),
                        constraint_name: e.constraint_name.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    ObjectInfo {
        schema: t.schema.clone(),
        name: t.name.clone(),
        kind: rel_kind_str(t.kind).to_string(),
        estimated_rows: t.estimated_rows,
        comment: t.comment.clone(),
        columns,
        primary_key: pk_names,
        foreign_keys,
    }
}

fn rel_kind_str(k: RelKind) -> &'static str {
    match k {
        RelKind::Table => "table",
        RelKind::View => "view",
        RelKind::MatView => "materialized view",
        RelKind::Foreign => "foreign table",
        RelKind::Partitioned => "partitioned table",
        RelKind::Sequence => "sequence",
    }
}

/// Şema + ad → tablo (search_path önceliğiyle). candidates ve object_info ortak.
pub(super) fn resolve_named<'a>(
    cache: &'a SchemaCache,
    schema: Option<&str>,
    name: &str,
) -> Option<&'a Table> {
    if let Some(schema) = schema {
        let key = format!("{}.{}", schema, name).to_lowercase();
        return cache.table_by_qualified.get(&key).and_then(|id| cache.tables.get(id));
    }
    let ids = cache.table_by_name.get(&name.to_lowercase())?;
    let mut best: Option<&Table> = None;
    let mut best_rank = usize::MAX;
    for id in ids {
        if let Some(t) = cache.tables.get(id) {
            let rank = cache
                .search_path
                .iter()
                .position(|s| s == &t.schema)
                .unwrap_or(usize::MAX - 1);
            if rank < best_rank {
                best_rank = rank;
                best = Some(t);
            }
        }
    }
    best
}

#[cfg(test)]
mod golden {
    use super::*;
    use crate::cache::*;
    use chrono::Utc;

    /// design 08 §1 fixture: users(id,email), orders(id,user_id,total),
    /// FK orders.user_id → users.id, + set-returning fonksiyon.
    fn fixture() -> SchemaCache {
        let users = Table {
            id: 1,
            schema: "public".into(),
            name: "users".into(),
            kind: RelKind::Table,
            columns: vec![
                col("id", "int4", true, 1),
                col("email", "text", false, 2),
            ],
            primary_key: vec![0],
            comment: None,
            estimated_rows: 1000,
        };
        let orders = Table {
            id: 2,
            schema: "public".into(),
            name: "orders".into(),
            kind: RelKind::Table,
            columns: vec![
                col("id", "int4", true, 1),
                col("user_id", "int4", true, 2),
                col("total", "numeric", false, 3),
            ],
            primary_key: vec![0],
            comment: None,
            estimated_rows: 5000,
        };
        let fk = FkEdge {
            from_table: 2,
            from_cols: vec![1], // orders.user_id
            to_table: 1,
            to_cols: vec![0], // users.id
            constraint_name: "orders_user_id_fkey".into(),
        };
        let func = Function {
            id: 10,
            schema: "public".into(),
            name: "get_orders".into(),
            args: vec![FnArg { name: Some("uid".into()), type_name: "int4".into(), mode: ArgMode::In, has_default: false }],
            return_type: "setof orders".into(),
            kind: FnKind::Function,
            comment: None,
        };
        SchemaCache::build(
            Utc::now(),
            "17".into(),
            vec!["public".into()],
            vec![SchemaInfo { name: "public".into(), owner: "me".into(), is_system: false }],
            vec![users, orders],
            vec![func],
            vec![fk],
        )
    }

    fn col(name: &str, ty: &str, not_null: bool, attnum: i16) -> Column {
        Column { name: name.into(), type_name: ty.into(), not_null, has_default: false, comment: None, attnum }
    }

    fn run(sql_with_cursor: &str) -> Vec<String> {
        let offset = sql_with_cursor.find('|').expect("| gerekli");
        let sql = sql_with_cursor.replacen('|', "", 1);
        complete(&fixture(), &sql, offset)
            .items
            .into_iter()
            .map(|i| i.label)
            .collect()
    }

    fn has(labels: &[String], needle: &str) -> bool {
        labels.iter().any(|l| l == needle)
    }

    #[test]
    fn select_list_columns() {
        let l = run("SELECT | FROM users");
        assert!(has(&l, "id") && has(&l, "email"), "labels: {l:?}");
    }

    #[test]
    fn qualifier_columns_only() {
        let l = run("SELECT u.| FROM users u");
        assert!(has(&l, "email"), "labels: {l:?}");
        assert!(!has(&l, "user_id"), "orders kolonu sızmamalı: {l:?}");
    }

    #[test]
    fn from_tables() {
        let l = run("SELECT * FROM |");
        assert!(has(&l, "users") && has(&l, "orders"), "labels: {l:?}");
    }

    #[test]
    fn join_fk_first() {
        let l = run("SELECT * FROM users u JOIN |");
        assert_eq!(l.first().map(String::as_str), Some("orders o ON o.user_id = u.id"), "labels: {l:?}");
    }

    #[test]
    fn where_has_columns() {
        let l = run("SELECT * FROM users WHERE |");
        assert!(has(&l, "id") && has(&l, "email"), "labels: {l:?}");
    }

    #[test]
    fn cte_column_available() {
        let l = run("WITH x AS (SELECT 1 a) SELECT | FROM x");
        assert!(has(&l, "a"), "labels: {l:?}");
    }

    #[test]
    fn correlated_scope() {
        let l = run("SELECT (SELECT | FROM orders o) FROM users u");
        // İç subquery'de dış u.email görünür (multi-relation → alias önekli).
        assert!(l.iter().any(|s| s == "u.email"), "labels: {l:?}");
    }

    #[test]
    fn string_empty() {
        let l = run("SELECT '| ' FROM users");
        assert!(l.is_empty(), "string içi öneri olmamalı: {l:?}");
    }

    #[test]
    fn insert_cols() {
        let l = run("INSERT INTO users (|");
        assert!(has(&l, "id") && has(&l, "email"), "labels: {l:?}");
    }

    #[test]
    fn object_info_via_alias() {
        let info = object_info(&fixture(), "SELECT u.id FROM users u", 8).expect("u çözülmeli");
        assert_eq!(info.name, "users");
        assert_eq!(info.primary_key, vec!["id".to_string()]);
    }

    #[test]
    fn signature_help_active_param() {
        let sql = "SELECT get_orders(";
        let sig = signature_help(&fixture(), sql, sql.len()).expect("sig");
        assert_eq!(sig.parameters, vec!["uid int4".to_string()]);
        assert_eq!(sig.active_parameter, 0);
    }
}
