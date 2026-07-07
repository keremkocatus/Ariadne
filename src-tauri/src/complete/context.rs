//! CompletionContext inference.
//!
//! Works on top of the real Postgres lexer (`pg_query::scan`) — no regex/heuristic
//! lexer. The token stream is robust even when half-written SQL can't be parsed, so
//! the context is derived from the token stream.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Clause {
    SelectList,
    From,
    JoinTarget,
    JoinOn,
    Where,
    GroupBy,
    OrderBy,
    Having,
    Returning,
    InsertCols,
    UpdateSet,
    /// Right after `UPDATE` / `INSERT INTO`: the target-table position — suggest
    /// relations only, not keywords.
    TableTarget,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtKind {
    Select,
    Insert,
    Update,
    Delete,
    Other,
}

/// A relation visible in FROM/JOIN (table, alias, or CTE).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelRef {
    pub alias: Option<String>,
    pub schema: Option<String>,
    pub name: String,
    pub is_cte: bool,
    /// If a CTE, the output columns derivable from its body (best-effort).
    pub cte_columns: Vec<String>,
}

impl RelRef {
    /// Does the qualifier refer to this relation? (alias first, then table name)
    pub fn matches(&self, q: &str) -> bool {
        let q = q.to_lowercase();
        self.alias
            .as_deref()
            .map(|a| a.to_lowercase() == q)
            .unwrap_or(false)
            || self.name.to_lowercase() == q
    }
}

#[derive(Debug, Clone)]
pub struct CompletionContext {
    pub clause: Clause,
    pub relations: Vec<RelRef>,
    pub prefix: String,
    pub qualifier: Option<String>,
    /// Determined during analysis; candidate generation already keys off `clause`,
    /// this field is for future DML-specific suggestions.
    #[allow(dead_code)]
    pub stmt_kind: StmtKind,
    /// Cursor inside a string/comment → no suggestions.
    pub suppress: bool,
}

// The token model and lexer helpers (Tok, tokenize, statement_bounds, match_paren,
// split_items) live in [`super::lexer`]; only semantic analysis lives here.
use super::lexer::{match_paren, split_items, statement_bounds, tokenize_resilient, Tok, TokKind};

/// Main entry: SQL + cursor offset → CompletionContext.
pub fn analyze(sql: &str, offset: usize) -> CompletionContext {
    let offset = offset.min(sql.len());
    let all = tokenize_resilient(sql, offset);

    // Is the cursor inside a string/comment?
    for t in &all {
        if matches!(t.kind, TokKind::String | TokKind::Comment)
            && t.start < offset
            && offset < t.end
        {
            return CompletionContext {
                clause: Clause::Unknown,
                relations: Vec::new(),
                prefix: String::new(),
                qualifier: None,
                stmt_kind: StmtKind::Other,
                suppress: true,
            };
        }
    }

    let (lo, hi) = statement_bounds(&all, offset);
    let toks = &all[lo..hi];

    let (prefix, qualifier) = extract_prefix_qualifier(sql, toks, offset);
    let stmt_kind = detect_stmt_kind(toks);
    let clause = detect_clause(toks, offset, stmt_kind);
    let relations = extract_relations(sql, toks);

    CompletionContext {
        clause,
        relations,
        prefix,
        qualifier,
        stmt_kind,
        suppress: false,
    }
}

/// Returns the full identifier under the cursor (for Alt+F1): (qualifier, name).
pub fn identifier_at(sql: &str, offset: usize) -> Option<(Option<String>, String)> {
    let offset = offset.min(sql.len());
    let all = tokenize_resilient(sql, offset);
    let (lo, hi) = statement_bounds(&all, offset);
    let toks = &all[lo..hi];
    let i = toks
        .iter()
        .position(|t| t.start < offset && offset <= t.end)?;
    if !matches!(toks[i].kind, TokKind::Ident) {
        return None;
    }
    let name = toks[i].text.trim_matches('"').to_string();
    Some((dot_qualifier(toks, i), name))
}

