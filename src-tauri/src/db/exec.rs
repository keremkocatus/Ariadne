//! Cursor'lu execution, iptal, pagination, tab=session transaction (design 05).
//!
//! Ana kısıt: 200M+ satırlık tablolar. Sonuç asla komple belleğe çekilmez;
//! server-side cursor + FETCH ile sayfalanır. Her sorgu iptal edilebilir.

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use sqlx::pool::PoolConnection;
use sqlx::{Column, Executor, PgPool, Postgres, Row, TypeInfo};
use tokio::sync::Mutex;

use crate::error::{AriadneError, ErrorKind};

pub const PAGE_SIZE: i64 = 500;
pub const MAX_CELL_BYTES: usize = 8 * 1024;

// ---- Frontend sözleşmesi (design 02 §3) ----

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub query_id: String,
    pub statements: Vec<StatementResult>,
    pub tx_status: TxStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_confirmation: Option<Confirmation>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatementResult {
    Rows {
        columns: Vec<ColumnMeta>,
        first_page: Page,
        truncated_cells: bool,
    },
    Affected {
        command: String,
        row_count: u64,
    },
    Empty {
        command: String,
    },
}

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub type_oid: u32,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub rows: Vec<Vec<Option<String>>>,
    pub has_more: bool,
    pub fetched_total: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    Idle,
    InTransaction,
    Aborted,
}

#[derive(Debug, Serialize)]
pub struct Confirmation {
    pub statement_index: usize,
    pub kind: String, // "update" | "delete" | "truncate"
    pub table: String,
    pub estimated_rows: Option<i64>,
}

// ---- Tab durumu (design 05 §7: tab = session) ----

struct Cursor {
    query_id: String,
    name: String,
    has_more: bool,
}

struct TabState {
    /// Açık cursor veya açık tx varken pool'a iade edilmeyen dedicated bağlantı.
    conn: Option<PoolConnection<Postgres>>,
    backend_pid: i32,
    tx: TxStatus,
    /// Cursor'un yaşaması için Ariadne'nin açtığı iç READ ONLY tx (kullanıcı tx'i değil).
    internal_tx: bool,
    cursor: Option<Cursor>,
}

impl TabState {
    fn new() -> Self {
        Self {
            conn: None,
            backend_pid: 0,
            tx: TxStatus::Idle,
            internal_tx: false,
            cursor: None,
        }
    }
}

/// ActiveConnection'a asılı; tab'ları ve iptal için PID'leri tutar.
#[derive(Default)]
pub struct ExecRegistry {
    tabs: DashMap<String, Arc<Mutex<TabState>>>,
    /// query_id → (tab_id, backend_pid) — iptal tab kilidi beklemeden PID'e ulaşsın.
    running: DashMap<String, (String, i32)>,
}

impl ExecRegistry {
    fn tab(&self, tab_id: &str) -> Arc<Mutex<TabState>> {
        self.tabs
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(TabState::new())))
            .clone()
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

    // Bağlantıyı hazırla (açık tx varsa pinned; yoksa pool'dan al).
    if st.conn.is_none() {
        let mut c = pool.acquire().await.map_err(AriadneError::from)?;
        let pid: i32 = sqlx::query("SELECT pg_backend_pid()")
            .fetch_one(&mut *c)
            .await?
            .try_get(0)?;
        st.backend_pid = pid;
        st.conn = Some(c);
    }
    reg.running
        .insert(args.query_id.to_string(), (args.tab_id.to_string(), st.backend_pid));

    // Önceki cursor'u kapat (yeni sorgu geldi).
    close_cursor(&mut st).await;

    let mut results: Vec<StatementResult> = Vec::new();
    let mut needs_confirmation = None;

    // Row döndüren SON statement cursor yoluna girer; diğerleri normal.
    let last_rows_idx = stmts
        .iter()
        .enumerate()
        .rev()
        .find(|(_, s)| stmt_returns_rows(s))
        .map(|(i, _)| i);

    for (idx, stmt) in stmts.iter().enumerate() {
        let info = classify(stmt);

        // Destructive guard (design 05 §8).
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
            // Row döndüren ama son olmayan: yine de çalıştır, ilk sayfayı al (cursorsuz).
            run_inline_rows(&mut st, stmt, started).await
        } else {
            run_non_query(&mut st, stmt, &info).await
        };

        match exec_res {
            Ok(r) => results.push(r),
            Err(e) => {
                if st.tx == TxStatus::InTransaction {
                    st.tx = TxStatus::Aborted;
                }
                finalize_conn(&mut st).await;
                reg.running.remove(args.query_id);
                return Err(e);
            }
        }

        // Tx state machine (design 05 §7).
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
    })
}

