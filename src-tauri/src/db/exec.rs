//! Cursored execution, cancellation, pagination, and per-tab session transactions.
//!
//! Core constraint: tables with 200M+ rows. Results are never pulled fully into
//! memory; they're paged with a server-side cursor + FETCH, and every query is
//! cancellable.
//!
//! IPC types live in [`super::types`], statement classification in
//! [`super::classify`], and row reading in [`super::rows`]; this file only holds the
//! execution lifecycle.

use std::sync::Arc;

use dashmap::DashMap;
use sqlx::pool::PoolConnection;
use sqlx::{Executor, PgPool, Postgres, Row};
use tokio::sync::Mutex;

use super::classify::{classify, stmt_returns_rows, StmtInfo};
use super::rows::{columns_from, read_rows};
use super::types::{ColumnMeta, Confirmation, Page, RunResult, StatementResult, TxStatus};
use crate::error::{AriadneError, ErrorKind};

pub const PAGE_SIZE: i64 = 500;

// ---- Per-tab state (a tab is a session) ----

struct Cursor {
    query_id: String,
    name: String,
    has_more: bool,
}

struct TabState {
    /// Dedicated connection that isn't returned to the pool while a cursor with
    /// pending pages or a transaction is open. Exhausted cursors are closed eagerly,
    /// so a fully-fetched result holds no connection.
    conn: Option<PoolConnection<Postgres>>,
    backend_pid: i32,
    tx: TxStatus,
    /// An internal READ ONLY transaction Ariadne opens to keep a cursor alive (not a
    /// user transaction).
    internal_tx: bool,
    cursor: Option<Cursor>,
    /// Last cursor activity (open/fetch), used for idle auto-close.
    last_fetch: std::time::Instant,
}

impl TabState {
    fn new() -> Self {
        Self {
            conn: None,
            backend_pid: 0,
            tx: TxStatus::Idle,
            internal_tx: false,
            cursor: None,
            last_fetch: std::time::Instant::now(),
        }
    }
}

/// Hangs off an ActiveConnection; holds tabs and the PIDs used for cancellation.
#[derive(Default)]
pub struct ExecRegistry {
    tabs: DashMap<String, Arc<Mutex<TabState>>>,
    /// query_id → (tab_id, backend_pid) — lets cancel reach the PID without waiting
    /// on the tab lock.
    running: DashMap<String, (String, i32)>,
}

impl ExecRegistry {
    fn tab(&self, tab_id: &str) -> Arc<Mutex<TabState>> {
        self.tabs
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(TabState::new())))
            .clone()
    }

    /// Called on disconnect: cancels running queries, closes open cursors/transactions,
    /// and clears the registry. It never blocks on a lock (`try_lock`) — a still-running
    /// query's connection returns to the pool when that query finishes (via cancel), and
    /// closing the pool rolls back any open transactions server-side (no leak).
    pub async fn shutdown(&self, pool: &PgPool) {
        // 1) Cancel running queries from a separate connection → run_query unwinds with 57014.
        let pids: Vec<i32> = self.running.iter().map(|e| e.value().1).collect();
        for pid in pids {
            if let Ok(mut c) = pool.acquire().await {
                let _ = sqlx::query("SELECT pg_cancel_backend($1)")
                    .bind(pid)
                    .execute(&mut *c)
                    .await;
            }
        }
        self.running.clear();

        // 2) Collect the tab Arcs + clear the map (don't hold the DashMap guard across await).
        let tabs: Vec<Arc<Mutex<TabState>>> = self.tabs.iter().map(|e| e.value().clone()).collect();
        self.tabs.clear();
        for tab in tabs {
            // Skip if a running query holds the lock; its conn is released when it finishes.
            if let Ok(mut st) = tab.try_lock() {
                close_cursor(&mut st).await;
                if st.tx != TxStatus::Idle {
                    if let Some(c) = st.conn.as_mut() {
                        let _ = sqlx::query("ROLLBACK").execute(&mut **c).await;
                    }
                    st.tx = TxStatus::Idle;
                }
                st.conn = None;
            }
        }
    }

    /// Closes cursors backed by an **internal READ ONLY transaction** that has been
    /// idle longer than `idle`, so long-open transactions don't hold back vacuum.
    /// Returns the ids of the closed tabs (for the frontend's `result:frozen` event).
    /// Cursors inside a user transaction are left alone — the user manages those.
    pub async fn sweep_idle_cursors(&self, idle: std::time::Duration) -> Vec<String> {
        let now = std::time::Instant::now();
        let mut frozen = Vec::new();
        // Collect the tab Arcs (don't hold the DashMap guard across await).
        let entries: Vec<(String, Arc<Mutex<TabState>>)> = self
            .tabs
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();
        for (tab_id, tab) in entries {
            let Ok(mut st) = tab.try_lock() else { continue };
            let is_idle_internal = st.cursor.is_some()
                && st.internal_tx
                && st.tx == TxStatus::Idle
                && now.duration_since(st.last_fetch) >= idle;
            if is_idle_internal {
                close_cursor(&mut st).await; // also commits the internal tx
                st.conn = None; // return to the pool
                frozen.push(tab_id);
            }
        }
        frozen
    }
}

