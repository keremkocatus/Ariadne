//! On-demand object-detail commands. NOT cached — peek is a human-speed action, so
//! one round-trip is acceptable and it doesn't bloat every refresh.
//!
//! Every command here runs its queries one after another on a single pool
//! connection: the pool is small (three by default) and tabs may be pinning the rest,
//! so fanning out would only queue behind them.

use serde::Serialize;
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::Row;
use tauri::State;

use crate::cache::FnKind;
use crate::error::{AriadneError, ErrorKind};
use crate::state::AppState;

// ---- Shared shapes ----

#[derive(Serialize)]
pub struct IndexInfo {
    pub name: String,
    /// The full `CREATE INDEX …` statement.
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
    /// False while a `CREATE INDEX CONCURRENTLY` is in flight or after it failed.
    pub is_valid: bool,
    /// Access method: btree, hash, gin, gist, brin, …
    pub method: String,
    /// Key columns / expressions in order, with ` DESC` appended where it applies.
    pub key_columns: Vec<String>,
    /// Non-key `INCLUDE` columns.
    pub include_columns: Vec<String>,
    /// The `WHERE` predicate of a partial index.
    pub predicate: Option<String>,
    pub size_bytes: i64,
    /// Index scans since the last stats reset; `None` if stats aren't readable.
    pub scans: Option<i64>,
}

#[derive(Serialize)]
pub struct TriggerInfo {
    pub name: String,
    /// BEFORE | AFTER | INSTEAD OF
    pub timing: String,
    /// Comma-separated: INSERT, UPDATE, DELETE, TRUNCATE
    pub events: String,
    /// ROW | STATEMENT
    pub level: String,
    pub function: String,
    pub enabled: bool,
    /// The full `CREATE TRIGGER …` statement.
    pub definition: String,
}

#[derive(Serialize)]
pub struct RelationDetails {
    pub indexes: Vec<IndexInfo>,
    pub triggers: Vec<TriggerInfo>,
    /// pg_total_relation_size (table + indexes + toast). 0 for views.
    pub size_bytes: i64,
    /// pg_class.reltuples (an estimate). -1 if never analyzed.
    pub live_rows: i64,
}

// ---- get_relation_details (the explorer's peek panel) ----

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
    let mut c = conn.pool.acquire().await.map_err(AriadneError::from)?;
    let (size_bytes, live_rows) = fetch_size(&mut c, &schema, &name).await?;
    Ok(RelationDetails {
        indexes: fetch_indexes(&mut c, &schema, &name).await?,
        triggers: fetch_triggers(&mut c, &schema, &name).await?,
        size_bytes,
        live_rows,
    })
}