/// Cursor açık değilse ve tx idle ise bağlantıyı pool'a iade et.
async fn finalize_conn(st: &mut TabState) {
    let keep = st.cursor.is_some() || st.tx != TxStatus::Idle;
    if !keep {
        // İç cursor tx'i varsa commit et (cursor kapanınca).
        if st.internal_tx {
            if let Some(c) = st.conn.as_mut() {
                let _ = sqlx::query("COMMIT").execute(&mut **c).await;
            }
            st.internal_tx = false;
        }
        st.conn = None; // drop → pool'a döner
        st.backend_pid = 0;
    }
}

async fn close_cursor(st: &mut TabState) {
    if let Some(cur) = st.cursor.take() {
        if let Some(c) = st.conn.as_mut() {
            let _ = sqlx::query(&format!("CLOSE {}", cur.name)).execute(&mut **c).await;
        }
        // İç tx ile açıldıysa ve kullanıcı tx'i yoksa commit.
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
    let name = format!("ariadne_cur_{}", query_id.replace('-', "").get(..16).unwrap_or("cur"));
    let conn = st.conn.as_mut().expect("conn").as_mut();

    // Kullanıcı tx'i yoksa cursor için iç READ ONLY tx aç.
    if st.tx == TxStatus::Idle {
        sqlx::query("BEGIN READ ONLY").execute(&mut *conn).await?;
        st.internal_tx = true;
    }
    let decl = format!("DECLARE {name} NO SCROLL CURSOR FOR {stmt}");
    sqlx::query(&decl).execute(&mut *conn).await?;

    let fetch_sql = format!("FETCH FORWARD {page_size} FROM {name}");
    let rows = conn.fetch_all(sqlx::raw_sql(&fetch_sql)).await.map_err(AriadneError::from)?;
    let (columns, page_rows, truncated) = read_rows(&rows);
    let has_more = page_rows.len() as i64 == page_size;

    st.cursor = Some(Cursor {
        query_id: query_id.to_string(),
        name,
        has_more,
    });

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
    })
}

async fn run_inline_rows(
    st: &mut TabState,
    stmt: &str,
    started: std::time::Instant,
) -> Result<StatementResult, AriadneError> {
    let conn = st.conn.as_mut().expect("conn").as_mut();
    let rows = conn.fetch_all(sqlx::raw_sql(stmt)).await.map_err(AriadneError::from)?;
    let (columns, page_rows, truncated) = read_rows(&rows);
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
    })
}

async fn run_non_query(
    st: &mut TabState,
    stmt: &str,
    info: &StmtInfo,
) -> Result<StatementResult, AriadneError> {
    let conn = st.conn.as_mut().expect("conn").as_mut();
    let res = conn.execute(sqlx::raw_sql(stmt)).await.map_err(AriadneError::from)?;
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
        return Ok(Page { rows: vec![], has_more: false, fetched_total: 0, elapsed_ms: 0 });
    }
    let name = cur.name.clone();
    let conn = st.conn.as_mut().expect("conn").as_mut();
    let fetch_sql = format!("FETCH FORWARD {PAGE_SIZE} FROM {name}");
    let rows = conn.fetch_all(sqlx::raw_sql(&fetch_sql)).await.map_err(AriadneError::from)?;
    let (_, page_rows, _) = read_rows(&rows);
    let has_more = page_rows.len() as i64 == PAGE_SIZE;
    if let Some(cur) = st.cursor.as_mut() {
        cur.has_more = has_more;
    }
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
        // lock beklemeden: try_lock (fetch bir sonraki run/close ile çakışmaz genelde)
        e.value().try_lock().ok().and_then(|st| {
            st.cursor.as_ref().filter(|c| c.query_id == query_id).map(|_| e.key().clone())
        })
    })
}

// ---- cancel_query (design 05 §3) ----

pub async fn cancel_query(reg: &ExecRegistry, pool: &PgPool, query_id: &str) -> Result<(), AriadneError> {
    let Some(entry) = reg.running.get(query_id) else {
        return Ok(()); // zaten bitmiş
    };
    let pid = entry.value().1;
    drop(entry);
    // Havuzdan BAĞIMSIZ, tek atımlık bağlantı (çalışan FETCH'i bloklamaz).
    let mut c = pool.acquire().await.map_err(AriadneError::from)?;
    let _: bool = sqlx::query_scalar("SELECT pg_cancel_backend($1)")
        .bind(pid)
        .fetch_one(&mut *c)
        .await
        .map_err(AriadneError::from)?;
    Ok(())
}

