//! Single-cell data editing. **DATA-WRITE — handle with care.**
//!
//! Only used when the result comes from a single table with a resolvable primary key
//! (the frontend only shows the editor then). The **single-row guard** here
//! (`BEGIN; UPDATE …; rowcount==1 ? COMMIT : ROLLBACK`) prevents wrong/multi-row
//! updates. On a read-only profile the connection has `default_transaction_read_only=on`,
//! so the UPDATE is rejected with 25006 anyway (defense in depth; the frontend also
//! never opens the editor). There is deliberately NO ctid fallback (too fragile).

use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use tauri::State;

use crate::error::{AriadneError, ErrorKind};
use crate::state::AppState;

/// Safely quotes an identifier (doubling embedded double-quotes). Table/column names
/// always go through this before entering SQL (injection-safe).
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// `"schema"."table"` — bound to `to_regclass($1)` (resolves the relation to an oid;
/// more robust than matching nspname — handles search_path/case/temp correctly).
fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

/// Returns a table's primary-key columns in order. Empty Vec if there's no PK → the
/// frontend disables editing (no WHERE can be built).
#[tauri::command]
pub async fn get_primary_key(
    connection_id: String,
    schema: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let rows = sqlx::query(
        "SELECT a.attname AS col \
         FROM pg_catalog.pg_constraint con \
         JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid \
                                       AND a.attnum = ANY(con.conkey) \
         WHERE con.contype = 'p' AND con.conrelid = to_regclass($1) \
         ORDER BY array_position(con.conkey, a.attnum)",
    )
    .bind(qualified(&schema, &table))
    .fetch_all(&conn.pool)
    .await
    .map_err(AriadneError::from)?;
    rows.into_iter()
        .map(|r| r.try_get::<String, _>("col").map_err(AriadneError::from))
        .collect()
}

/// One `pk_column = value` term of the WHERE clause (the value arrives as text from
/// the result row).
#[derive(Deserialize)]
pub struct PkPredicate {
    pub column: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct UpdateResult {
    pub updated: u64,
}

/// Updates a single cell.
#[tauri::command]
pub async fn update_cell(
    connection_id: String,
    schema: String,
    table: String,
    pk: Vec<PkPredicate>,
    column: String,
    new_value: Option<String>,
    state: State<'_, AppState>,
) -> Result<UpdateResult, AriadneError> {
    let conn = state.connection(&connection_id)?;
    do_update_cell(
        &conn.pool,
        &schema,
        &table,
        &pk,
        &column,
        new_value.as_deref(),
    )
    .await
}

/// The core of update_cell (takes a pool rather than State → testable). Resolves the
/// column type, builds the SQL, and applies it inside a single-row-guarded transaction.
async fn do_update_cell(
    pool: &PgPool,
    schema: &str,
    table: &str,
    pk: &[PkPredicate],
    column: &str,
    new_value: Option<&str>,
) -> Result<UpdateResult, AriadneError> {
    if pk.is_empty() {
        return Err(AriadneError::new(
            ErrorKind::Internal,
            "no primary key to target the row",
        ));
    }

    // Look up the column type (to cast the text value to the right type). format_type
    // renders arrays/domains/enums correctly, and since it's catalog-derived it's safe
    // to interpolate (not user input).
    let coltype: String = sqlx::query_scalar(
        "SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) \
         FROM pg_catalog.pg_attribute a \
         WHERE a.attrelid = to_regclass($1) AND a.attname = $2 \
           AND NOT a.attisdropped AND a.attnum > 0",
    )
    .bind(qualified(schema, table))
    .bind(column)
    .fetch_optional(pool)
    .await
    .map_err(AriadneError::from)?
    .ok_or_else(|| AriadneError::new(ErrorKind::Internal, "column not found"))?;

    let (sql, params) = build_update(schema, table, pk, column, &coltype, new_value);

    // Single-row guard: UPDATE inside a tx; ROLLBACK unless exactly one row matched
    // (prevents wrong/multi-row updates — the row changed/was deleted meanwhile, or
    // the PK isn't unique).
    let mut tx = pool.begin().await.map_err(AriadneError::from)?;
    let mut q = sqlx::query(&sql);
    for pval in &params {
        q = q.bind(*pval);
    }
    let res = q.execute(&mut *tx).await.map_err(AriadneError::from)?;
    let n = res.rows_affected();
    if n != 1 {
        tx.rollback().await.map_err(AriadneError::from)?;
        return Err(AriadneError::new(
            ErrorKind::Internal,
            format!("expected exactly 1 row, matched {n} — refusing to update"),
        ));
    }
    tx.commit().await.map_err(AriadneError::from)?;
    Ok(UpdateResult { updated: n })
}

/// Builds the UPDATE SQL and the bind order (pure; no DB access → testable).
/// `new_value` Some → `SET col = $1::type` + PK $2..; None → `SET col = NULL` + PK $1..
/// PK comparison is `col::text = $n` (both sides are text, so they match without a cast).
fn build_update<'a>(
    schema: &str,
    table: &str,
    pk: &'a [PkPredicate],
    column: &str,
    coltype: &str,
    new_value: Option<&'a str>,
) -> (String, Vec<&'a str>) {
    let tbl = qualified(schema, table);
    let qcol = quote_ident(column);
    let mut params: Vec<&str> = Vec::new();
    let set_expr = match new_value {
        Some(v) => {
            params.push(v);
            format!("{qcol} = $1::{coltype}")
        }
        None => format!("{qcol} = NULL"),
    };
    let mut where_parts = Vec::with_capacity(pk.len());
    for p in pk {
        params.push(p.value.as_str());
        where_parts.push(format!(
            "{}::text = ${}",
            quote_ident(&p.column),
            params.len()
        ));
    }
    let sql = format!(
        "UPDATE {tbl} SET {set_expr} WHERE {}",
        where_parts.join(" AND ")
    );
    (sql, params)
}