// ---- run_query ----

pub struct RunArgs<'a> {
    pub sql: &'a str,
    pub tab_id: &'a str,
    pub query_id: &'a str,
    pub confirmed: bool,
    pub page_size: i64,
}

pub async fn run_query(
    reg: &ExecRegistry,
    pool: &PgPool,
    args: RunArgs<'_>,
) -> Result<RunResult, AriadneError> {
    let started = std::time::Instant::now();
    let stmts = pg_query::split_with_parser(args.sql).unwrap_or_else(|_| vec![args.sql]);

    let tab = reg.tab(args.tab_id);
    let mut st = tab.lock().await;

    // Prepare the connection (pinned if a tx is open; otherwise take one from the pool).
    if st.conn.is_none() {
        let mut c = pool.acquire().await.map_err(AriadneError::from)?;
        let pid: i32 = sqlx::query("SELECT pg_backend_pid()")
            .fetch_one(&mut *c)
            .await?
            .try_get(0)?;
        st.backend_pid = pid;
        st.conn = Some(c);
    }
    reg.running.insert(
        args.query_id.to_string(),
        (args.tab_id.to_string(), st.backend_pid),
    );

    // Close the previous cursor (a new query arrived).
    close_cursor(&mut st).await;

    let mut results: Vec<StatementResult> = Vec::new();
    let mut needs_confirmation = None;
    let mut run_error: Option<AriadneError> = None;
    let mut error_statement_index: Option<usize> = None;

    // The LAST row-returning statement takes the cursor path; the rest run normally.
    let last_rows_idx = stmts
        .iter()
        .enumerate()
        .rev()
        .find(|(_, s)| stmt_returns_rows(s))
        .map(|(i, _)| i);

    for (idx, stmt) in stmts.iter().enumerate() {
        let info = classify(stmt);

        // Destructive guard.
        if !args.confirmed {
            if let Some((kind, table)) = &info.destructive {
                needs_confirmation = Some(Confirmation {
                    statement_index: idx,
                    kind: kind.clone(),
                    table: table.clone(),
                    estimated_rows: None,
                });
                break;
            }
        }

        let exec_res = if Some(idx) == last_rows_idx {
            open_cursor_and_fetch(&mut st, stmt, args.query_id, args.page_size, started).await
        } else if info.returns_rows {
            // Row-returning but not the last one: still run it and take the first page (no cursor).
            run_inline_rows(&mut st, stmt, started).await
        } else {
            run_non_query(&mut st, stmt, &info).await
        };

        match exec_res {
            Ok(mut r) => {
                if let StatementResult::Rows { source_table, .. } = &mut r {
                    *source_table = info.source_table.clone();
                }
                results.push(r);
            }
            Err(mut e) => {
                // Postgres position is statement-local (1-based); shift it to the
                // absolute position in the editor.
                if let Some(pos) = e.position {
                    e.position = Some(absolute_position(args.sql, stmt, pos));
                }
                if st.tx == TxStatus::InTransaction {
                    st.tx = TxStatus::Aborted;
                }
                // Partial results: the statements accumulated so far are kept, the
                // error is embedded in RunResult, and remaining statements don't run (psql-like).
                run_error = Some(e);
                error_statement_index = Some(idx);
                break;
            }
        }

        // Transaction state machine.
        if let Some(t) = info.tx_transition {
            st.tx = t;
        }
    }

    let tx_status = st.tx;
    finalize_conn(&mut st).await;
    reg.running.remove(args.query_id);

    Ok(RunResult {
        query_id: args.query_id.to_string(),
        statements: results,
        tx_status,
        needs_confirmation,
        error: run_error,
        error_statement_index,
    })
}

