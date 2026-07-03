//! Query execution çekirdeği (design 05). Tauri'den habersiz — saf DB katmanı,
//! böylece UI olmadan test edilebilir (design 01 §4).
//!
//! M0 kapsamı: cursor YOK, pagination YOK, transaction takibi YOK. Tek/çoklu
//! statement'ı simple query protocol'üyle çalıştırıp ilk (ve tek) sayfayı döner.
//! Cursor'lu gerçek execution M3'te (design 10) gelir.

use std::time::Instant;

use serde::Serialize;
use sqlx::{Column, Executor, PgPool, Row, TypeInfo};

use crate::error::AriadneError;

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub query_id: String,
    pub statements: Vec<StatementResult>,
    /// M0: her zaman "idle". Tab=session tx modeli M3'te (design 05 §7).
    pub tx_status: &'static str,
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
    /// Hücreler Postgres text format'ında string olarak taşınır (design 02 §3).
    pub rows: Vec<Vec<Option<String>>>,
    pub has_more: bool,
    pub fetched_total: usize,
    pub elapsed_ms: u64,
}

/// Tek `run_query` çağrısı. M0: pg_query ile parse'ı (gün-1 riski doğrulaması,
/// design 10) çalıştırır ama bloklamaz; asıl işi sqlx simple protocol yapar.
pub async fn run_query(sql: &str, pool: &PgPool) -> Result<RunResult, AriadneError> {
    // pg_query'yi derleme+link+çalışma doğrulaması için çağır. M0'da parse
    // hatası bloklamaz (sunucu asıl otoritedir); sadece dev log'una düşer.
    match pg_query::parse(sql) {
        Ok(parsed) => {
            eprintln!("[pg_query] ok, {} statement(s)", parsed.protobuf.stmts.len());
        }
        Err(e) => eprintln!("[pg_query] parse warn: {e}"),
    }

    let started = Instant::now();

    // Simple query protocol → değerler TEXT format'ında döner. Bu sayede
    // aşağıda try_get_unchecked::<Option<String>> her kolon tipini okuyabilir.
    let rows = pool
        .fetch_all(sqlx::raw_sql(sql))
        .await
        .map_err(AriadneError::from)?;

    let elapsed_ms = started.elapsed().as_millis() as u64;

    // Kolon meta'sı ilk satırdan çıkar (0 satırlı SELECT'te kolon bilgisi
    // simple protocol'de satırsız gelmez — M0 için kabul edilebilir sınır).
    let columns: Vec<ColumnMeta> = match rows.first() {
        Some(r) => r
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
                type_oid: 0, // M0: oid doldurulmuyor (grid hizalaması M3)
            })
            .collect(),
        None => Vec::new(),
    };

    let statement = if columns.is_empty() {
        // Kolon yok → SELECT değil (INSERT/UPDATE/DDL/SET...). M0: komut etiketini
        // SQL'in ilk kelimesinden türet; kesin affected-count M3'te.
        StatementResult::Empty {
            command: first_keyword(sql),
        }
    } else {
        let out_rows: Vec<Vec<Option<String>>> = rows
            .iter()
            .map(|r| {
                (0..columns.len())
                    .map(|i| r.try_get_unchecked::<Option<String>, _>(i).unwrap_or(None))
                    .collect()
            })
            .collect();

        let fetched_total = out_rows.len();
        StatementResult::Rows {
            columns,
            first_page: Page {
                rows: out_rows,
                has_more: false, // M0: cursor yok, hepsi tek sayfada
                fetched_total,
                elapsed_ms,
            },
            truncated_cells: false, // M0: hücre kesme yok (design 05 §4 → M3)
        }
    };

    Ok(RunResult {
        query_id: uuid::Uuid::new_v4().to_string(),
        statements: vec![statement],
        tx_status: "idle",
    })
}

/// SQL'in ilk anlamlı kelimesini büyük harfle döndürür ("SELECT", "INSERT"...).
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
    use sqlx::postgres::PgPoolOptions;

    /// M0 kabul kriteri (backend yolu): `SELECT version()` → Rows sonucu.
    /// Canlı Postgres gerektirir; `ARIADNE_DATABASE_URL` set edip
    /// `cargo test -- --ignored` ile çalıştırılır. CI'yi kilitlememesi için `#[ignore]`.
    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn m0_select_version_returns_rows() {
        let url = std::env::var("ARIADNE_DATABASE_URL")
            .expect("set ARIADNE_DATABASE_URL to run this test");
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect");

        let res = run_query("SELECT version()", &pool)
            .await
            .expect("run_query");

        assert_eq!(res.statements.len(), 1, "tek statement bekleniyor");
        match &res.statements[0] {
            StatementResult::Rows {
                columns,
                first_page,
                ..
            } => {
                assert_eq!(columns.len(), 1, "tek kolon (version)");
                assert_eq!(first_page.rows.len(), 1, "tek satır");
                let v = first_page.rows[0][0].as_deref().unwrap_or("");
                assert!(v.contains("PostgreSQL"), "version metni bekleniyordu, gelen: {v}");
            }
            other => panic!("Rows bekleniyordu, gelen: {other:?}"),
        }
    }
}