/// If the cursor is inside a function call `f( ... | ...)`, returns (function name,
/// active parameter index) — for signature help.
pub fn call_context(sql: &str, offset: usize) -> Option<(String, u32)> {
    let offset = offset.min(sql.len());
    let all = tokenize_resilient(sql, offset);
    let (lo, hi) = statement_bounds(&all, offset);
    let toks = &all[lo..hi];

    // A stack of (function name, comma count at that level).
    let mut stack: Vec<(Option<String>, u32)> = Vec::new();
    let mut prev_ident: Option<String> = None;

    for t in toks {
        if t.start >= offset {
            break;
        }
        match t.kind {
            TokKind::LParen => {
                stack.push((prev_ident.take(), 0));
            }
            TokKind::RParen => {
                stack.pop();
            }
            TokKind::Comma => {
                if let Some(top) = stack.last_mut() {
                    top.1 += 1;
                }
            }
            TokKind::Ident => prev_ident = Some(t.text.trim_matches('"').to_string()),
            _ => prev_ident = None,
        }
    }

    let (Some(name), active) = stack.pop()? else {
        return None;
    };
    Some((name, active))
}

fn extract_prefix_qualifier(sql: &str, toks: &[Tok], offset: usize) -> (String, Option<String>) {
    // The token the cursor ends in / is inside.
    let cur = toks
        .iter()
        .position(|t| t.start < offset && offset <= t.end);

    if let Some(i) = cur {
        let t = &toks[i];
        match t.kind {
            TokKind::Ident | TokKind::Keyword => {
                let prefix = sql[t.start..offset].trim_start_matches('"').to_string();
                let qualifier = dot_qualifier(toks, i);
                (prefix, qualifier)
            }
            TokKind::Dot => {
                // "u." → cursor right after the dot
                let q = if i >= 1 && toks[i - 1].kind == TokKind::Ident {
                    Some(toks[i - 1].text.trim_matches('"').to_string())
                } else {
                    None
                };
                (String::new(), q)
            }
            _ => (String::new(), None),
        }
    } else {
        // Cursor on whitespace: if the previous token is a dot, carry its qualifier.
        let prev = toks.iter().rposition(|t| t.end <= offset);
        if let Some(i) = prev {
            if toks[i].kind == TokKind::Dot && i >= 1 && toks[i - 1].kind == TokKind::Ident {
                return (
                    String::new(),
                    Some(toks[i - 1].text.trim_matches('"').to_string()),
                );
            }
        }
        (String::new(), None)
    }
}

/// Returns the qualifier in the `ident . <cur>` pattern.
fn dot_qualifier(toks: &[Tok], cur: usize) -> Option<String> {
    if cur >= 2 && toks[cur - 1].kind == TokKind::Dot && toks[cur - 2].kind == TokKind::Ident {
        Some(toks[cur - 2].text.trim_matches('"').to_string())
    } else {
        None
    }
}

fn detect_stmt_kind(toks: &[Tok]) -> StmtKind {
    // With a WITH … prefix, find the main verb.
    for t in toks {
        if !t.is_keyword {
            continue;
        }
        match t.upper.as_str() {
            "SELECT" => return StmtKind::Select,
            "INSERT" => return StmtKind::Insert,
            "UPDATE" => return StmtKind::Update,
            "DELETE" => return StmtKind::Delete,
            "WITH" => continue,
            _ => {}
        }
    }
    StmtKind::Other
}

/// Walks the token stream up to the cursor, running the clause state machine.
fn detect_clause(toks: &[Tok], offset: usize, stmt_kind: StmtKind) -> Clause {
    let mut clause = match stmt_kind {
        StmtKind::Select | StmtKind::Insert | StmtKind::Update | StmtKind::Delete => {
            Clause::Unknown
        }
        StmtKind::Other => Clause::Unknown,
    };
    let mut insert_seen_paren = false;
    let mut prev_upper = String::new();

    for t in toks {
        if t.start >= offset {
            break;
        }
        if matches!(t.kind, TokKind::Comment) {
            continue;
        }
        if t.is_keyword {
            match t.upper.as_str() {
                "SELECT" => clause = Clause::SelectList,
                "FROM" => clause = Clause::From,
                "WHERE" => clause = Clause::Where,
                "JOIN" => clause = Clause::JoinTarget,
                "ON" => clause = Clause::JoinOn,
                "USING" => clause = Clause::JoinOn,
                "HAVING" => clause = Clause::Having,
                "RETURNING" => clause = Clause::Returning,
                "UPDATE" if stmt_kind == StmtKind::Update => clause = Clause::TableTarget,
                "INTO" if stmt_kind == StmtKind::Insert => clause = Clause::TableTarget,
                "SET" if stmt_kind == StmtKind::Update => clause = Clause::UpdateSet,
                "VALUES" => clause = Clause::Unknown,
                "GROUP" => clause = Clause::GroupBy,
                "ORDER" => clause = Clause::OrderBy,
                "BY" => {} // GROUP BY / ORDER BY: the clause is already set
                _ => {}
            }
        } else if t.kind == TokKind::LParen
            && stmt_kind == StmtKind::Insert
            && !insert_seen_paren
            && matches!(clause, Clause::Unknown | Clause::TableTarget)
        {
            // INSERT INTO t ( → column list
            insert_seen_paren = true;
            clause = Clause::InsertCols;
        }
        if !matches!(t.kind, TokKind::Comment) {
            prev_upper = t.upper.clone();
        }
    }
    let _ = prev_upper;
    clause
}

