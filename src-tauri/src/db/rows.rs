//! PgRow → text-format hücreler (design 02 §3 / 05 §4).
//!
//! Değerler Postgres text format'ında string olarak okunur (bigint/numeric
//! hassasiyeti + bytea/timestamp gösterimi için, design 02 §3). 8 KB'ı aşan hücre
//! kesilir ve `truncated_cells` işaretlenir.

use sqlx::postgres::PgColumn;
use sqlx::{Column, Row, TypeInfo};

use super::types::ColumnMeta;

pub const MAX_CELL_BYTES: usize = 8 * 1024;

/// PgColumn dilimini IPC ColumnMeta'ya çevirir. Hem satır-metadata'sından
/// (`PgRow::columns()`) hem de describe sonucundan (`Describe::columns()`) çağrılır.
pub fn columns_from(cols: &[PgColumn]) -> Vec<ColumnMeta> {
    cols.iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
            type_oid: c.type_info().oid().map(|o| o.0).unwrap_or(0),
        })
        .collect()
}

pub fn read_rows(
    rows: &[sqlx::postgres::PgRow],
) -> (Vec<ColumnMeta>, Vec<Vec<Option<String>>>, bool) {
    // 0 satırlık sonuçta sütun adları buradan alınamaz (rows.first() None); çağıran
    // taraf boş columns görürse describe ile doldurur (bkz. exec::describe_columns).
    let columns: Vec<ColumnMeta> = match rows.first() {
        Some(r) => columns_from(r.columns()),
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
