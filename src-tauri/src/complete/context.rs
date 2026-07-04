//! CompletionContext çıkarımı (design 04 §2-3).
//!
//! Gerçek Postgres lexer'ı (`pg_query::scan`) üzerinden çalışır — regex/heuristic
//! lexer YOK (design prensip 3). Yarım SQL parse edilemese bile token akışı
//! sağlamdır; bu yüzden context'i token akışından çıkarıyoruz (design 04 §2
//! Kademe 3'ün ruhu — ama tüm kademeler aynı CompletionContext'e düşer).

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

/// FROM/JOIN'de görünen bir ilişki (tablo, alias veya CTE).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelRef {
    pub alias: Option<String>,
    pub schema: Option<String>,
    pub name: String,
    pub is_cte: bool,
    /// CTE ise gövdesinden çıkarılabilen çıktı kolonları (best-effort).
    pub cte_columns: Vec<String>,
}

impl RelRef {
    /// qualifier bu ilişkiye mi işaret ediyor? (alias önce, sonra tablo adı)
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
    /// Analiz sırasında belirlenir; clause bazlı aday üretimi zaten `clause`'u
    /// kullanır, bu alan Phase 1'de DML-özel önerileri için okunacak.
    #[allow(dead_code)]
    pub stmt_kind: StmtKind,
    /// İmleç string/comment içinde → öneri verilmez (design 04 §7).
    pub suppress: bool,
}

// Token modeli ve lexer yardımcıları (Tok, tokenize, statement_bounds, match_paren,
// split_items) [`super::lexer`]'de; burada yalnızca semantik analiz yaşar (design 11 §R3).
use super::lexer::{match_paren, split_items, statement_bounds, tokenize, Tok, TokKind};