// ---- close_result (tab kapanınca / yeni sorgu) ----

pub async fn close_result(reg: &ExecRegistry, tab_id: &str) -> Result<(), AriadneError> {
    if let Some((_, tab)) = reg.tabs.remove(tab_id) {
        let mut st = tab.lock().await;
        close_cursor(&mut st).await;
        // Açık kullanıcı tx'i varsa rollback (güvenli taraf).
        if st.tx != TxStatus::Idle {
            if let Some(c) = st.conn.as_mut() {
                let _ = sqlx::query("ROLLBACK").execute(&mut **c).await;
            }
            st.tx = TxStatus::Idle;
        }
        st.conn = None; // pool'a iade
    }
    Ok(())
}

// ---- Satır okuma (text format, design 02 §3 / 05 §4) ----

fn read_rows(rows: &[sqlx::postgres::PgRow]) -> (Vec<ColumnMeta>, Vec<Vec<Option<String>>>, bool) {
    let columns: Vec<ColumnMeta> = match rows.first() {
        Some(r) => r
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
                type_oid: c.type_info().oid().map(|o| o.0).unwrap_or(0),
            })
            .collect(),
        None => Vec::new(),
    };
    let mut truncated = false;
    let out: Vec<Vec<Option<String>>> = rows
        .iter()
        .map(|r| {
            (0..columns.len())
                .map(|i| {
                    let v: Option<String> = r.try_get_unchecked(i).unwrap_or(None);
                    v.map(|s| {
                        if s.len() > MAX_CELL_BYTES {
                            truncated = true;
                            let mut t: String = s.chars().take(MAX_CELL_BYTES).collect();
                            t.push('…');
                            t
                        } else {
                            s
                        }
                    })
                })
                .collect()
        })
        .collect();
    (columns, out, truncated)
}

// ---- Statement sınıflandırma (pg_query AST) ----

struct StmtInfo {
    command: String,
    is_dml: bool,
    returns_rows: bool,
    destructive: Option<(String, String)>, // (kind, table)
    tx_transition: Option<TxStatus>,
}

fn stmt_returns_rows(sql: &str) -> bool {
    classify(sql).returns_rows
}

fn classify(sql: &str) -> StmtInfo {
    use pg_query::protobuf::node::Node as N;

    let command = first_keyword(sql);
    let mut info = StmtInfo {
        command: command.clone(),
        is_dml: matches!(command.as_str(), "INSERT" | "UPDATE" | "DELETE"),
        returns_rows: false,
        destructive: None,
        tx_transition: None,
    };

    let Ok(parsed) = pg_query::parse(sql) else {
        // Parse edilemezse: ilk kelimeye göre kaba tahmin.
        info.returns_rows = matches!(command.as_str(), "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN");
        return info;
    };
    let Some(node) = parsed.protobuf.stmts.first().and_then(|s| s.stmt.as_ref()).and_then(|n| n.node.as_ref()) else {
        return info;
    };

    match node {
        N::SelectStmt(_) => info.returns_rows = true,
        N::ExplainStmt(_) => info.returns_rows = true,
        N::VariableShowStmt(_) => info.returns_rows = true,
        N::InsertStmt(s) => {
            info.returns_rows = !s.returning_list.is_empty();
        }
        N::UpdateStmt(s) => {
            info.returns_rows = !s.returning_list.is_empty();
            if s.where_clause.is_none() {
                info.destructive = Some(("update".into(), rangevar_name(s.relation.as_ref())));
            }
        }
        N::DeleteStmt(s) => {
            info.returns_rows = !s.returning_list.is_empty();
            if s.where_clause.is_none() {
                info.destructive = Some(("delete".into(), rangevar_name(s.relation.as_ref())));
            }
        }
        N::TruncateStmt(s) => {
            let table = s
                .relations
                .first()
                .and_then(|n| n.node.as_ref())
                .map(|n| if let N::RangeVar(rv) = n { rv.relname.clone() } else { String::new() })
                .unwrap_or_default();
            info.destructive = Some(("truncate".into(), table));
        }
        N::TransactionStmt(s) => {
            // Tip-güvenli enum (ham i32 değil): prost `kind()` yardımcısı.
            use pg_query::protobuf::TransactionStmtKind as TK;
            info.tx_transition = match s.kind() {
                TK::TransStmtBegin | TK::TransStmtStart => Some(TxStatus::InTransaction),
                TK::TransStmtCommit | TK::TransStmtRollback => Some(TxStatus::Idle),
                _ => None,
            };
        }
        _ => {}
    }
    info
}