/// Collects relations from FROM/JOINs and CTEs from WITH (whole-statement scope — so
/// outer aliases stay visible for correlated subqueries).
fn extract_relations(sql: &str, toks: &[Tok]) -> Vec<RelRef> {
    let mut rels: Vec<RelRef> = Vec::new();
    let mut ctes: Vec<RelRef> = Vec::new();

    // ---- CTEs: WITH name [AS] ( body ) [, ...] ----
    if let Some(with_i) = toks.iter().position(|t| t.is_keyword && t.upper == "WITH") {
        let mut i = with_i + 1;
        loop {
            // CTE name
            if i >= toks.len() || toks[i].kind != TokKind::Ident {
                break;
            }
            let name = toks[i].text.trim_matches('"').to_string();
            i += 1;
            // optional AS
            if i < toks.len() && toks[i].is_keyword && toks[i].upper == "AS" {
                i += 1;
            }
            // body parenthesis
            if i >= toks.len() || toks[i].kind != TokKind::LParen {
                break;
            }
            let (body_start, body_end, after) = match_paren(toks, i);
            let cte_columns = extract_select_output_columns(sql, &toks[body_start..body_end]);
            ctes.push(RelRef {
                alias: None,
                schema: None,
                name,
                is_cte: true,
                cte_columns,
            });
            i = after;
            // continue with a comma?
            if i < toks.len() && toks[i].kind == TokKind::Comma {
                i += 1;
                continue;
            }
            break;
        }
    }

    // ---- FROM / JOIN / INSERT INTO / UPDATE target relations ----
    // (INTO and UPDATE pull the INSERT/UPDATE target table; DELETE FROM is caught via FROM.)
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        if t.is_keyword && matches!(t.upper.as_str(), "FROM" | "JOIN" | "INTO" | "UPDATE") {
            i += 1;
            // After FROM there may be several comma-separated relations.
            loop {
                let (rel, next) = parse_table_ref(toks, i, &ctes);
                if let Some(r) = rel {
                    rels.push(r);
                }
                i = next;
                if i < toks.len() && toks[i].kind == TokKind::Comma {
                    i += 1;
                    continue;
                }
                break;
            }
        } else {
            i += 1;
        }
    }

    // CTEs are also visible (matching is done in parse_table_ref when a CTE name is
    // used in FROM, so its columns can be suggested; no need to add them again here).
    rels
}

/// `[schema .] name [[AS] alias]` or `( subquery ) [alias]`.
fn parse_table_ref(toks: &[Tok], start: usize, ctes: &[RelRef]) -> (Option<RelRef>, usize) {
    let mut i = start;
    if i >= toks.len() {
        return (None, i);
    }

    // Subquery
    if toks[i].kind == TokKind::LParen {
        let (_, _, after) = match_paren(toks, i);
        i = after;
        let alias = read_alias(toks, &mut i);
        return (
            Some(RelRef {
                alias,
                schema: None,
                name: String::new(),
                is_cte: false,
                cte_columns: Vec::new(),
            }),
            i,
        );
    }

    if toks[i].kind != TokKind::Ident {
        return (None, i);
    }
    let first = toks[i].text.trim_matches('"').to_string();
    i += 1;

    // schema.name?
    let (schema, name) =
        if i + 1 < toks.len() && toks[i].kind == TokKind::Dot && toks[i + 1].kind == TokKind::Ident
        {
            let n = toks[i + 1].text.trim_matches('"').to_string();
            i += 2;
            (Some(first), n)
        } else {
            (None, first)
        };

    let alias = read_alias(toks, &mut i);

    // CTE match: if there's no schema and the name is a CTE, carry its columns.
    let (is_cte, cte_columns) = if schema.is_none() {
        match ctes.iter().find(|c| c.name.eq_ignore_ascii_case(&name)) {
            Some(c) => (true, c.cte_columns.clone()),
            None => (false, Vec::new()),
        }
    } else {
        (false, Vec::new())
    };

    (
        Some(RelRef {
            alias,
            schema,
            name,
            is_cte,
            cte_columns,
        }),
        i,
    )
}

