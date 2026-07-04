//! On-demand object-detail commands. NOT cached — peek is a human-speed action, so
//! one round-trip is acceptable and it doesn't bloat every refresh.

use serde::Serialize;
use sqlx::{PgPool, Row};
use tauri::State;

use crate::cache::FnKind;
use crate::error::{AriadneError, ErrorKind};
use crate::state::AppState;

// ---- get_relation_details ----

#[derive(Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
}

#[derive(Serialize)]
pub struct TriggerInfo {
    pub name: String,
    pub timing: String,
    pub events: String,
    pub function: String,
}

#[derive(Serialize)]
pub struct RelationDetails {
    pub indexes: Vec<IndexInfo>,
    pub triggers: Vec<TriggerInfo>,
    /// pg_total_relation_size (tablo + indeksler + toast). Görünümlerde 0.
    pub size_bytes: i64,
    /// pg_class.reltuples (tahmin). Hiç analiz edilmemişse -1.
    pub live_rows: i64,
}

/// A relation's index + trigger + size/row info. Lazily fetched when peek opens.
/// Columns come from the cache, so they're NOT here.
#[tauri::command]
pub async fn get_relation_details(
    connection_id: String,
    schema: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<RelationDetails, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let pool = &conn.pool;
    let (size, indexes, triggers) = tokio::join!(
        fetch_size(pool, &schema, &name),
        fetch_indexes(pool, &schema, &name),
        fetch_triggers(pool, &schema, &name),
    );
    let (size_bytes, live_rows) = size?;
    Ok(RelationDetails {
        indexes: indexes?,
        triggers: triggers?,
        size_bytes,
        live_rows,
    })
}

async fn fetch_size(pool: &PgPool, schema: &str, name: &str) -> Result<(i64, i64), AriadneError> {
    let row = sqlx::query(
        "SELECT pg_catalog.pg_total_relation_size(c.oid)::int8 AS size_bytes, \
                c.reltuples::int8 AS live_rows \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(name)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => Ok((r.try_get("size_bytes")?, r.try_get("live_rows")?)),
        None => Ok((0, -1)),
    }
}

async fn fetch_indexes(
    pool: &PgPool,
    schema: &str,
    name: &str,
) -> Result<Vec<IndexInfo>, AriadneError> {
    let rows = sqlx::query(
        "SELECT ic.relname AS name, \
                pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, \
                i.indisunique AS is_unique, i.indisprimary AS is_primary \
         FROM pg_catalog.pg_index i \
         JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
         JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace \
         WHERE n.nspname = $1 AND tc.relname = $2 \
         ORDER BY i.indisprimary DESC, ic.relname",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(IndexInfo {
                name: r.try_get("name")?,
                definition: r
                    .try_get::<Option<String>, _>("definition")?
                    .unwrap_or_default(),
                is_unique: r.try_get("is_unique")?,
                is_primary: r.try_get("is_primary")?,
            })
        })
        .collect()
}

async fn fetch_triggers(
    pool: &PgPool,
    schema: &str,
    name: &str,
) -> Result<Vec<TriggerInfo>, AriadneError> {
    // tgtype bitmask: BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32,
    // INSTEAD OF=64. Internal (constraint/FK) triggers are excluded (tgisinternal).
    let rows = sqlx::query(
        "SELECT t.tgname AS name, \
                CASE WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF' \
                     WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' \
                     ELSE 'AFTER' END AS timing, \
                array_to_string(ARRAY[ \
                    CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END, \
                    CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END, \
                    CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END, \
                    CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END \
                ], ', ') AS events, \
                p.proname AS function \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid \
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal \
         ORDER BY t.tgname",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(TriggerInfo {
                name: r.try_get("name")?,
                timing: r.try_get("timing")?,
                events: r
                    .try_get::<Option<String>, _>("events")?
                    .unwrap_or_default(),
                function: r.try_get("function")?,
            })
        })
        .collect()
}

// ---- get_function_source ----

/// A function's `CREATE OR REPLACE FUNCTION …` source (the SQL Server "Modify"
/// flow). Aggregate/window functions have no body; we check the cache before hitting
/// the DB and return a clear error.
#[tauri::command]
pub async fn get_function_source(
    connection_id: String,
    fn_oid: u32,
    state: State<'_, AppState>,
) -> Result<String, AriadneError> {
    let conn = state.connection(&connection_id)?;
    if let Some(f) = conn.schema_cache.load().functions.get(&fn_oid) {
        if matches!(f.kind, FnKind::Aggregate | FnKind::Window) {
            return Err(AriadneError::new(
                ErrorKind::QueryError,
                "Source not available for aggregate/window functions",
            ));
        }
    }
    let row = sqlx::query("SELECT pg_catalog.pg_get_functiondef($1::oid) AS src")
        .bind(fn_oid as i64)
        .fetch_one(&conn.pool)
        .await?;
    Ok(row.try_get("src")?)
}
