//! Catalog sorguları → SchemaCache (design 03 §2).
//!
//! `information_schema` değil `pg_catalog` kullanılır (daha hızlı, daha zengin).
//! 4 sorgu `tokio::join!` ile paralel atılır. Sistem şemaları (`pg_catalog`,
//! `information_schema`) M1'de nesne olarak ÇEKİLMEZ (cache'i yalın tutmak için);
//! yalnızca şema düğümü olarak listelenir. [design sapması: bilinçli, sonra revize]

use std::collections::HashMap;

use chrono::Utc;
use sqlx::{PgPool, Row};

use super::{
    ArgMode, Column, FkEdge, FnArg, FnKind, Function, RelKind, SchemaCache, SchemaInfo, Table,
    TableId,
};
use crate::error::AriadneError;

/// Sistem şemalarını nesne sorgularından dışlayan WHERE parçası.
const NOT_SYSTEM: &str = "n.nspname NOT LIKE 'pg\\_temp\\_%' \
     AND n.nspname NOT LIKE 'pg\\_toast%' \
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')";

/// Tüm katalog verisini paralel çekip immutable SchemaCache kurar.
pub async fn fetch_schema_cache(pool: &PgPool) -> Result<SchemaCache, AriadneError> {
    let (schemas, tables_res, constraints_res, functions_res, search_path, server_version) = tokio::join!(
        fetch_schemas(pool),
        fetch_tables(pool),
        fetch_constraints(pool),
        fetch_functions(pool),
        fetch_search_path(pool),
        fetch_server_version(pool),
    );

    let schemas = schemas?;
    let mut tables = tables_res?;
    let constraints = constraints_res?;
    let functions = functions_res?;
    let search_path = search_path?;
    let server_version = server_version?;

    // attnum → columns indeksi (her tablo için) — PK/FK çözümünde kullanılır.
    let attnum_maps: HashMap<TableId, HashMap<i16, usize>> =
        tables.iter().map(|t| (t.id, t.attnum_index())).collect();

    // PK'ları tablolara işle, FK'ları grafiğe çevir.
    let mut fks: Vec<FkEdge> = Vec::new();
    let table_index: HashMap<TableId, usize> =
        tables.iter().enumerate().map(|(i, t)| (t.id, i)).collect();

    for c in constraints {
        match c.contype as u8 {
            b'p' => {
                if let (Some(&ti), Some(amap)) =
                    (table_index.get(&c.table_oid), attnum_maps.get(&c.table_oid))
                {
                    tables[ti].primary_key = c
                        .conkey
                        .iter()
                        .filter_map(|a| amap.get(a).copied())
                        .collect();
                }
            }
            b'f' => {
                let (from_map, to_map) = (
                    attnum_maps.get(&c.table_oid),
                    attnum_maps.get(&c.ref_table_oid),
                );
                if let (Some(from_map), Some(to_map)) = (from_map, to_map) {
                    fks.push(FkEdge {
                        from_table: c.table_oid,
                        from_cols: c
                            .conkey
                            .iter()
                            .filter_map(|a| from_map.get(a).copied())
                            .collect(),
                        to_table: c.ref_table_oid,
                        to_cols: c
                            .confkey
                            .iter()
                            .filter_map(|a| to_map.get(a).copied())
                            .collect(),
                        constraint_name: c.name,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(SchemaCache::build(
        Utc::now(),
        server_version,
        search_path,
        schemas,
        tables,
        functions,
        fks,
    ))
}

// ---- Sorgu 1: şemalar ----

async fn fetch_schemas(pool: &PgPool) -> Result<Vec<SchemaInfo>, AriadneError> {
    let rows = sqlx::query(
        "SELECT n.nspname AS name, \
                pg_catalog.pg_get_userbyid(n.nspowner) AS owner, \
                (n.nspname IN ('pg_catalog','information_schema') OR n.nspname LIKE 'pg\\_%') AS is_system \
         FROM pg_catalog.pg_namespace n \
         WHERE n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast%' \
         ORDER BY n.nspname",
    )
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|r| {
            Ok(SchemaInfo {
                name: r.try_get("name")?,
                owner: r.try_get::<Option<String>, _>("owner")?.unwrap_or_default(),
                is_system: r.try_get("is_system")?,
            })
        })
        .collect()
}

// ---- Sorgu 2: tablolar + kolonlar (satır = kolon) ----

async fn fetch_tables(pool: &PgPool) -> Result<Vec<Table>, AriadneError> {
    let sql = format!(
        "SELECT c.oid::int8 AS table_oid, n.nspname AS schema, c.relname AS name, \
                c.relkind AS relkind, c.reltuples::int8 AS est_rows, \
                obj_description(c.oid, 'pg_class') AS table_comment, \
                a.attnum::int2 AS attnum, a.attname AS col_name, \
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name, \
                a.attnotnull AS not_null, a.atthasdef AS has_default, \
                col_description(c.oid, a.attnum::int) AS col_comment \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_attribute a \
              ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         WHERE c.relkind IN ('r','v','m','f','p','S') AND {NOT_SYSTEM} \
         ORDER BY c.oid, a.attnum"
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;

    // oid sırasında gruplanmış; Vec'te sırayı korumak için ayrı index tutulur.
    let mut tables: Vec<Table> = Vec::new();
    let mut idx: HashMap<TableId, usize> = HashMap::new();

    for r in rows {
        let oid = r.try_get::<i64, _>("table_oid")? as u32;
        let ti = match idx.get(&oid) {
            Some(&i) => i,
            None => {
                let relkind: i8 = r.try_get("relkind")?;
                let Some(kind) = RelKind::from_pg(relkind) else {
                    continue;
                };
                let t = Table {
                    id: oid,
                    schema: r.try_get("schema")?,
                    name: r.try_get("name")?,
                    kind,
                    columns: Vec::new(),
                    primary_key: Vec::new(),
                    comment: r.try_get("table_comment")?,
                    estimated_rows: r.try_get("est_rows")?,
                };
                tables.push(t);
                let i = tables.len() - 1;
                idx.insert(oid, i);
                i
            }
        };

        // LEFT JOIN: kolonsuz tablo/sequence'ta attnum NULL gelir.
        if let Some(attnum) = r.try_get::<Option<i16>, _>("attnum")? {
            tables[ti].columns.push(Column {
                name: r.try_get("col_name")?,
                type_name: r
                    .try_get::<Option<String>, _>("type_name")?
                    .unwrap_or_default(),
                not_null: r.try_get::<Option<bool>, _>("not_null")?.unwrap_or(false),
                has_default: r
                    .try_get::<Option<bool>, _>("has_default")?
                    .unwrap_or(false),
                comment: r.try_get("col_comment")?,
                attnum,
            });
        }
    }

    Ok(tables)
}

// ---- Sorgu 3: constraint'ler (PK + FK) ----

struct RawConstraint {
    table_oid: TableId,
    contype: i8,
    name: String,
    conkey: Vec<i16>,
    ref_table_oid: TableId,
    confkey: Vec<i16>,
}

async fn fetch_constraints(pool: &PgPool) -> Result<Vec<RawConstraint>, AriadneError> {
    let sql = format!(
        "SELECT con.conrelid::int8 AS table_oid, con.contype AS contype, con.conname AS name, \
                con.conkey::int2[] AS conkey, con.confrelid::int8 AS ref_table_oid, \
                COALESCE(con.confkey, ARRAY[]::int2[])::int2[] AS confkey \
         FROM pg_catalog.pg_constraint con \
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE con.contype IN ('p','f') AND {NOT_SYSTEM}"
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;

    rows.into_iter()
        .map(|r| {
            Ok(RawConstraint {
                table_oid: r.try_get::<i64, _>("table_oid")? as u32,
                contype: r.try_get("contype")?,
                name: r.try_get("name")?,
                conkey: r.try_get("conkey")?,
                ref_table_oid: r.try_get::<i64, _>("ref_table_oid")? as u32,
                confkey: r.try_get("confkey")?,
            })
        })
        .collect()
}

// ---- Sorgu 4: fonksiyonlar ----

async fn fetch_functions(pool: &PgPool) -> Result<Vec<Function>, AriadneError> {
    let sql = format!(
        "SELECT p.oid::int8 AS oid, n.nspname AS schema, p.proname AS name, \
                pg_catalog.pg_get_function_arguments(p.oid) AS args, \
                pg_catalog.pg_get_function_result(p.oid) AS result, \
                p.prokind AS prokind, \
                (p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype) AS is_trigger, \
                obj_description(p.oid, 'pg_proc') AS comment \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE {NOT_SYSTEM}"
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;

    rows.into_iter()
        .map(|r| {
            let args_str: String = r.try_get::<Option<String>, _>("args")?.unwrap_or_default();
            Ok(Function {
                id: r.try_get::<i64, _>("oid")? as u32,
                schema: r.try_get("schema")?,
                name: r.try_get("name")?,
                args: parse_function_args(&args_str),
                return_type: r
                    .try_get::<Option<String>, _>("result")?
                    .unwrap_or_else(|| "void".to_string()),
                kind: FnKind::from_pg(r.try_get("prokind")?),
                is_trigger: r.try_get::<Option<bool>, _>("is_trigger")?.unwrap_or(false),
                comment: r.try_get("comment")?,
            })
        })
        .collect()
}

// ---- Yardımcı sorgular ----

async fn fetch_search_path(pool: &PgPool) -> Result<Vec<String>, AriadneError> {
    let row = sqlx::query("SHOW search_path").fetch_one(pool).await?;
    let raw: String = row.try_get(0)?;
    Ok(raw
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

async fn fetch_server_version(pool: &PgPool) -> Result<String, AriadneError> {
    let row = sqlx::query("SHOW server_version").fetch_one(pool).await?;
    Ok(row.try_get(0)?)
}

// ---- pg_get_function_arguments string parser'ı (design 08 §1 test hedefi) ----

/// "user_id integer, amount numeric(10,2) DEFAULT 0, VARIADIC tags text[]"
/// → Vec<FnArg>. Tip içinde virgül olabildiği için (numeric(10,2)) paren-derinliği
/// gözetilerek bölünür; mode öneki ve DEFAULT soneki ayrıştırılır.
pub fn parse_function_args(s: &str) -> Vec<FnArg> {
    let s = s.trim();
    if s.is_empty() {
        return Vec::new();
    }
    split_top_level(s, ',')
        .into_iter()
        .filter_map(|part| parse_one_arg(part.trim()))
        .collect()
}

fn parse_one_arg(part: &str) -> Option<FnArg> {
    if part.is_empty() {
        return None;
    }

    // 1) Mode öneki
    let (mode, rest) = strip_mode(part);

    // 2) DEFAULT soneki (paren-derinliği 0'da ilk " DEFAULT ")
    let (rest, has_default) = match find_default(rest) {
        Some(i) => (rest[..i].trim(), true),
        None => (rest.trim(), false),
    };
    if rest.is_empty() {
        return None;
    }

    // 3) name + type ayrımı. İlk token bir identifier VE bilinen bir tip anahtar
    //    kelimesi değilse arg adıdır; kalanı tiptir. Aksi halde tamamı tiptir.
    let (name, type_name) = match rest.split_once(char::is_whitespace) {
        Some((first, tail)) if is_ident(first) && !is_type_leadword(first) => {
            (Some(first.to_string()), tail.trim().to_string())
        }
        _ => (None, rest.to_string()),
    };

    Some(FnArg {
        name,
        type_name,
        mode,
        has_default,
    })
}

fn strip_mode(part: &str) -> (ArgMode, &str) {
    for (kw, mode) in [
        ("INOUT ", ArgMode::InOut),
        ("IN ", ArgMode::In),
        ("OUT ", ArgMode::Out),
        ("VARIADIC ", ArgMode::Variadic),
    ] {
        if part.len() >= kw.len() && part[..kw.len()].eq_ignore_ascii_case(kw) {
            return (mode, part[kw.len()..].trim_start());
        }
    }
    (ArgMode::In, part)
}

/// Paren-derinliği 0'da ilk " DEFAULT " veya " = " konumunu bulur.
fn find_default(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b' ' if depth == 0 => {
                let tail = &s[i + 1..];
                if tail.len() >= 8 && tail[..8].eq_ignore_ascii_case("DEFAULT ") {
                    return Some(i);
                }
                if tail.starts_with("= ") {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Verilen ayraçta, paren/bracket derinliği 0'da böler.
fn split_top_level(s: &str, delim: char) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            _ if b == delim as u8 && depth == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Çok kelimeli/anahtar tiplerin ilk kelimesi (arg adı sanılmasın diye).
fn is_type_leadword(w: &str) -> bool {
    matches!(
        w.to_ascii_lowercase().as_str(),
        "bigint"
            | "int8"
            | "integer"
            | "int"
            | "int4"
            | "smallint"
            | "int2"
            | "bigserial"
            | "serial"
            | "smallserial"
            | "boolean"
            | "bool"
            | "real"
            | "float4"
            | "float8"
            | "double"
            | "numeric"
            | "decimal"
            | "money"
            | "text"
            | "varchar"
            | "char"
            | "character"
            | "bpchar"
            | "name"
            | "bytea"
            | "date"
            | "time"
            | "timestamp"
            | "timestamptz"
            | "timetz"
            | "interval"
            | "uuid"
            | "json"
            | "jsonb"
            | "xml"
            | "cidr"
            | "inet"
            | "macaddr"
            | "bit"
            | "point"
            | "line"
            | "box"
            | "path"
            | "polygon"
            | "circle"
            | "tsvector"
            | "tsquery"
            | "oid"
            | "void"
            | "record"
            | "anyelement"
            | "anyarray"
            | "trigger"
            | "setof"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(args: &[FnArg]) -> Vec<Option<&str>> {
        args.iter().map(|a| a.name.as_deref()).collect()
    }
    fn types(args: &[FnArg]) -> Vec<&str> {
        args.iter().map(|a| a.type_name.as_str()).collect()
    }

    #[test]
    fn empty() {
        assert!(parse_function_args("").is_empty());
        assert!(parse_function_args("   ").is_empty());
    }

    #[test]
    fn named_args() {
        let a = parse_function_args("user_id integer, email text");
        assert_eq!(names(&a), vec![Some("user_id"), Some("email")]);
        assert_eq!(types(&a), vec!["integer", "text"]);
    }

    #[test]
    fn type_with_comma_in_parens() {
        // numeric(10,2) içindeki virgül argümanı bölmemeli.
        let a = parse_function_args("amount numeric(10,2), note varchar(255)");
        assert_eq!(a.len(), 2);
        assert_eq!(names(&a), vec![Some("amount"), Some("note")]);
        assert_eq!(types(&a), vec!["numeric(10,2)", "varchar(255)"]);
    }

    #[test]
    fn unnamed_multiword_type() {
        let a = parse_function_args("double precision, timestamp with time zone");
        assert_eq!(names(&a), vec![None, None]);
        assert_eq!(
            types(&a),
            vec!["double precision", "timestamp with time zone"]
        );
    }

    #[test]
    fn modes_and_default() {
        let a = parse_function_args("IN a integer, OUT total bigint, b text DEFAULT 'x'");
        assert_eq!(a[0].mode, ArgMode::In);
        assert_eq!(a[1].mode, ArgMode::Out);
        assert_eq!(a[2].mode, ArgMode::In);
        assert!(a[2].has_default);
        assert_eq!(a[2].type_name, "text");
    }

    #[test]
    fn variadic() {
        let a = parse_function_args("VARIADIC tags text[]");
        assert_eq!(a[0].mode, ArgMode::Variadic);
        assert_eq!(a[0].name.as_deref(), Some("tags"));
        assert_eq!(a[0].type_name, "text[]");
    }

    #[test]
    fn default_with_equals() {
        let a = parse_function_args("limit_n integer = 10");
        assert_eq!(a[0].name.as_deref(), Some("limit_n"));
        assert_eq!(a[0].type_name, "integer");
        assert!(a[0].has_default);
    }

    /// Canlı DB'ye karşı catalog fetch (salt-okunur). `ARIADNE_DATABASE_URL` set
    /// edip `cargo test -- --ignored`. Sadece SELECT'ler; hiçbir şey değiştirmez.
    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn fetch_cache_from_live_db() {
        let url = std::env::var("ARIADNE_DATABASE_URL")
            .expect("set ARIADNE_DATABASE_URL to run this test");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        let cache = fetch_schema_cache(&pool).await.expect("fetch_schema_cache");

        eprintln!(
            "schemas={} tables={} functions={} fk_edges={} search_path={:?} server={}",
            cache.schemas.len(),
            cache.tables.len(),
            cache.functions.len(),
            cache.fk_adjacency.values().map(|v| v.len()).sum::<usize>(),
            cache.search_path,
            cache.server_version,
        );

        // Temel invariant'lar: en az bir şema, indeksler tutarlı.
        assert!(!cache.schemas.is_empty(), "en az bir şema beklenir");
        assert_eq!(
            cache.table_by_qualified.len(),
            cache.tables.len(),
            "qualified index tablo sayısıyla eşleşmeli"
        );
        // Snapshot serileşebilmeli ve şema sayısı korunmalı.
        let snap = cache.to_snapshot();
        assert_eq!(snap.schemas.len(), cache.schemas.len());
        let json = serde_json::to_string(&snap).expect("snapshot serialize");
        eprintln!("snapshot JSON bytes = {}", json.len());
    }
}