/// Reads `[AS] alias` (if present) and advances i. If there's no alias, i is unchanged.
fn read_alias(toks: &[Tok], i: &mut usize) -> Option<String> {
    let mut j = *i;
    if j < toks.len() && toks[j].is_keyword && toks[j].upper == "AS" {
        j += 1;
    }
    // The alias must be an identifier (keywords are classified as TokKind::Keyword).
    if j < toks.len() && toks[j].kind == TokKind::Ident {
        let a = toks[j].text.trim_matches('"').to_string();
        *i = j + 1;
        return Some(a);
    }
    None
}

/// Best-effort extraction of a SELECT body's output column names (for a CTE). Splits
/// the target list on top-level commas; each item's output name is the trailing alias
/// (`expr [AS] name`), or the column name if it's a single column reference.
fn extract_select_output_columns(_sql: &str, body: &[Tok]) -> Vec<String> {
    // Take the range between SELECT ... FROM.
    let sel = body
        .iter()
        .position(|t| t.is_keyword && t.upper == "SELECT");
    let Some(sel) = sel else {
        return Vec::new();
    };
    let from = body[sel + 1..]
        .iter()
        .position(|t| t.is_keyword && t.upper == "FROM")
        .map(|p| sel + 1 + p)
        .unwrap_or(body.len());
    let list = &body[sel + 1..from];

    let mut cols = Vec::new();
    for item in split_items(list) {
        if let Some(name) = output_name(item) {
            cols.push(name);
        }
    }
    cols
}