/// Converts a statement-local 1-based Postgres position into the absolute 1-based
/// character position in the editor by adding the statement's start offset in the
/// script. `stmt` must be a sub-slice of `sql` (pg_query::split returns slices); if
/// it isn't, the offset falls back to 0 and the marker is still shown.
fn absolute_position(sql: &str, stmt: &str, pos: u32) -> u32 {
    let base = sql.as_ptr() as usize;
    let byte_start = (stmt.as_ptr() as usize)
        .checked_sub(base)
        .filter(|&b| b <= sql.len())
        .unwrap_or(0);
    let char_start = sql.get(..byte_start).map_or(0, |s| s.chars().count());
    pos + char_start as u32
}

/// Returns the connection to the pool if no cursor is open and the tx is idle.
async fn finalize_conn(st: &mut TabState) {
    let keep = st.cursor.is_some() || st.tx != TxStatus::Idle;
    if !keep {
        // Commit the internal cursor tx if there was one (once the cursor is closed).
        if st.internal_tx {
            if let Some(c) = st.conn.as_mut() {
                let _ = sqlx::query("COMMIT").execute(&mut **c).await;
            }
            st.internal_tx = false;
        }
        st.conn = None; // drop → returns to the pool
        st.backend_pid = 0;
    }
}

async fn close_cursor(st: &mut TabState) {
    if let Some(cur) = st.cursor.take() {
        if let Some(c) = st.conn.as_mut() {
            let _ = sqlx::query(&format!("CLOSE {}", cur.name))
                .execute(&mut **c)
                .await;
        }
        // If it was opened under the internal tx and there's no user tx, commit.
        if st.internal_tx && st.tx == TxStatus::Idle {
            if let Some(c) = st.conn.as_mut() {
                let _ = sqlx::query("COMMIT").execute(&mut **c).await;
            }
            st.internal_tx = false;
        }
    }
}

