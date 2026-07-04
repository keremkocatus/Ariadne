//! PgRow → text-format hücreler (design 02 §3 / 05 §4).
//!
//! Değerler Postgres text format'ında string olarak okunur (bigint/numeric
//! hassasiyeti + bytea/timestamp gösterimi için, design 02 §3). 8 KB'ı aşan hücre
//! kesilir ve `truncated_cells` işaretlenir.

use sqlx::{Column, Row, TypeInfo};

use super::types::ColumnMeta;

pub const MAX_CELL_BYTES: usize = 8 * 1024;

pub fn read_rows(
    rows: &[sqlx::postgres::PgRow],
) -> (Vec<ColumnMeta>, Vec<Vec<Option<String>>>, bool) {
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