async fn fetch_size(
    c: &mut PgConnection,
    schema: &str,
    name: &str,
) -> Result<(i64, i64), AriadneError> {
    // A partitioned parent stores nothing itself, so its own size and reltuples are
    // empty; report the totals over its partition tree instead.
    let row = sqlx::query(
        "SELECT CASE WHEN c.relkind = 'p' THEN \
                    (SELECT COALESCE(sum(pg_catalog.pg_total_relation_size(t.relid)), 0) \
                     FROM pg_catalog.pg_partition_tree(c.oid) t WHERE t.isleaf) \
                 ELSE pg_catalog.pg_total_relation_size(c.oid) END::int8 AS size_bytes, \
                CASE WHEN c.relkind = 'p' THEN \
                    (SELECT COALESCE(sum(GREATEST(pc.reltuples, 0)), 0) \
                     FROM pg_catalog.pg_partition_tree(c.oid) t \
                     JOIN pg_catalog.pg_class pc ON pc.oid = t.relid WHERE t.isleaf) \
                 ELSE c.reltuples END::int8 AS live_rows \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(name)
    .fetch_optional(&mut *c)
    .await?;
    match row {
        Some(r) => Ok((r.try_get("size_bytes")?, r.try_get("live_rows")?)),
        None => Ok((0, -1)),
    }
}

async fn fetch_indexes(
    c: &mut PgConnection,
    schema: &str,
    name: &str,
) -> Result<Vec<IndexInfo>, AriadneError> {
    // pg_get_indexdef(index, k, true) yields the k-th column or expression without
    // its ordering; bit 0 of indoption carries DESC for key columns.
    let rows = sqlx::query(
        "SELECT ic.relname AS name, \
                pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, \
                i.indisunique AS is_unique, i.indisprimary AS is_primary, \
                i.indisvalid AS is_valid, am.amname::text AS method, \
                ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, k, true) \
                             || CASE WHEN k <= i.indnkeyatts AND (i.indoption[k - 1] & 1) = 1 \
                                     THEN ' DESC' ELSE '' END \
                      FROM generate_series(1, i.indnatts) AS k ORDER BY k)::text[] AS columns, \
                i.indnkeyatts::int4 AS key_count, \
                pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate, \
                pg_catalog.pg_relation_size(i.indexrelid)::int8 AS size_bytes, \
                s.idx_scan::int8 AS scans \
         FROM pg_catalog.pg_index i \
         JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
         JOIN pg_catalog.pg_am am ON am.oid = ic.relam \
         JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace \
         LEFT JOIN pg_catalog.pg_stat_all_indexes s ON s.indexrelid = i.indexrelid \
         WHERE n.nspname = $1 AND tc.relname = $2 \
         ORDER BY i.indisprimary DESC, ic.relname",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter().map(index_from_row).collect()
}

fn index_from_row(r: PgRow) -> Result<IndexInfo, AriadneError> {
    let mut columns: Vec<String> = r.try_get("columns")?;
    let key_count = (r.try_get::<i32, _>("key_count")?.max(0) as usize).min(columns.len());
    let include_columns = columns.split_off(key_count);
    Ok(IndexInfo {
        name: r.try_get("name")?,
        definition: r
            .try_get::<Option<String>, _>("definition")?
            .unwrap_or_default(),
        is_unique: r.try_get("is_unique")?,
        is_primary: r.try_get("is_primary")?,
        is_valid: r.try_get("is_valid")?,
        method: r.try_get("method")?,
        key_columns: columns,
        include_columns,
        predicate: r.try_get("predicate")?,
        size_bytes: r.try_get("size_bytes")?,
        scans: r.try_get("scans")?,
    })
}

async fn fetch_triggers(
    c: &mut PgConnection,
    schema: &str,
    name: &str,
) -> Result<Vec<TriggerInfo>, AriadneError> {
    // tgtype bitmask: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32,
    // INSTEAD OF=64. Internal (constraint/FK) triggers are excluded (tgisinternal).
    let rows = sqlx::query(
        "SELECT t.tgname AS name, \
                CASE WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF' \
                     WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' \
                     ELSE 'AFTER' END AS timing, \
                array_to_string(ARRAY[ \
                    CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END, \
                    CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END, \
                    CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END, \
                    CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END \
                ], ', ') AS events, \
                CASE WHEN (t.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS level, \
                (t.tgenabled <> 'D') AS enabled, \
                p.proname AS function, \
                pg_catalog.pg_get_triggerdef(t.oid, true) AS definition \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid \
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal \
         ORDER BY t.tgname",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(TriggerInfo {
                name: r.try_get("name")?,
                timing: r.try_get("timing")?,
                events: r
                    .try_get::<Option<String>, _>("events")?
                    .unwrap_or_default(),
                level: r.try_get("level")?,
                function: r.try_get("function")?,
                enabled: r.try_get("enabled")?,
                definition: r
                    .try_get::<Option<String>, _>("definition")?
                    .unwrap_or_default(),
            })
        })
        .collect()
}

// ---- get_relation_full (the Details view) ----

#[derive(Serialize)]
pub struct ColumnDetail {
    pub name: String,
    pub type_name: String,
    pub not_null: bool,
    pub default_expr: Option<String>,
    pub is_pk: bool,
    /// "always" | "by_default" for identity columns.
    pub identity: Option<String>,
    /// A `GENERATED ALWAYS AS (…) STORED` column; `default_expr` is its expression.
    pub is_generated: bool,
    pub comment: Option<String>,
}

#[derive(Serialize)]
pub struct ConstraintInfo {
    pub name: String,
    /// primary_key | unique | check | foreign_key | exclusion
    pub kind: String,
    pub columns: Vec<String>,
    /// The constraint body as `pg_get_constraintdef` prints it.
    pub definition: String,
    /// For a foreign key: the referenced `schema.table`.
    pub ref_table: Option<String>,
}

/// A foreign key in another table that points at this one.
#[derive(Serialize)]
pub struct IncomingFk {
    pub name: String,
    pub table: String,
    pub definition: String,
}

#[derive(Serialize)]
pub struct PartitionInfo {
    pub schema: String,
    pub name: String,
    /// `FOR VALUES …` / `DEFAULT`.
    pub bound: Option<String>,
    /// Depth below the inspected table (1 = direct child).
    pub level: i32,
    /// False for a partition that is itself partitioned.
    pub is_leaf: bool,
    pub size_bytes: i64,
    pub estimated_rows: i64,
}

#[derive(Serialize)]
pub struct TableStats {
    pub live_rows: i64,
    pub dead_rows: i64,
    pub seq_scans: i64,
    pub index_scans: Option<i64>,
    pub last_vacuum: Option<String>,
    pub last_autovacuum: Option<String>,
    pub last_analyze: Option<String>,
    pub last_autoanalyze: Option<String>,
}

/// A relation by its two name parts. Kept separate rather than joined with a dot,
/// because either part may itself contain one.
#[derive(Serialize)]
pub struct RelationRef {
    pub schema: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct RelationFull {
    pub schema: String,
    pub name: String,
    /// table | view | mat_view | foreign | partitioned | sequence | other
    pub kind: String,
    pub owner: String,
    pub comment: Option<String>,
    /// pg_class.reltuples; -1 if never analyzed.
    pub estimated_rows: i64,
    pub total_bytes: i64,
    /// Heap + TOAST.
    pub table_bytes: i64,
    pub index_bytes: i64,
    pub stats: Option<TableStats>,
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub referenced_by: Vec<IncomingFk>,
    pub triggers: Vec<TriggerInfo>,
    /// `RANGE (created_at)` for a partitioned table.
    pub partition_key: Option<String>,
    /// For a partition: its parent table and its bound.
    pub partition_of: Option<RelationRef>,
    pub partition_bound: Option<String>,
    pub partitions: Vec<PartitionInfo>,
    /// The query behind a view / materialized view.
    pub view_definition: Option<String>,
}

/// Everything the Details view shows about one relation.
#[tauri::command]
pub async fn get_relation_full(
    connection_id: String,
    schema: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<RelationFull, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let mut c = conn.pool.acquire().await.map_err(AriadneError::from)?;
    fetch_relation_full(&mut c, &schema, &name).await
}

async fn fetch_relation_full(
    c: &mut PgConnection,
    schema: &str,
    name: &str,
) -> Result<RelationFull, AriadneError> {
    let head = sqlx::query(
        "SELECT c.oid::int8 AS oid, c.relkind::text AS relkind, \
                pg_catalog.pg_get_userbyid(c.relowner)::text AS owner, \
                pg_catalog.obj_description(c.oid, 'pg_class') AS comment, \
                c.reltuples::int8 AS estimated_rows, \
                pg_catalog.pg_total_relation_size(c.oid)::int8 AS total_bytes, \
                pg_catalog.pg_table_size(c.oid)::int8 AS table_bytes, \
                pg_catalog.pg_indexes_size(c.oid)::int8 AS index_bytes, \
                CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END \
                    AS partition_key, \
                CASE WHEN c.relispartition \
                     THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END AS partition_bound, \
                pn.nspname::text AS parent_schema, pc.relname::text AS parent_name, \
                CASE WHEN c.relkind IN ('v', 'm') \
                     THEN pg_catalog.pg_get_viewdef(c.oid, true) END AS view_definition, \
                s.relid IS NOT NULL AS has_stats, \
                COALESCE(s.n_live_tup, 0)::int8 AS live_rows, \
                COALESCE(s.n_dead_tup, 0)::int8 AS dead_rows, \
                COALESCE(s.seq_scan, 0)::int8 AS seq_scans, \
                s.idx_scan::int8 AS index_scans, \
                s.last_vacuum::text AS last_vacuum, \
                s.last_autovacuum::text AS last_autovacuum, \
                s.last_analyze::text AS last_analyze, \
                s.last_autoanalyze::text AS last_autoanalyze \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid \
         LEFT JOIN pg_catalog.pg_inherits inh ON inh.inhrelid = c.oid AND c.relispartition \
         LEFT JOIN pg_catalog.pg_class pc ON pc.oid = inh.inhparent \
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(name)
    .fetch_optional(&mut *c)
    .await?
    .ok_or_else(|| {
        AriadneError::new(
            ErrorKind::QueryError,
            format!("Relation {schema}.{name} no longer exists — refresh the schema"),
        )
    })?;

    let oid: i64 = head.try_get("oid")?;
    let relkind: String = head.try_get("relkind")?;
    let stats = if head.try_get::<bool, _>("has_stats")? {
        Some(TableStats {
            live_rows: head.try_get("live_rows")?,
            dead_rows: head.try_get("dead_rows")?,
            seq_scans: head.try_get("seq_scans")?,
            index_scans: head.try_get("index_scans")?,
            last_vacuum: head.try_get("last_vacuum")?,
            last_autovacuum: head.try_get("last_autovacuum")?,
            last_analyze: head.try_get("last_analyze")?,
            last_autoanalyze: head.try_get("last_autoanalyze")?,
        })
    } else {
        None
    };

    let partitions = if relkind == "p" {
        fetch_partitions(c, oid).await?
    } else {
        Vec::new()
    };

    Ok(RelationFull {
        schema: schema.to_string(),
        name: name.to_string(),
        kind: relkind_label(&relkind).to_string(),
        owner: head.try_get("owner")?,
        comment: head.try_get("comment")?,
        estimated_rows: head.try_get("estimated_rows")?,
        total_bytes: head.try_get("total_bytes")?,
        table_bytes: head.try_get("table_bytes")?,
        index_bytes: head.try_get("index_bytes")?,
        stats,
        columns: fetch_columns(c, oid).await?,
        indexes: fetch_indexes(c, schema, name).await?,
        constraints: fetch_constraints(c, oid).await?,
        referenced_by: fetch_incoming_fks(c, oid).await?,
        triggers: fetch_triggers(c, schema, name).await?,
        partition_key: head.try_get("partition_key")?,
        partition_of: match (
            head.try_get::<Option<String>, _>("parent_schema")?,
            head.try_get::<Option<String>, _>("parent_name")?,
        ) {
            (Some(schema), Some(name)) => Some(RelationRef { schema, name }),
            _ => None,
        },
        partition_bound: head.try_get("partition_bound")?,
        partitions,
        view_definition: head.try_get("view_definition")?,
    })
}

fn relkind_label(relkind: &str) -> &'static str {
    match relkind {
        "r" => "table",
        "v" => "view",
        "m" => "mat_view",
        "f" => "foreign",
        "p" => "partitioned",
        "S" => "sequence",
        _ => "other",
    }
}

fn constraint_kind(contype: &str) -> &'static str {
    match contype {
        "p" => "primary_key",
        "u" => "unique",
        "c" => "check",
        "f" => "foreign_key",
        "x" => "exclusion",
        _ => "other",
    }
}

async fn fetch_columns(c: &mut PgConnection, oid: i64) -> Result<Vec<ColumnDetail>, AriadneError> {
    let rows = sqlx::query(
        "SELECT a.attname::text AS name, \
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name, \
                a.attnotnull AS not_null, \
                pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, \
                a.attidentity::text AS identity, \
                (a.attgenerated::text <> '') AS is_generated, \
                pg_catalog.col_description(a.attrelid, a.attnum::int) AS comment, \
                COALESCE(a.attnum = ANY (pk.conkey), false) AS is_pk \
         FROM pg_catalog.pg_attribute a \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         LEFT JOIN pg_catalog.pg_constraint pk \
                ON pk.conrelid = a.attrelid AND pk.contype = 'p' \
         WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(oid)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter()
        .map(|r| {
            let identity = match r.try_get::<String, _>("identity")?.as_str() {
                "a" => Some("always".to_string()),
                "d" => Some("by_default".to_string()),
                _ => None,
            };
            Ok(ColumnDetail {
                name: r.try_get("name")?,
                type_name: r
                    .try_get::<Option<String>, _>("type_name")?
                    .unwrap_or_default(),
                not_null: r.try_get("not_null")?,
                default_expr: r.try_get("default_expr")?,
                is_pk: r.try_get("is_pk")?,
                identity,
                is_generated: r.try_get("is_generated")?,
                comment: r.try_get("comment")?,
            })
        })
        .collect()
}

async fn fetch_constraints(
    c: &mut PgConnection,
    oid: i64,
) -> Result<Vec<ConstraintInfo>, AriadneError> {
    let rows = sqlx::query(
        "SELECT con.conname::text AS name, con.contype::text AS contype, \
                pg_catalog.pg_get_constraintdef(con.oid, true) AS definition, \
                ARRAY(SELECT a.attname \
                      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) \
                      JOIN pg_catalog.pg_attribute a \
                        ON a.attrelid = con.conrelid AND a.attnum = k.attnum \
                      ORDER BY k.ord)::text[] AS columns, \
                (SELECT rn.nspname || '.' || rc.relname \
                 FROM pg_catalog.pg_class rc \
                 JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace \
                 WHERE rc.oid = con.confrelid) AS ref_table \
         FROM pg_catalog.pg_constraint con \
         WHERE con.conrelid = $1::oid AND con.contype IN ('p', 'u', 'c', 'f', 'x') \
         ORDER BY array_position(ARRAY['p', 'u', 'f', 'c', 'x'], con.contype::text), con.conname",
    )
    .bind(oid)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(ConstraintInfo {
                name: r.try_get("name")?,
                kind: constraint_kind(&r.try_get::<String, _>("contype")?).to_string(),
                columns: r.try_get("columns")?,
                definition: r
                    .try_get::<Option<String>, _>("definition")?
                    .unwrap_or_default(),
                ref_table: r.try_get("ref_table")?,
            })
        })
        .collect()
}