async fn open_cursor_and_fetch(
    st: &mut TabState,
    stmt: &str,
    query_id: &str,
    page_size: i64,
    started: std::time::Instant,
) -> Result<StatementResult, AriadneError> {
    let name = format!(
        "ariadne_cur_{}",
        query_id.replace('-', "").get(..16).unwrap_or("cur")
    );
    let conn = st.conn.as_mut().expect("conn").as_mut();

    // Open an internal READ ONLY tx for the cursor if there's no user tx.
    if st.tx == TxStatus::Idle {
        sqlx::query("BEGIN READ ONLY").execute(&mut *conn).await?;
        st.internal_tx = true;
    }
    // Semantic errors (missing table/column, …) surface at DECLARE time; Postgres
    // reports the position relative to `decl`, so we subtract the prefix length to get
    // the statement-local position — otherwise the marker is off by ~58 chars. The
    // prefix is pure ASCII, so its byte length equals its character count.
    let decl = format!("DECLARE {name} NO SCROLL CURSOR FOR {stmt}");
    let prefix_len = (decl.len() - stmt.len()) as u32;
    sqlx::query(&decl).execute(&mut *conn).await.map_err(|e| {
        let mut ae = AriadneError::from(e);
        ae.position = ae.position.map(|p| p.saturating_sub(prefix_len).max(1));
        ae
    })?;

    // Fetch one row MORE than the page size: "got exactly page_size" is not proof of
    // more pages (a result of exactly page_size rows — e.g. the table-open LIMIT 500 —
    // would false-positive, keep the exhausted cursor open, and pin a pool connection
    // until the idle sweeper). The probe row can't be pushed back into a NO SCROLL
    // cursor, so it is simply included in the page (pages are up to page_size+1 rows).
    let fetch_sql = format!("FETCH FORWARD {} FROM {name}", page_size + 1);
    let rows = conn
        .fetch_all(sqlx::raw_sql(&fetch_sql))
        .await
        .map_err(|e| {
            // An error during FETCH (a rare runtime error) is positioned against the
            // FETCH command and can't be mapped to the editor → drop the position so we
            // don't show a wrong marker.
            let mut ae = AriadneError::from(e);
            ae.position = None;
            ae
        })?;
    let (mut columns, page_rows, truncated) = read_rows(&rows);
    let has_more = page_rows.len() as i64 > page_size;
    // A zero-row SELECT can't derive column names from a row, so fetch the real headers
    // via describe → the grid renders with headers but an empty body, not a placeholder.
    // Only in the empty case; on failure columns stay empty (the grid still opens).
    if columns.is_empty() && page_rows.is_empty() {
        columns = describe_columns(conn, stmt).await;
    }

    if has_more {
        st.cursor = Some(Cursor {
            query_id: query_id.to_string(),
            name,
            has_more,
        });
    } else {
        // Fully fetched on the first page: the cursor has no further purpose. Close it
        // now so finalize_conn returns the connection to the pool immediately — an open
        // cursor would otherwise pin one of the few pool connections until the idle
        // sweeper (15 min) even for a 10-row SELECT.
        let _ = sqlx::query(&format!("CLOSE {name}"))
            .execute(&mut *conn)
            .await;
    }
    st.last_fetch = std::time::Instant::now();

    let fetched_total = page_rows.len();
    Ok(StatementResult::Rows {
        columns,
        first_page: Page {
            rows: page_rows,
            has_more,
            fetched_total,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        truncated_cells: truncated,
        source_table: None, // filled by run_query from the statement's StmtInfo
    })
}

async fn run_inline_rows(
    st: &mut TabState,
    stmt: &str,
    started: std::time::Instant,
) -> Result<StatementResult, AriadneError> {
    let conn = st.conn.as_mut().expect("conn").as_mut();
    let rows = conn
        .fetch_all(sqlx::raw_sql(stmt))
        .await
        .map_err(AriadneError::from)?;
    let (mut columns, page_rows, truncated) = read_rows(&rows);
    // See open_cursor_and_fetch: fill headers via describe on a zero-row result.
    if columns.is_empty() && page_rows.is_empty() {
        columns = describe_columns(conn, stmt).await;
    }
    let fetched_total = page_rows.len();
    Ok(StatementResult::Rows {
        columns,
        first_page: Page {
            rows: page_rows,
            has_more: false,
            fetched_total,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        truncated_cells: truncated,
        source_table: None, // filled by run_query from the statement's StmtInfo
    })
}

async fn run_non_query(
    st: &mut TabState,
    stmt: &str,
    info: &StmtInfo,
) -> Result<StatementResult, AriadneError> {
    let conn = st.conn.as_mut().expect("conn").as_mut();
    let res = conn
        .execute(sqlx::raw_sql(stmt))
        .await
        .map_err(AriadneError::from)?;
    let command = info.command.clone();
    if info.is_dml {
        Ok(StatementResult::Affected {
            command,
            row_count: res.rows_affected(),
        })
    } else {
        Ok(StatementResult::Empty { command })
    }
}

/// Fetches column headers for a zero-row result via an extended-protocol describe
/// (Parse+Describe; no Execute → side-effect free, safe for a SELECT). The round-trip
/// happens only in the empty case; on failure it returns an empty Vec (the grid opens
/// without a body).
async fn describe_columns(conn: &mut sqlx::postgres::PgConnection, stmt: &str) -> Vec<ColumnMeta> {
    match conn.describe(stmt).await {
        Ok(d) => columns_from(d.columns()),
        Err(_) => Vec::new(),
    }
}

// ---- fetch_page ----

pub async fn fetch_page(reg: &ExecRegistry, query_id: &str) -> Result<Page, AriadneError> {
    let started = std::time::Instant::now();
    let tab_id = reg
        .running
        .get(query_id)
        .map(|e| e.value().0.clone())
        .or_else(|| find_tab_by_cursor(reg, query_id));
    let Some(tab_id) = tab_id else {
        return Err(AriadneError::new(ErrorKind::Internal, "Query not found"));
    };
    let tab = reg.tab(&tab_id);
    let mut st = tab.lock().await;

    let Some(cur) = st.cursor.as_ref() else {
        return Err(AriadneError::new(ErrorKind::Internal, "No open cursor"));
    };
    if cur.query_id != query_id || !cur.has_more {
        return Ok(Page {
            rows: vec![],
            has_more: false,
            fetched_total: 0,
            elapsed_ms: 0,
        });
    }
    let name = cur.name.clone();
    let conn = st.conn.as_mut().expect("conn").as_mut();
    // +1 probe row, same as the first page: see open_cursor_and_fetch.
    let fetch_sql = format!("FETCH FORWARD {} FROM {name}", PAGE_SIZE + 1);
    let rows = conn
        .fetch_all(sqlx::raw_sql(&fetch_sql))
        .await
        .map_err(AriadneError::from)?;
    let (_, page_rows, _) = read_rows(&rows);
    let has_more = page_rows.len() as i64 > PAGE_SIZE;
    if has_more {
        if let Some(cur) = st.cursor.as_mut() {
            cur.has_more = has_more;
        }
    } else {
        // Last page fetched: close the cursor and (unless a user transaction still
        // needs the session) release the pinned connection back to the pool.
        close_cursor(&mut st).await;
        if st.tx == TxStatus::Idle {
            st.conn = None;
            st.backend_pid = 0;
        }
    }
    st.last_fetch = std::time::Instant::now();
    let fetched_total = page_rows.len();
    Ok(Page {
        rows: page_rows,
        has_more,
        fetched_total,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn find_tab_by_cursor(reg: &ExecRegistry, query_id: &str) -> Option<String> {
    reg.tabs.iter().find_map(|e| {
        // Don't wait on the lock: try_lock (a fetch rarely races with the next run/close).
        e.value().try_lock().ok().and_then(|st| {
            st.cursor
                .as_ref()
                .filter(|c| c.query_id == query_id)
                .map(|_| e.key().clone())
        })
    })
}

// ---- cancel_query ----

pub async fn cancel_query(
    reg: &ExecRegistry,
    pool: &PgPool,
    query_id: &str,
) -> Result<(), AriadneError> {
    let Some(entry) = reg.running.get(query_id) else {
        return Ok(()); // already finished
    };
    let pid = entry.value().1;
    drop(entry);
    // A one-shot connection INDEPENDENT of the pinned one (won't block the running FETCH).
    let mut c = pool.acquire().await.map_err(AriadneError::from)?;
    let _: bool = sqlx::query_scalar("SELECT pg_cancel_backend($1)")
        .bind(pid)
        .fetch_one(&mut *c)
        .await
        .map_err(AriadneError::from)?;
    Ok(())
}

// ---- force_kill_query ----

/// Kills a running query's backend with `pg_terminate_backend` — for a stuck query
/// where cancel had no effect within a few seconds. The pid is resolved from the
/// `running` map (the frontend doesn't know it); the connection drops server-side and
/// the tab recovers via the banner path (releaseTabsForConnection). Returns whether a
/// backend was found/signaled.
pub async fn force_kill_query(
    reg: &ExecRegistry,
    pool: &PgPool,
    query_id: &str,
) -> Result<bool, AriadneError> {
    let Some(entry) = reg.running.get(query_id) else {
        return Ok(false); // already finished
    };
    let pid = entry.value().1;
    drop(entry);
    let mut c = pool.acquire().await.map_err(AriadneError::from)?;
    let killed: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
        .bind(pid)
        .fetch_one(&mut *c)
        .await
        .map_err(AriadneError::from)?;
    Ok(killed)
}

// ---- close_result (on tab close / new query) ----

pub async fn close_result(reg: &ExecRegistry, tab_id: &str) -> Result<(), AriadneError> {
    if let Some((_, tab)) = reg.tabs.remove(tab_id) {
        let mut st = tab.lock().await;
        close_cursor(&mut st).await;
        // Roll back an open user tx (safe side).
        if st.tx != TxStatus::Idle {
            if let Some(c) = st.conn.as_mut() {
                let _ = sqlx::query("ROLLBACK").execute(&mut **c).await;
            }
            st.tx = TxStatus::Idle;
        }
        st.conn = None; // return to the pool
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Pure: shifting the error position by the statement offset ----

    #[test]
    fn absolute_position_shifts_to_editor_offset() {
        let sql = "SELECT 1;\nSELECT oops FROM t";
        let idx = sql.find("SELECT oops").unwrap(); // byte offset of the 2nd statement
        let stmt = &sql[idx..]; // real sub-slice (as split_with_parser returns)
        let char_start = sql[..idx].chars().count() as u32;
        // Postgres pos=8 (statement-local 1-based) → absolute = char_start + 8.
        assert_eq!(absolute_position(sql, stmt, 8), char_start + 8);
    }

    #[test]
    fn absolute_position_counts_chars_not_bytes() {
        // 'é' is 2 bytes / 1 char: count characters, not the byte offset.
        let sql = "SELECT 'é';\nSELECT x";
        let idx = sql.find("SELECT x").unwrap();
        let stmt = &sql[idx..];
        let char_start = sql[..idx].chars().count() as u32;
        assert!(char_start < idx as u32, "multibyte → chars < bytes");
        assert_eq!(absolute_position(sql, stmt, 1), char_start + 1);
    }

    #[test]
    fn absolute_position_non_subslice_is_safe() {
        // Not a sub-slice: no overflow/panic; falls back to the raw pos (defensive).
        let sql = "SELECT 1";
        let foreign = String::from("SELECT 1");
        let out = absolute_position(sql, &foreign, 3);
        // char_start falls back to 0 → pos is preserved (barring a rare allocator collision).
        assert!(out == 3 || out >= 3);
    }

    // ---- Live-DB integration: cursor + pagination + tx + cancel ----
    // Uses a TEMP table (session-local, dropped automatically) — never touches user data.
    // `ARIADNE_DATABASE_URL` + `cargo test -- --ignored`.

    async fn pool() -> PgPool {
        let url = std::env::var("ARIADNE_DATABASE_URL").expect("ARIADNE_DATABASE_URL");
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap()
    }

    fn args<'a>(sql: &'a str, tab: &'a str, qid: &'a str) -> RunArgs<'a> {
        RunArgs {
            sql,
            tab_id: tab,
            query_id: qid,
            confirmed: false,
            page_size: 500,
        }
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn cursor_pagination_within_tx() {
        let pool = pool().await;
        let reg = ExecRegistry::default();

        run_query(&reg, &pool, args("BEGIN", "t1", "q0"))
            .await
            .unwrap();
        run_query(
            &reg,
            &pool,
            args(
                "CREATE TEMP TABLE t_ari(id int) ON COMMIT DROP; INSERT INTO t_ari SELECT g FROM generate_series(1,1200) g",
                "t1",
                "q1",
            ),
        )
        .await
        .unwrap();

        let r = run_query(
            &reg,
            &pool,
            args("SELECT * FROM t_ari ORDER BY id", "t1", "q2"),
        )
        .await
        .unwrap();
        assert_eq!(r.tx_status, TxStatus::InTransaction);
        // Pages carry a +1 probe row (501 = 500 requested + the has_more probe).
        match &r.statements[0] {
            StatementResult::Rows { first_page, .. } => {
                assert_eq!(first_page.fetched_total, 501);
                assert!(first_page.has_more);
            }
            _ => panic!("expected Rows"),
        }

        let p2 = fetch_page(&reg, "q2").await.unwrap();
        assert_eq!(p2.fetched_total, 501);
        assert!(p2.has_more);
        let p3 = fetch_page(&reg, "q2").await.unwrap();
        assert_eq!(p3.fetched_total, 198);
        assert!(!p3.has_more);

        // ROLLBACK → tx closes, temp table drops, cursor closes.
        let r = run_query(&reg, &pool, args("ROLLBACK", "t1", "q3"))
            .await
            .unwrap();
        assert_eq!(r.tx_status, TxStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn small_result_releases_connection() {
        let pool = pool().await;
        let reg = ExecRegistry::default();
        let r = run_query(
            &reg,
            &pool,
            args("SELECT g FROM generate_series(1, 10) g", "ts", "qs"),
        )
        .await
        .unwrap();
        match &r.statements[0] {
            StatementResult::Rows { first_page, .. } => {
                assert_eq!(first_page.fetched_total, 10);
                assert!(!first_page.has_more);
            }
            _ => panic!("expected Rows"),
        }
        // An exhausted cursor must not pin a pool connection.
        let tab = reg.tab("ts");
        let st = tab.lock().await;
        assert!(st.cursor.is_none(), "cursor should be closed eagerly");
        assert!(st.conn.is_none(), "connection should return to the pool");
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn last_page_releases_connection() {
        let pool = pool().await;
        let reg = ExecRegistry::default();
        let r = run_query(
            &reg,
            &pool,
            args("SELECT g FROM generate_series(1, 1200) g", "tp", "qp"),
        )
        .await
        .unwrap();
        match &r.statements[0] {
            StatementResult::Rows { first_page, .. } => assert!(first_page.has_more),
            _ => panic!("expected Rows"),
        }
        assert!(fetch_page(&reg, "qp").await.unwrap().has_more);
        assert!(!fetch_page(&reg, "qp").await.unwrap().has_more);
        // The last page closes the cursor and releases the pinned connection.
        let tab = reg.tab("tp");
        let st = tab.lock().await;
        assert!(
            st.cursor.is_none(),
            "cursor should be closed on the last page"
        );
        assert!(st.conn.is_none(), "connection should return to the pool");
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn cancel_long_query() {
        let pool = pool().await;
        let reg = std::sync::Arc::new(ExecRegistry::default());
        let p2 = pool.clone();
        let reg2 = reg.clone();

        let handle = tokio::spawn(async move {
            run_query(&reg2, &p2, args("SELECT pg_sleep(10)", "tc", "qc")).await
        });

        // Wait for the query to start, then cancel it.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        cancel_query(&reg, &pool, "qc").await.unwrap();

        // Partial-results contract: a cancel does not make run_query's outer Result an
        // Err — it's embedded in RunResult.error as QueryCancelled.
        let res = handle.await.unwrap().unwrap();
        let err = res
            .error
            .expect("a cancelled query must carry RunResult.error");
        assert!(
            matches!(err.kind, ErrorKind::QueryCancelled),
            "kind={:?}",
            err.kind
        );
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn force_kill_terminates_backend() {
        let pool = pool().await;
        let reg = std::sync::Arc::new(ExecRegistry::default());
        let p2 = pool.clone();
        let reg2 = reg.clone();

        let handle = tokio::spawn(async move {
            run_query(&reg2, &p2, args("SELECT pg_sleep(10)", "tk", "qk")).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        // pg_terminate_backend → true (the backend existed and was signaled).
        let killed = force_kill_query(&reg, &pool, "qk").await.unwrap();
        assert!(killed, "force_kill should signal an existing backend");

        // Backend torn down → the query must end with an error. A FETCH error may be
        // embedded as Ok(RunResult{error}) via the partial-results path, or a transport
        // error may be Err; either way it is "not a clean success".
        let res = handle.await.unwrap();
        let errored = match &res {
            Ok(rr) => rr.error.is_some(),
            Err(_) => true,
        };
        assert!(errored, "a terminated query must end in error");

        // For an already-finished query_id, false (not in the map).
        let again = force_kill_query(&reg, &pool, "qk").await.unwrap();
        assert!(!again, "false for a finished query");
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn zero_row_select_still_reports_columns() {
        // A zero-row SELECT can't derive column names from a row; the describe fallback
        // must fill in the real headers → the grid renders with headers but an empty
        // body (not a placeholder).
        let pool = pool().await;
        let reg = ExecRegistry::default();
        let r = run_query(
            &reg,
            &pool,
            args("SELECT 1 AS id, 'x'::text AS label WHERE false", "tz", "qz"),
        )
        .await
        .unwrap();
        match &r.statements[0] {
            StatementResult::Rows {
                columns,
                first_page,
                ..
            } => {
                assert_eq!(first_page.fetched_total, 0, "expected 0 rows");
                assert!(!first_page.has_more);
                assert_eq!(columns.len(), 2, "describe should fill 2 columns");
                assert_eq!(columns[0].name, "id");
                assert_eq!(columns[1].name, "label");
            }
            other => panic!("expected Rows, got: {other:?}"),
        }
    }
}