fn output_name(item: &[Tok]) -> Option<String> {
    let item: Vec<&Tok> = item
        .iter()
        .filter(|t| !matches!(t.kind, TokKind::Comment))
        .collect();
    if item.is_empty() {
        return None;
    }
    // `... AS name`
    if item.len() >= 2 && item[item.len() - 2].is_keyword && item[item.len() - 2].upper == "AS" {
        return Some(item[item.len() - 1].text.trim_matches('"').to_string());
    }
    // `expr name` (last two tokens are idents) → alias
    let last = item[item.len() - 1];
    if last.kind == TokKind::Ident {
        if item.len() == 1 {
            // single column reference: output name = itself (b if a.b)
            return Some(last.text.trim_matches('"').to_string());
        }
        let prev = item[item.len() - 2];
        if prev.kind == TokKind::Dot {
            // a.b → output name b
            return Some(last.text.trim_matches('"').to_string());
        }
        // `1 a`, `expr a` → alias a
        return Some(last.text.trim_matches('"').to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "SELECT | FROM users" → | is the cursor. Test helper: turns '|' into the offset.
    fn ctx(s: &str) -> CompletionContext {
        let offset = s.find('|').expect("'|' required");
        let sql = s.replacen('|', "", 1);
        analyze(&sql, offset)
    }

    #[test]
    fn select_list_clause() {
        let c = ctx("SELECT | FROM users");
        assert_eq!(c.clause, Clause::SelectList);
        assert_eq!(c.stmt_kind, StmtKind::Select);
    }

    #[test]
    fn from_clause() {
        let c = ctx("SELECT * FROM |");
        assert_eq!(c.clause, Clause::From);
    }

    #[test]
    fn qualifier_alias() {
        let c = ctx("SELECT u.| FROM users u");
        assert_eq!(c.qualifier.as_deref(), Some("u"));
        assert_eq!(c.clause, Clause::SelectList);
        // relations: users u
        assert!(c
            .relations
            .iter()
            .any(|r| r.name == "users" && r.alias.as_deref() == Some("u")));
    }

    #[test]
    fn where_clause() {
        let c = ctx("SELECT * FROM users WHERE |");
        assert_eq!(c.clause, Clause::Where);
    }

    #[test]
    fn join_target() {
        let c = ctx("SELECT * FROM users u JOIN |");
        assert_eq!(c.clause, Clause::JoinTarget);
        assert!(c.relations.iter().any(|r| r.name == "users"));
    }

    #[test]
    fn join_on() {
        let c = ctx("SELECT * FROM users u JOIN orders o ON |");
        assert_eq!(c.clause, Clause::JoinOn);
        assert_eq!(c.relations.len(), 2);
    }

    #[test]
    fn insert_cols() {
        let c = ctx("INSERT INTO users (|");
        assert_eq!(c.stmt_kind, StmtKind::Insert);
        assert_eq!(c.clause, Clause::InsertCols);
    }

    #[test]
    fn string_suppressed() {
        let c = ctx("SELECT '| ' FROM users");
        assert!(c.suppress);
    }

    #[test]
    fn prefix_extracted() {
        let c = ctx("SELECT ema| FROM users");
        assert_eq!(c.prefix, "ema");
        assert_eq!(c.clause, Clause::SelectList);
    }

    #[test]
    fn cte_columns() {
        let c = ctx("WITH x AS (SELECT 1 a) SELECT | FROM x");
        let x = c.relations.iter().find(|r| r.name == "x").expect("x cte");
        assert!(x.is_cte);
        assert_eq!(x.cte_columns, vec!["a".to_string()]);
    }

    #[test]
    fn correlated_scope_sees_outer() {
        // The outer alias u must be visible in the inner subquery.
        let c = ctx("SELECT (SELECT | FROM orders o) FROM users u");
        assert!(c.relations.iter().any(|r| r.alias.as_deref() == Some("u")));
        assert!(c.relations.iter().any(|r| r.alias.as_deref() == Some("o")));
    }

    #[test]
    fn multi_statement_isolation() {
        // Cursor in the second statement; the first statement's FROM must not leak.
        let c = ctx("SELECT 1; SELECT * FROM orders WHERE |");
        assert_eq!(c.clause, Clause::Where);
        assert!(c.relations.iter().any(|r| r.name == "orders"));
        assert!(!c.relations.iter().any(|r| r.name == "users"));
    }

    #[test]
    fn update_set_clause() {
        let c = ctx("UPDATE users SET |");
        assert_eq!(c.stmt_kind, StmtKind::Update);
        assert_eq!(c.clause, Clause::UpdateSet);
        assert!(c.relations.iter().any(|r| r.name == "users"));
    }

    #[test]
    fn update_set_multiline() {
        let c = ctx("UPDATE users\nSET name = 'x',\n    |");
        assert_eq!(c.clause, Clause::UpdateSet);
        assert!(c.relations.iter().any(|r| r.name == "users"));
    }

    #[test]
    fn update_where_clause() {
        let c = ctx("UPDATE users SET name = 'x' WHERE |");
        assert_eq!(c.clause, Clause::Where);
        assert!(c.relations.iter().any(|r| r.name == "users"));
    }

    #[test]
    fn delete_where_clause() {
        let c = ctx("DELETE FROM users WHERE |");
        assert_eq!(c.stmt_kind, StmtKind::Delete);
        assert_eq!(c.clause, Clause::Where);
        assert!(c.relations.iter().any(|r| r.name == "users"));
    }

    #[test]
    fn update_target_clause() {
        let c = ctx("UPDATE |");
        assert_eq!(c.clause, Clause::TableTarget);
    }

    #[test]
    fn insert_into_target_clause() {
        let c = ctx("INSERT INTO |");
        assert_eq!(c.clause, Clause::TableTarget);
    }

    #[test]
    fn unterminated_string_suppresses() {
        // pg_query::scan fails on the whole text; the resilient lexer terminates the
        // literal, so the cursor lands inside a string token → suppress.
        let c = ctx("UPDATE users SET name = 'x|");
        assert!(c.suppress);
    }

    #[test]
    fn unterminated_string_recovers_relations() {
        // The broken literal is AFTER the cursor (another statement): truncating the
        // scan at the cursor must recover the current statement's context.
        let c = ctx("UPDATE users SET a = 'x' WHERE | ; SELECT 'oops");
        assert_eq!(c.clause, Clause::Where);
        assert!(c.relations.iter().any(|r| r.name == "users"));
    }
}
