//! DB katmanı (design 05). Tauri'den habersiz — saf DB, UI olmadan test edilebilir
//! (design 01 §4). Sorumluluklar dosyalara ayrılmıştır (design 11 §R2):
//!
//! - [`pool`]     — profil → PgPool kurulumu
//! - [`types`]    — IPC sözleşme tipleri (RunResult, Page, TxStatus...)
//! - [`classify`] — statement sınıflandırma (row/destructive/tx)
//! - [`rows`]     — PgRow → text hücreler
//! - [`exec`]     — cursor'lu execution yaşam döngüsü (asıl motor)

pub mod classify;
pub mod exec;
pub mod pool;
pub mod rows;
pub mod types;

pub use pool::build_pool;

use classify::first_keyword;

/// Statement'lardan biri şemayı değiştiriyor mu (DDL) — cache auto-refresh tetiği
/// (design 03 §4.3). pg_query split + ilk kelime; ucuz ve %90 senaryoyu kapar.
pub fn touches_schema(sql: &str) -> bool {
    let stmts = pg_query::split_with_parser(sql).unwrap_or_default();
    stmts.iter().any(|s| {
        matches!(
            first_keyword(s).as_str(),
            "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "COMMENT" | "GRANT" | "REVOKE"
        )
    })
}