/// Ana giriş: SQL + imleç ofseti → CompletionContext.
pub fn analyze(sql: &str, offset: usize) -> CompletionContext {
    let offset = offset.min(sql.len());
    let all = tokenize(sql);

    // İmleç string/comment içinde mi?
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

/// İmlecin üstündeki tam identifier'ı (Alt+F1 için) döndürür: (qualifier, name).
pub fn identifier_at(sql: &str, offset: usize) -> Option<(Option<String>, String)> {
    let offset = offset.min(sql.len());
    let all = tokenize(sql);
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

/// İmleç bir fonksiyon çağrısı `f( ... | ...)` içindeyse (fonksiyon adı, aktif
/// parametre indeksi) döndürür — signature help için (design 04 §6).
pub fn call_context(sql: &str, offset: usize) -> Option<(String, u32)> {
    let offset = offset.min(sql.len());
    let all = tokenize(sql);
    let (lo, hi) = statement_bounds(&all, offset);
    let toks = &all[lo..hi];

    // (fonksiyon_adı, o seviyedeki virgül sayısı) yığını.
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
    // İmlecin bittiği/içinde olduğu token.
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
                // "u." → imleç noktadan hemen sonra
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
        // İmleç boşlukta: bir önceki token nokta ise qualifier'ı taşı.
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

/// `ident . <cur>` deseninde qualifier'ı döndürür.
fn dot_qualifier(toks: &[Tok], cur: usize) -> Option<String> {
    if cur >= 2 && toks[cur - 1].kind == TokKind::Dot && toks[cur - 2].kind == TokKind::Ident {
        Some(toks[cur - 2].text.trim_matches('"').to_string())
    } else {
        None
    }
}

fn detect_stmt_kind(toks: &[Tok]) -> StmtKind {
    // WITH ... öneki varsa ana fiili bul.
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

/// İmlece kadar token akışını gezerek clause state machine'i yürütür.
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
                "SET" if stmt_kind == StmtKind::Update => clause = Clause::UpdateSet,
                "VALUES" => clause = Clause::Unknown,
                "GROUP" => clause = Clause::GroupBy,
                "ORDER" => clause = Clause::OrderBy,
                "BY" => {} // GROUP BY / ORDER BY: clause zaten set edildi
                _ => {}
            }
        } else if t.kind == TokKind::LParen
            && stmt_kind == StmtKind::Insert
            && !insert_seen_paren
            && clause == Clause::Unknown
        {
            // INSERT INTO t ( → kolon listesi
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

/// FROM/JOIN'lerden ilişkileri, WITH'ten CTE'leri toplar (tüm statement kapsamı —
/// correlated subquery'ler için dış alias'lar da görünür kalır, design 04 §3).
fn extract_relations(sql: &str, toks: &[Tok]) -> Vec<RelRef> {
    let mut rels: Vec<RelRef> = Vec::new();
    let mut ctes: Vec<RelRef> = Vec::new();

    // ---- CTE'ler: WITH name [AS] ( body ) [, ...] ----
    if let Some(with_i) = toks.iter().position(|t| t.is_keyword && t.upper == "WITH") {
        let mut i = with_i + 1;
        loop {
            // CTE adı
            if i >= toks.len() || toks[i].kind != TokKind::Ident {
                break;
            }
            let name = toks[i].text.trim_matches('"').to_string();
            i += 1;
            // opsiyonel AS
            if i < toks.len() && toks[i].is_keyword && toks[i].upper == "AS" {
                i += 1;
            }
            // gövde parantezi
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
            // virgülle devam?
            if i < toks.len() && toks[i].kind == TokKind::Comma {
                i += 1;
                continue;
            }
            break;
        }
    }

    // ---- FROM / JOIN / INSERT INTO / UPDATE hedef ilişkileri ----
    // (INTO ve UPDATE, INSERT/UPDATE hedef tablosunu getirir; DELETE FROM zaten
    //  FROM üzerinden yakalanır.)
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        if t.is_keyword && matches!(t.upper.as_str(), "FROM" | "JOIN" | "INTO" | "UPDATE") {
            i += 1;
            // FROM sonrası virgülle ayrılmış birden çok ilişki olabilir.
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

    // CTE'ler de görünür (FROM'da adıyla kullanılınca kolonları önerilebilsin diye
    // eşleştirme parse_table_ref'te yapılır; burada ayrıca eklemeye gerek yok).
    rels
}

/// `[schema .] name [[AS] alias]` ya da `( subquery ) [alias]`.
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

    // CTE eşleşmesi: schema yok ve ad bir CTE ise onun kolonlarını taşı.
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

/// `[AS] alias` okur (varsa) ve i'yi ilerletir. Alias yoksa i değişmez.
fn read_alias(toks: &[Tok], i: &mut usize) -> Option<String> {
    let mut j = *i;
    if j < toks.len() && toks[j].is_keyword && toks[j].upper == "AS" {
        j += 1;
    }
    // Alias identifier olmalı (keyword'ler zaten TokKind::Keyword sınıfında).
    if j < toks.len() && toks[j].kind == TokKind::Ident {
        let a = toks[j].text.trim_matches('"').to_string();
        *i = j + 1;
        return Some(a);
    }
    None
}

/// Bir SELECT gövdesinin çıktı kolon adlarını best-effort çıkarır (CTE için).
/// Target list'i top-level virgülle böler; her item'ın çıktı adı: sondaki alias
/// (`expr [AS] name`) ya da tek kolon referansıysa kolon adı.
fn extract_select_output_columns(_sql: &str, body: &[Tok]) -> Vec<String> {
    // SELECT ... FROM arasını al.
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
    // `expr name` (son iki token ident) → alias
    let last = item[item.len() - 1];
    if last.kind == TokKind::Ident {
        if item.len() == 1 {
            // tek kolon referansı: kolon adı = kendisi (a.b ise b)
            return Some(last.text.trim_matches('"').to_string());
        }
        let prev = item[item.len() - 2];
        if prev.kind == TokKind::Dot {
            // a.b → çıktı adı b
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

    /// "SELECT | FROM users" → | imleç. Test yardımcı: '|' konumunu offset yapar.
    fn ctx(s: &str) -> CompletionContext {
        let offset = s.find('|').expect("| gerekli");
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
        // İç subquery'de dış alias u görünür olmalı.
        let c = ctx("SELECT (SELECT | FROM orders o) FROM users u");
        assert!(c.relations.iter().any(|r| r.alias.as_deref() == Some("u")));
        assert!(c.relations.iter().any(|r| r.alias.as_deref() == Some("o")));
    }

    #[test]
    fn multi_statement_isolation() {
        // İmleç ikinci statement'ta; ilk statement'ın FROM'u sızmamalı.
        let c = ctx("SELECT 1; SELECT * FROM orders WHERE |");
        assert_eq!(c.clause, Clause::Where);
        assert!(c.relations.iter().any(|r| r.name == "orders"));
        assert!(!c.relations.iter().any(|r| r.name == "users"));
    }
}