async fn fetch_incoming_fks(
    c: &mut PgConnection,
    oid: i64,
) -> Result<Vec<IncomingFk>, AriadneError> {
    // conparentid = 0 keeps one row per logical FK: a key declared on a partitioned
    // table is cloned onto every partition.
    let rows = sqlx::query(
        "SELECT con.conname::text AS name, n.nspname || '.' || c.relname AS table_name, \
                pg_catalog.pg_get_constraintdef(con.oid, true) AS definition \
         FROM pg_catalog.pg_constraint con \
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE con.confrelid = $1::oid AND con.contype = 'f' AND con.conparentid = 0 \
         ORDER BY 2, 1",
    )
    .bind(oid)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(IncomingFk {
                name: r.try_get("name")?,
                table: r.try_get("table_name")?,
                definition: r
                    .try_get::<Option<String>, _>("definition")?
                    .unwrap_or_default(),
            })
        })
        .collect()
}

async fn fetch_partitions(
    c: &mut PgConnection,
    oid: i64,
) -> Result<Vec<PartitionInfo>, AriadneError> {
    // Ordered so each sub-partitioned child is followed by its own partitions, with
    // DEFAULT last within a level.
    let rows = sqlx::query(
        "WITH RECURSIVE tree AS ( \
             SELECT c.oid, 1 AS level, ARRAY[c.relname::text] AS path \
             FROM pg_catalog.pg_inherits i \
             JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid \
             WHERE i.inhparent = $1::oid AND c.relispartition \
             UNION ALL \
             SELECT c.oid, t.level + 1, t.path || c.relname::text \
             FROM tree t \
             JOIN pg_catalog.pg_inherits i ON i.inhparent = t.oid \
             JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid \
             WHERE c.relispartition \
         ) \
         SELECT n.nspname::text AS schema, c.relname::text AS name, t.level::int4 AS level, \
                (c.relkind <> 'p') AS is_leaf, \
                pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound, \
                pg_catalog.pg_total_relation_size(c.oid)::int8 AS size_bytes, \
                c.reltuples::int8 AS estimated_rows \
         FROM tree t \
         JOIN pg_catalog.pg_class c ON c.oid = t.oid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         ORDER BY t.path",
    )
    .bind(oid)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(PartitionInfo {
                schema: r.try_get("schema")?,
                name: r.try_get("name")?,
                bound: r.try_get("bound")?,
                level: r.try_get("level")?,
                is_leaf: r.try_get("is_leaf")?,
                size_bytes: r.try_get("size_bytes")?,
                estimated_rows: r.try_get("estimated_rows")?,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_cover_the_catalog_codes() {
        assert_eq!(relkind_label("p"), "partitioned");
        assert_eq!(relkind_label("m"), "mat_view");
        assert_eq!(relkind_label("?"), "other");
        assert_eq!(constraint_kind("f"), "foreign_key");
        assert_eq!(constraint_kind("x"), "exclusion");
    }

    /// Read-only catalog queries against whatever tables the target database has.
    /// The point is that every query parses and decodes on a real server.
    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn relation_full_decodes_for_every_relation() {
        let url = std::env::var("ARIADNE_DATABASE_URL").expect("ARIADNE_DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut c = pool.acquire().await.unwrap();
        let rels: Vec<(String, String)> = sqlx::query_as(
            "SELECT n.nspname::text, c.relname::text FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'v', 'm', 'p', 'S') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND n.nspname NOT LIKE 'pg\\_%' \
             LIMIT 60",
        )
        .fetch_all(&mut *c)
        .await
        .unwrap();
        for (schema, name) in rels {
            let full = fetch_relation_full(&mut c, &schema, &name)
                .await
                .unwrap_or_else(|e| panic!("{schema}.{name}: {}", e.message));
            assert_eq!(full.name, name);
            if full.kind == "partitioned" {
                assert!(full.partition_key.is_some(), "{schema}.{name}");
            }
            let (size, _) = fetch_size(&mut c, &schema, &name).await.unwrap();
            assert!(size >= 0);
        }
    }
}
