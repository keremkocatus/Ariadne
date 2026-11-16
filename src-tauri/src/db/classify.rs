//! Statement classification (via the pg_query AST): does it return rows, is it
//! destructive, does it transition transaction state. Pure functions — no DB
//! access, testable without a UI.

use super::types::{SourceTable, TxStatus};

pub struct StmtInfo {
    /// Display tag ("CREATE FUNCTION", "SELECT", …). See `command_tag`.
    pub command: String,
    pub is_dml: bool,
    pub returns_rows: bool,
    /// Whether the statement can be wrapped in `DECLARE … CURSOR FOR`. Only a plain
    /// query can: EXPLAIN, SHOW and DML … RETURNING return rows but are not valid
    /// cursor queries.
    pub cursorable: bool,
    pub destructive: Option<(String, String)>, // (kind, table)
    pub tx_transition: Option<TxStatus>,
    /// For a plain single-table SELECT: the table it reads. See `derive_source_table`.
    pub source_table: Option<SourceTable>,
}

pub fn classify(sql: &str) -> StmtInfo {
    use pg_query::protobuf::node::Node as N;

    let command = first_keyword(sql);
    let mut info = StmtInfo {
        command: command_tag(sql),
        is_dml: matches!(command.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE"),
        returns_rows: false,
        cursorable: false,
        destructive: None,
        tx_transition: None,
        source_table: None,
    };

    let Ok(parsed) = pg_query::parse(sql) else {
        // Unparseable: fall back to a rough guess from the first keyword.
        info.returns_rows = matches!(
            command.as_str(),
            "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN"
        );
        info.cursorable = matches!(command.as_str(), "SELECT" | "VALUES" | "TABLE");
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
        // SELECT … INTO creates a table and returns nothing.
        N::SelectStmt(s) if s.into_clause.is_some() => {}
        N::SelectStmt(s) => {
            info.returns_rows = true;
            info.cursorable = true;
            info.source_table = derive_source_table(s);
        }
        N::ExplainStmt(_) => info.returns_rows = true,
        N::VariableShowStmt(_) => info.returns_rows = true,
        // DML is flagged from the AST as well: a leading CTE (`WITH … INSERT`) hides
        // the verb from the first-keyword check.
        N::InsertStmt(s) => {
            info.is_dml = true;
            info.returns_rows = !s.returning_list.is_empty();
        }
        N::UpdateStmt(s) => {
            info.is_dml = true;
            info.returns_rows = !s.returning_list.is_empty();
            if s.where_clause.is_none() {
                info.destructive = Some(("update".into(), rangevar_name(s.relation.as_ref())));
            }
        }
        N::DeleteStmt(s) => {
            info.is_dml = true;
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
            // Type-safe enum (not the raw i32): prost's `kind()` helper.
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

/// `Some` only when the SELECT reads exactly one physical table and every grid row
/// maps 1:1 to a physical row: a single RangeVar FROM item, no set-ops, no CTEs, no
/// GROUP BY/DISTINCT/HAVING/window, no SELECT INTO. WHERE/ORDER BY/LIMIT/locking and
/// aliases don't affect row identity and are allowed — that's the point: cell editing
/// keeps working on filtered views of a table.
fn derive_source_table(s: &pg_query::protobuf::SelectStmt) -> Option<SourceTable> {
    use pg_query::protobuf::node::Node as N;
    use pg_query::protobuf::SetOperation;

    if s.op() != SetOperation::SetopNone || s.larg.is_some() || s.rarg.is_some() {
        return None;
    }
    if s.with_clause.is_some()
        || !s.distinct_clause.is_empty()
        || !s.group_clause.is_empty()
        || s.having_clause.is_some()
        || !s.window_clause.is_empty()
        || !s.values_lists.is_empty()
        || s.into_clause.is_some()
    {
        return None;
    }
    if s.from_clause.len() != 1 {
        return None;
    }
    // A JoinExpr / subquery / function FROM item fails this match — only a bare table.
    let N::RangeVar(rv) = s.from_clause[0].node.as_ref()? else {
        return None;
    };
    Some(SourceTable {
        schema: (!rv.schemaname.is_empty()).then(|| rv.schemaname.clone()),
        name: rv.relname.clone(),
    })
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

/// The first significant word of the SQL, upper-cased ("SELECT", "INSERT", …).
/// Shared by `touches_schema` and `classify`.
pub(crate) fn first_keyword(sql: &str) -> String {
    keywords(sql).next().unwrap_or_default()
}

/// Skips leading whitespace and SQL comments. The statement splitter keeps a comment
/// that precedes a statement attached to it, so the first "word" would otherwise be
/// `--`.
pub(crate) fn strip_leading_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest
                .split_once('\n')
                .map_or("", |(_, tail)| tail)
                .trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest
                .split_once("*/")
                .map_or("", |(_, tail)| tail)
                .trim_start();
        } else {
            return s;
        }
    }
}

fn keywords(sql: &str) -> impl Iterator<Item = String> + '_ {
    strip_leading_comments(sql)
        .split(|c: char| c.is_whitespace() || c == '(' || c == ';')
        .filter(|w| !w.is_empty())
        .map(str::to_uppercase)
}

/// A psql-like command tag for the Messages list. DDL gets its object kind
/// ("CREATE FUNCTION", "DROP MATERIALIZED VIEW"); everything else is its verb.
pub(crate) fn command_tag(sql: &str) -> String {
    const MODIFIERS: &[&str] = &[
        "OR",
        "REPLACE",
        "UNIQUE",
        "TEMP",
        "TEMPORARY",
        "UNLOGGED",
        "GLOBAL",
        "LOCAL",
        "RECURSIVE",
        "CONSTRAINT",
        "TRUSTED",
        "PROCEDURAL",
        "DEFAULT",
    ];
    let mut words = keywords(sql);
    let Some(verb) = words.next() else {
        return String::new();
    };
    match verb.as_str() {
        "CREATE" | "ALTER" | "DROP" => {
            let mut rest = words.filter(|w| !MODIFIERS.contains(&w.as_str()));
            match rest.next() {
                Some(obj) if matches!(obj.as_str(), "MATERIALIZED" | "FOREIGN" | "EVENT") => {
                    match rest.next() {
                        Some(next) => format!("{verb} {obj} {next}"),
                        None => format!("{verb} {obj}"),
                    }
                }
                Some(obj) => format!("{verb} {obj}"),
                None => verb,
            }
        }
        "START" => "START TRANSACTION".to_string(),
        "REFRESH" => "REFRESH MATERIALIZED VIEW".to_string(),
        _ => verb,
    }
}

/// A one-line preview of a statement for the Messages list: comments stripped,
/// whitespace collapsed, cut at `max` characters.
pub(crate) fn preview(sql: &str, max: usize) -> String {
    let flat = strip_leading_comments(sql)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let mut cut: String = flat.chars().take(max).collect();
        cut.push('…');
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_comments_do_not_hide_the_command() {
        let sql = "-- migrate\n/* step 1 */\n  BEGIN";
        assert_eq!(first_keyword(sql), "BEGIN");
        assert_eq!(classify(sql).command, "BEGIN");
        assert_eq!(first_keyword("-- only a comment"), "");
    }

    #[test]
    fn command_tags() {
        for (sql, tag) in [
            (
                "create or replace function f() returns int as $$ select 1 $$ language sql",
                "CREATE FUNCTION",
            ),
            ("CREATE UNIQUE INDEX i ON t (a)", "CREATE INDEX"),
            ("CREATE TEMP TABLE t(id int)", "CREATE TABLE"),
            ("DROP MATERIALIZED VIEW mv", "DROP MATERIALIZED VIEW"),
            ("ALTER TABLE t ADD COLUMN x int", "ALTER TABLE"),
            ("SET search_path = public", "SET"),
            ("COMMIT;", "COMMIT"),
            ("START TRANSACTION", "START TRANSACTION"),
            ("SELECT(1)", "SELECT"),
        ] {
            assert_eq!(command_tag(sql), tag, "{sql}");
        }
    }

    #[test]
    fn preview_is_one_short_line() {
        assert_eq!(preview("-- c\nSELECT 1\n  FROM t", 80), "SELECT 1 FROM t");
        assert_eq!(preview("SELECT 12345", 8), "SELECT 1…");
    }

    #[test]
    fn only_plain_queries_are_cursorable() {
        assert!(classify("SELECT 1").cursorable);
        assert!(classify("WITH x AS (SELECT 1) SELECT * FROM x").cursorable);
        assert!(classify("VALUES (1)").cursorable);
        for sql in [
            "EXPLAIN SELECT 1",
            "SHOW search_path",
            "INSERT INTO t VALUES (1) RETURNING id",
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x RETURNING id",
        ] {
            let info = classify(sql);
            assert!(info.returns_rows, "{sql}");
            assert!(!info.cursorable, "{sql}");
        }
        // SELECT … INTO creates a table; it returns no rows at all.
        assert!(!classify("SELECT x INTO t2 FROM a").returns_rows);
        assert!(classify("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x").is_dml);
    }

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
        // A DELETE with a CTE but a WHERE clause must not be a false positive.
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

    fn source(sql: &str) -> Option<(Option<String>, String)> {
        classify(sql).source_table.map(|s| (s.schema, s.name))
    }

    #[test]
    fn source_table_simple_select() {
        assert_eq!(
            source("SELECT * FROM users WHERE id > 1 ORDER BY id LIMIT 10"),
            Some((None, "users".into()))
        );
        assert_eq!(
            source("SELECT id FROM users FOR UPDATE"),
            Some((None, "users".into()))
        );
    }

    #[test]
    fn source_table_qualified_and_alias() {
        assert_eq!(
            source(r#"SELECT u.id FROM "public"."users" u"#),
            Some((Some("public".into()), "users".into()))
        );
    }

    #[test]
    fn source_table_excluded() {
        for sql in [
            "SELECT * FROM a JOIN b ON a.id = b.id",
            "SELECT * FROM a, b",
            "SELECT x, count(*) FROM a GROUP BY x",
            "SELECT DISTINCT x FROM a",
            "SELECT x FROM a UNION SELECT x FROM b",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SELECT * FROM (SELECT 1) sub",
            "SELECT * FROM generate_series(1, 10)",
            "SELECT x INTO t2 FROM a",
            "SELECT 1",
        ] {
            assert_eq!(source(sql), None, "should be excluded: {sql}");
        }
    }

    #[test]
    fn source_table_absent_on_dml() {
        assert_eq!(source("UPDATE users SET x = 1 WHERE id = 1"), None);
        assert_eq!(source("INSERT INTO users VALUES (1) RETURNING id"), None);
    }
}