fn rangevar_name(rv: Option<&pg_query::protobuf::RangeVar>) -> String {
    rv.map(|r| r.relname.clone()).unwrap_or_default()
}

fn first_keyword(sql: &str) -> String {
    sql.trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Saf classify testleri (destructive guard + tx, design 05 §7-8) ----

    #[test]
    fn destructive_whereless() {
        assert_eq!(classify("DELETE FROM orders").destructive, Some(("delete".into(), "orders".into())));
        assert_eq!(classify("UPDATE orders SET total = 0").destructive, Some(("update".into(), "orders".into())));
        assert_eq!(classify("TRUNCATE orders").destructive.map(|d| d.0), Some("truncate".to_string()));
    }

    #[test]
    fn safe_with_where_not_flagged() {
        assert!(classify("DELETE FROM orders WHERE id = 1").destructive.is_none());
        assert!(classify("UPDATE orders SET total = 0 WHERE id = 1").destructive.is_none());
        // CTE'li ama WHERE'li DELETE false-positive vermemeli.
        assert!(classify("WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN (SELECT * FROM x)").destructive.is_none());
    }

    #[test]
    fn tx_transitions() {
        assert_eq!(classify("BEGIN").tx_transition, Some(TxStatus::InTransaction));
        assert_eq!(classify("START TRANSACTION").tx_transition, Some(TxStatus::InTransaction));
        assert_eq!(classify("COMMIT").tx_transition, Some(TxStatus::Idle));
        assert_eq!(classify("ROLLBACK").tx_transition, Some(TxStatus::Idle));
    }

    #[test]
    fn returns_rows_detection() {
        assert!(classify("SELECT 1").returns_rows);
        assert!(classify("WITH x AS (SELECT 1) SELECT * FROM x").returns_rows);
        assert!(classify("INSERT INTO t VALUES (1) RETURNING id").returns_rows);
        assert!(!classify("INSERT INTO t VALUES (1)").returns_rows);
        assert!(!classify("UPDATE t SET x=1 WHERE id=1").returns_rows);
    }

    // ---- Canlı DB entegrasyonu: cursor + pagination + tx + cancel ----
    // TEMP tablo kullanır (session-local, otomatik düşer) — kullanıcı verisine DOKUNMAZ.
    // `ARIADNE_DATABASE_URL` + `cargo test -- --ignored`.

    async fn pool() -> PgPool {
        let url = std::env::var("ARIADNE_DATABASE_URL").expect("ARIADNE_DATABASE_URL");
        sqlx::postgres::PgPoolOptions::new().max_connections(5).connect(&url).await.unwrap()
    }

    fn args<'a>(sql: &'a str, tab: &'a str, qid: &'a str) -> RunArgs<'a> {
        RunArgs { sql, tab_id: tab, query_id: qid, confirmed: false, page_size: 500 }
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn cursor_pagination_within_tx() {
        let pool = pool().await;
        let reg = ExecRegistry::default();

        run_query(&reg, &pool, args("BEGIN", "t1", "q0")).await.unwrap();
        run_query(&reg, &pool, args(
            "CREATE TEMP TABLE t_ari(id int) ON COMMIT DROP; INSERT INTO t_ari SELECT g FROM generate_series(1,1200) g",
            "t1", "q1",
        )).await.unwrap();

        let r = run_query(&reg, &pool, args("SELECT * FROM t_ari ORDER BY id", "t1", "q2")).await.unwrap();
        assert_eq!(r.tx_status, TxStatus::InTransaction);
        match &r.statements[0] {
            StatementResult::Rows { first_page, .. } => {
                assert_eq!(first_page.fetched_total, 500);
                assert!(first_page.has_more);
            }
            _ => panic!("Rows bekleniyordu"),
        }

        let p2 = fetch_page(&reg, "q2").await.unwrap();
        assert_eq!(p2.fetched_total, 500);
        assert!(p2.has_more);
        let p3 = fetch_page(&reg, "q2").await.unwrap();
        assert_eq!(p3.fetched_total, 200);
        assert!(!p3.has_more);

        // ROLLBACK → tx kapanır, temp tablo düşer, cursor kapanır.
        let r = run_query(&reg, &pool, args("ROLLBACK", "t1", "q3")).await.unwrap();
        assert_eq!(r.tx_status, TxStatus::Idle);
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

        // Sorgunun başlamasını bekle, sonra iptal et.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        cancel_query(&reg, &pool, "qc").await.unwrap();

        let res = handle.await.unwrap();
        assert!(res.is_err(), "iptal edilen sorgu hata dönmeli");
    }
}
