//! PgRow → text-format cells.
//!
//! Values are read as strings in Postgres text format (to preserve bigint/numeric
//! precision and to render bytea/timestamps faithfully). Cells larger than 8 KB are
//! truncated and `truncated_cells` is flagged.

use sqlx::postgres::PgColumn;
use sqlx::{Column, Row, TypeInfo};

use super::types::ColumnMeta;

pub const MAX_CELL_BYTES: usize = 8 * 1024;

/// Converts a slice of PgColumn into IPC ColumnMeta. Called both from row metadata
/// (`PgRow::columns()`) and from a describe result (`Describe::columns()`).
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
    // With zero rows we can't derive column names here (rows.first() is None); the
    // caller fills them in via describe when it sees empty columns (see
    // exec::describe_columns).
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