#[cfg(test)]
mod tests {
    use super::{build_update, do_update_cell, quote_ident, PkPredicate};

    fn pk(col: &str, val: &str) -> PkPredicate {
        PkPredicate {
            column: col.to_string(),
            value: val.to_string(),
        }
    }

    #[test]
    fn quote_ident_escapes_embedded_quotes() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("my table"), "\"my table\"");
        // Embedded double-quotes are doubled (injection closed).
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn build_update_value_numbers_params_after_set() {
        let pks = [pk("id", "7")];
        let (sql, params) = build_update("public", "t", &pks, "name", "text", Some("bob"));
        assert_eq!(
            sql,
            "UPDATE \"public\".\"t\" SET \"name\" = $1::text WHERE \"id\"::text = $2"
        );
        assert_eq!(params, vec!["bob", "7"]);
    }

    #[test]
    fn build_update_null_starts_pk_at_one() {
        let pks = [pk("id", "7")];
        let (sql, params) = build_update("public", "t", &pks, "name", "text", None);
        assert_eq!(
            sql,
            "UPDATE \"public\".\"t\" SET \"name\" = NULL WHERE \"id\"::text = $1"
        );
        assert_eq!(params, vec!["7"]);
    }

    #[test]
    fn build_update_composite_pk() {
        let pks = [pk("a", "1"), pk("b", "2")];
        let (sql, params) = build_update("s", "t", &pks, "v", "integer", Some("9"));
        assert_eq!(
            sql,
            "UPDATE \"s\".\"t\" SET \"v\" = $1::integer WHERE \"a\"::text = $2 AND \"b\"::text = $3"
        );
        assert_eq!(params, vec!["9", "1", "2"]);
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn update_cell_round_trip_and_multi_match_rollback() {
        // TEMP tables (session-local) → never touch user data. max_connections=1 keeps
        // the temp table + update on the same connection.
        let url = std::env::var("ARIADNE_DATABASE_URL").expect("ARIADNE_DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TEMP TABLE ariadne_edit(id int PRIMARY KEY, name text); \
             INSERT INTO ariadne_edit VALUES (1,'a'),(2,'b'); \
             CREATE TEMP TABLE ariadne_dup(g int, name text); \
             INSERT INTO ariadne_dup VALUES (5,'x'),(5,'y')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // The temp table's real schema name (pg_temp_N) so to_regclass can resolve it.
        let tsch: String =
            sqlx::query_scalar("SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()")
                .fetch_one(&pool)
                .await
                .unwrap();

        // (1) normal update: exactly 1 row.
        let r = do_update_cell(
            &pool,
            &tsch,
            "ariadne_edit",
            &[pk("id", "1")],
            "name",
            Some("zzz"),
        )
        .await
        .unwrap();
        assert_eq!(r.updated, 1);
        let got: String = sqlx::query_scalar("SELECT name FROM ariadne_edit WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(got, "zzz");

        // (2) writing NULL.
        do_update_cell(&pool, &tsch, "ariadne_edit", &[pk("id", "2")], "name", None)
            .await
            .unwrap();
        let is_null: bool = sqlx::query_scalar("SELECT name IS NULL FROM ariadne_edit WHERE id=2")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(is_null);

        // (3) multi-match (g=5 hits two rows) → rollback + error; data unchanged.
        let err = do_update_cell(
            &pool,
            &tsch,
            "ariadne_dup",
            &[pk("g", "5")],
            "name",
            Some("nope"),
        )
        .await
        .expect_err("a multi-match must be rejected");
        assert!(err.message.contains("matched 2"), "msg={}", err.message);
        let untouched: i64 =
            sqlx::query_scalar("SELECT count(*) FROM ariadne_dup WHERE name='nope'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(untouched, 0, "rollback → no row should change");
    }
}
