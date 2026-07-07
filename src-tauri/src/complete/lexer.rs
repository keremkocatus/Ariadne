//! A wrapper around the real Postgres lexer. Turns `pg_query::scan` output into an
//! offset-tagged token stream that context analysis ([`super::context`]) runs on top
//! of. There is no regex/heuristic lexer — even half-written or unparseable SQL
//! tokenizes robustly.

#[derive(Debug, Clone)]
pub(super) struct Tok {
    pub(super) text: String,
    pub(super) upper: String,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) is_keyword: bool,
    pub(super) kind: TokKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TokKind {
    Ident,
    Keyword,
    String,
    Comment,
    Dot,
    Comma,
    LParen,
    RParen,
    Semicolon,
    Other,
}

/// Plain single-shot tokenize; production code goes through `tokenize_resilient`.
#[cfg(test)]
fn tokenize(sql: &str) -> Vec<Tok> {
    try_tokenize(sql).unwrap_or_default()
}

/// Tokenize with graceful degradation for half-written SQL. `pg_query::scan` fails
/// outright on an unterminated string/comment anywhere in the text, which would leave
/// completion with zero tokens (the common case: typing a literal in UPDATE … SET).
/// Context analysis never looks past the cursor, so the fallbacks only need to be
/// correct before it: (1) full scan; (2) the text truncated at the cursor (an
/// unterminated literal after the cursor disappears); (3) the truncated text with a
/// closing terminator appended (the cursor is inside the literal — the resulting
/// string token makes the suppress check fire, which is the right outcome);
/// (4) empty stream, as before.
pub(super) fn tokenize_resilient(sql: &str, offset: usize) -> Vec<Tok> {
    if let Ok(toks) = try_tokenize(sql) {
        return toks;
    }
    let mut off = offset.min(sql.len());
    while off > 0 && !sql.is_char_boundary(off) {
        off -= 1;
    }
    let prefix = &sql[..off];
    if let Ok(toks) = try_tokenize(prefix) {
        return toks;
    }
    for term in ["'", "\"", "*/"] {
        if let Ok(toks) = try_tokenize(&format!("{prefix}{term}")) {
            return toks;
        }
    }
    Vec::new()
}

fn try_tokenize(sql: &str) -> Result<Vec<Tok>, pg_query::Error> {
    let scan = pg_query::scan(sql)?;
    let bytes = sql.as_bytes();
    let mut out = Vec::with_capacity(scan.tokens.len());
    for t in scan.tokens {
        let (start, end) = (t.start.max(0) as usize, t.end.max(0) as usize);
        if start > end || end > bytes.len() {
            continue;
        }
        let text = sql[start..end].to_string();
        let is_keyword = t.keyword_kind != 0; // 0 = NO_KEYWORD
        let kind = classify(&text, is_keyword);
        out.push(Tok {
            upper: text.to_uppercase(),
            text,
            start,
            end,
            is_keyword,
            kind,
        });
    }
    Ok(out)
}

fn classify(text: &str, is_keyword: bool) -> TokKind {
    let b = text.as_bytes();
    match b.first() {
        Some(b'\'') => TokKind::String,
        Some(b'"') => TokKind::Ident, // quoted identifier
        Some(b'-') if text.starts_with("--") => TokKind::Comment,
        Some(b'/') if text.starts_with("/*") => TokKind::Comment,
        Some(b'.') if text == "." => TokKind::Dot,
        Some(b',') if text == "," => TokKind::Comma,
        Some(b'(') if text == "(" => TokKind::LParen,
        Some(b')') if text == ")" => TokKind::RParen,
        Some(b';') if text == ";" => TokKind::Semicolon,
        _ if is_keyword => TokKind::Keyword,
        Some(c) if c.is_ascii_alphabetic() || *c == b'_' => TokKind::Ident,
        _ => TokKind::Other,
    }
}

/// Finds the token range of the statement the cursor is in (bounded by `;`).
pub(super) fn statement_bounds(tokens: &[Tok], offset: usize) -> (usize, usize) {
    let mut start = 0;
    let mut end = tokens.len();
    for (i, t) in tokens.iter().enumerate() {
        if t.kind == TokKind::Semicolon {
            if t.end <= offset {
                start = i + 1;
            } else {
                end = i;
                break;
            }
        }
    }
    (start, end)
}

/// Starts at the LParen index; returns (content_start, content_end, after_close).
pub(super) fn match_paren(toks: &[Tok], lparen: usize) -> (usize, usize, usize) {
    let mut depth = 0;
    let mut i = lparen;
    while i < toks.len() {
        match toks[i].kind {
            TokKind::LParen => depth += 1,
            TokKind::RParen => {
                depth -= 1;
                if depth == 0 {
                    return (lparen + 1, i, i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    (lparen + 1, toks.len(), toks.len())
}

/// Splits on top-level commas (paren depth 0); each slice is one target/arg item.
pub(super) fn split_items(toks: &[Tok]) -> Vec<&[Tok]> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    for (i, t) in toks.iter().enumerate() {
        match t.kind {
            TokKind::LParen => depth += 1,
            TokKind::RParen => depth -= 1,
            TokKind::Comma if depth == 0 => {
                out.push(&toks[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    if start < toks.len() {
        out.push(&toks[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resilient_tokenizes_unterminated_string() {
        let sql = "UPDATE users SET name = 'x";
        assert!(tokenize(sql).is_empty(), "plain scan must fail");
        let toks = tokenize_resilient(sql, sql.len());
        assert!(!toks.is_empty());
        assert_eq!(toks.last().unwrap().kind, TokKind::String);
    }

    #[test]
    fn resilient_truncates_at_cursor() {
        // The unterminated literal is AFTER the cursor; the prefix scan recovers.
        let sql = "SELECT * FROM users WHERE  ; SELECT 'oops";
        let offset = sql.find(';').unwrap() - 1;
        assert!(tokenize(sql).is_empty());
        let toks = tokenize_resilient(sql, offset);
        assert!(toks.iter().any(|t| t.upper == "WHERE"));
    }
}
