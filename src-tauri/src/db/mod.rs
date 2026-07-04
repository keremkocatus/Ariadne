//! DB katmanı (design 05). Tauri'den habersiz — saf DB, UI olmadan test edilebilir
//! (design 01 §4). Asıl cursor'lu execution motoru `exec` alt-modülündedir; burada
//! yalnızca ona bağlı olmayan yardımcılar (DDL tespiti gibi) durur.

pub mod exec;

/// Statement'lardan biri şemayı değiştiriyor mu (DDL) — cache auto-refresh tetiği
/// (design 03 §4.3). M1: pg_query split + ilk kelime; ucuz ve %90 senaryoyu kapar.
pub fn touches_schema(sql: &str) -> bool {
    let stmts = pg_query::split_with_parser(sql).unwrap_or_default();
    stmts.iter().any(|s| {
        matches!(
            first_keyword(s).as_str(),
            "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "COMMENT" | "GRANT" | "REVOKE"
        )
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
