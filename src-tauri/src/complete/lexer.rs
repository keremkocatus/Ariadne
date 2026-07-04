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

pub(super) fn tokenize(sql: &str) -> Vec<Tok> {
    let scan = match pg_query::scan(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
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
    out
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
