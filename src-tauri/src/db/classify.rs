//! Statement sınıflandırma (pg_query AST): row döndürür mü, destructive mı, tx
//! geçişi var mı (design 05 §7-8). Saf fonksiyon — DB'ye gitmez, UI'sız test edilir.

use super::types::TxStatus;

pub struct StmtInfo {
    pub command: String,
    pub is_dml: bool,
    pub returns_rows: bool,
    pub destructive: Option<(String, String)>, // (kind, table)
    pub tx_transition: Option<TxStatus>,
}

pub fn stmt_returns_rows(sql: &str) -> bool {
    classify(sql).returns_rows
}

pub fn classify(sql: &str) -> StmtInfo {
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
        info.returns_rows = matches!(
            command.as_str(),
            "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN"
        );
        return info;
    };
    let Some(node) = parsed
        .protobuf
        .stmts
        .first()
        .and_then(|s| s.stmt.as_ref())
        .and_then(|n| n.node.as_ref())
    else {
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
                .map(|n| {
                    if let N::RangeVar(rv) = n {
                        rv.relname.clone()
                    } else {
                        String::new()
                    }
                })
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
    rv.map(|r| {
        if r.schemaname.is_empty() {
            r.relname.clone()
        } else {
            format!("{}.{}", r.schemaname, r.relname)
        }
    })
    .unwrap_or_default()
}

/// SQL'in ilk anlamlı kelimesini büyük harfle döndürür ("SELECT", "INSERT"...).
/// `touches_schema` ve `classify` ortak kullanır.
pub(crate) fn first_keyword(sql: &str) -> String {
    sql.trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_whereless() {
        assert_eq!(
            classify("DELETE FROM orders").destructive,
            Some(("delete".into(), "orders".into()))
        );
        assert_eq!(
            classify("UPDATE orders SET total = 0").destructive,
            Some(("update".into(), "orders".into()))
        );
        assert_eq!(
            classify("TRUNCATE orders").destructive.map(|d| d.0),
            Some("truncate".to_string())
        );
    }

    #[test]
    fn safe_with_where_not_flagged() {
        assert!(classify("DELETE FROM orders WHERE id = 1")
            .destructive
            .is_none());
        assert!(classify("UPDATE orders SET total = 0 WHERE id = 1")
            .destructive
            .is_none());
        // CTE'li ama WHERE'li DELETE false-positive vermemeli.
        assert!(
            classify("WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN (SELECT * FROM x)")
                .destructive
                .is_none()
        );
    }

    #[test]
    fn tx_transitions() {
        assert_eq!(
            classify("BEGIN").tx_transition,
            Some(TxStatus::InTransaction)
        );
        assert_eq!(
            classify("START TRANSACTION").tx_transition,
            Some(TxStatus::InTransaction)
        );
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
}
