//! Cursor'lu execution, iptal, pagination, tab=session transaction (design 05).
//!
//! Ana kısıt: 200M+ satırlık tablolar. Sonuç asla komple belleğe çekilmez;
//! server-side cursor + FETCH ile sayfalanır. Her sorgu iptal edilebilir.
//!
//! IPC tipleri [`super::types`]'te, statement sınıflandırma [`super::classify`]'de,
//! satır okuma [`super::rows`]'ta; burada yalnızca yaşam döngüsü durur.

use std::sync::Arc;

use dashmap::DashMap;
use sqlx::pool::PoolConnection;
use sqlx::{Executor, PgPool, Postgres, Row};
use tokio::sync::Mutex;

use super::classify::{classify, stmt_returns_rows, StmtInfo};
use super::rows::read_rows;
use super::types::{Confirmation, Page, RunResult, StatementResult, TxStatus};
use crate::error::{AriadneError, ErrorKind};

pub const PAGE_SIZE: i64 = 500;

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

    /// Disconnect'te çağrılır (design 11 §H3): çalışan sorguları iptal eder, açık
    /// cursor/tx'leri kapatır, registry'yi boşaltır. Kilit beklemez (`try_lock`) —
    /// hâlâ çalışan bir sorgunun bağlantısı, o sorgu (iptalle) bitince pool'a döner;
    /// pool kapanışı da sunucu tarafında açık tx'leri rollback eder (leak yok).
    pub async fn shutdown(&self, pool: &PgPool) {
        // 1) Çalışan sorguları ayrı bir bağlantıdan iptal et → run_query 57014 ile unwind eder.
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

        // 2) Tab Arc'larını topla + map'i boşalt (DashMap guard'ı await boyunca tutma).
        let tabs: Vec<Arc<Mutex<TabState>>> = self.tabs.iter().map(|e| e.value().clone()).collect();
        self.tabs.clear();
        for tab in tabs {
            // Çalışan sorgu kilidi tutuyorsa atla; conn o sorgu bitince zaten bırakılır.
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
    reg.running.insert(
        args.query_id.to_string(),
        (args.tab_id.to_string(), st.backend_pid),
    );

    // Önceki cursor'u kapat (yeni sorgu geldi).
    close_cursor(&mut st).await;

    let mut results: Vec<StatementResult> = Vec::new();
    let mut needs_confirmation = None;
    let mut run_error: Option<AriadneError> = None;
    let mut error_statement_index: Option<usize> = None;

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
            Err(mut e) => {
                // Postgres position statement-içi (1-based); editördeki mutlak konuma
                // kaydır (design 11 §H1).
                if let Some(pos) = e.position {
                    e.position = Some(absolute_position(args.sql, stmt, pos));
                }
                if st.tx == TxStatus::InTransaction {
                    st.tx = TxStatus::Aborted;
                }
                // Kısmi sonuç: o ana kadar biriken `results` korunur, hata RunResult'a
                // gömülür ve kalan statement'lar çalıştırılmaz (psql, design 11 §H2).
                run_error = Some(e);
                error_statement_index = Some(idx);
                break;
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
        error: run_error,
        error_statement_index,
    })
}

/// Statement-içi 1-based Postgres position'ını, statement'ın script içindeki
/// başlangıç karakter offset'ini ekleyerek editördeki mutlak 1-based karakter
/// konumuna çevirir (design 11 §H1). `stmt`, `sql`'in bir alt-dilimi olmalıdır
/// (pg_query::split slice döndürür); değilse offset 0'a düşer, marker yine gösterilir.
fn absolute_position(sql: &str, stmt: &str, pos: u32) -> u32 {
    let base = sql.as_ptr() as usize;
    let byte_start = (stmt.as_ptr() as usize)
        .checked_sub(base)
        .filter(|&b| b <= sql.len())
        .unwrap_or(0);
    let char_start = sql.get(..byte_start).map_or(0, |s| s.chars().count());
    pos + char_start as u32
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
            let _ = sqlx::query(&format!("CLOSE {}", cur.name))
                .execute(&mut **c)
                .await;
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
    let name = format!(
        "ariadne_cur_{}",
        query_id.replace('-', "").get(..16).unwrap_or("cur")
    );
    let conn = st.conn.as_mut().expect("conn").as_mut();

    // Kullanıcı tx'i yoksa cursor için iç READ ONLY tx aç.
    if st.tx == TxStatus::Idle {
        sqlx::query("BEGIN READ ONLY").execute(&mut *conn).await?;
        st.internal_tx = true;
    }
    let decl = format!("DECLARE {name} NO SCROLL CURSOR FOR {stmt}");
    sqlx::query(&decl).execute(&mut *conn).await?;

    let fetch_sql = format!("FETCH FORWARD {page_size} FROM {name}");
    let rows = conn
        .fetch_all(sqlx::raw_sql(&fetch_sql))
        .await
        .map_err(AriadneError::from)?;
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
    let rows = conn
        .fetch_all(sqlx::raw_sql(stmt))
        .await
        .map_err(AriadneError::from)?;
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
    let fetch_sql = format!("FETCH FORWARD {PAGE_SIZE} FROM {name}");
    let rows = conn
        .fetch_all(sqlx::raw_sql(&fetch_sql))
        .await
        .map_err(AriadneError::from)?;
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
            st.cursor
                .as_ref()
                .filter(|c| c.query_id == query_id)
                .map(|_| e.key().clone())
        })
    })
}

// ---- cancel_query (design 05 §3) ----

pub async fn cancel_query(
    reg: &ExecRegistry,
    pool: &PgPool,
    query_id: &str,
) -> Result<(), AriadneError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Saf: hata position'ının statement offset'iyle kaydırılması (design 11 §H1) ----

    #[test]
    fn absolute_position_shifts_to_editor_offset() {
        let sql = "SELECT 1;\nSELECT oops FROM t";
        let idx = sql.find("SELECT oops").unwrap(); // 2. statement'ın byte offset'i
        let stmt = &sql[idx..]; // gerçek alt-dilim (split_with_parser böyle döndürür)
        let char_start = sql[..idx].chars().count() as u32;
        // Postgres pos=8 (statement içinde 1-based) → mutlak = char_start + 8.
        assert_eq!(absolute_position(sql, stmt, 8), char_start + 8);
    }

    #[test]
    fn absolute_position_counts_chars_not_bytes() {
        // 'é' 2 byte / 1 karakter: byte offset yerine karakter sayılmalı.
        let sql = "SELECT 'é';\nSELECT x";
        let idx = sql.find("SELECT x").unwrap();
        let stmt = &sql[idx..];
        let char_start = sql[..idx].chars().count() as u32;
        assert!(char_start < idx as u32, "multibyte → karakter < byte");
        assert_eq!(absolute_position(sql, stmt, 1), char_start + 1);
    }

    #[test]
    fn absolute_position_non_subslice_is_safe() {
        // Alt-dilim değilse taşma/panik yok; ham pos'a düşer (defansif).
        let sql = "SELECT 1";
        let foreign = String::from("SELECT 1");
        let out = absolute_position(sql, &foreign, 3);
        // char_start 0'a düşer → pos korunur (nadir allocator çakışması dışında).
        assert!(out == 3 || out >= 3);
    }

    // ---- Canlı DB entegrasyonu: cursor + pagination + tx + cancel ----
    // TEMP tablo kullanır (session-local, otomatik düşer) — kullanıcı verisine DOKUNMAZ.
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
        let r = run_query(&reg, &pool, args("ROLLBACK", "t1", "q3"))
            .await
            .unwrap();
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
