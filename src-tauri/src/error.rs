//! The single error type: `AriadneError`.
//!
//! This is the serializable shape that crosses the IPC boundary to the frontend.
//! Internally, sqlx/io errors are lifted into it automatically via `?` (the `From`
//! impls below), so call sites don't need to `match` on error variants everywhere.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AriadneError {
    pub kind: ErrorKind,
    /// One-line message shown to the user.
    pub message: String,
    /// Collapsible technical detail.
    pub detail: Option<String>,
    /// Postgres SQLSTATE for server-side errors, e.g. "42P01".
    pub sqlstate: Option<String>,
    /// 1-based offset within the SQL, used to place a Monaco marker.
    pub position: Option<u32>,
    /// Postgres HINT field.
    pub hint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    ConnectionFailed,
    ConnectionLost,
    QueryError,
    QueryCancelled,
    // Reserved taxonomy variants not yet surfaced distinctly in the UI: sqlx
    // timeouts currently fall under QueryError, and pg_query parse errors are
    // left to the server.
    #[allow(dead_code)]
    Timeout,
    #[allow(dead_code)]
    ParseError,
    KeyringError,
    Internal,
}

impl AriadneError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: None,
            sqlstate: None,
            position: None,
            hint: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    /// Constructor for client-side pg_query parse errors (for future inline markers).
    #[allow(dead_code)]
    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::ParseError, message)
    }
}

/// Converts sqlx errors into the IPC shape. For Postgres errors it extracts
/// SQLSTATE, message, and position/hint/detail (the Monaco marker relies on these).
///
/// Note: `position` here is the **statement-local** 1-based character position (as
/// Postgres reports it). For multi-statement scripts, `exec::run_query` adds the
/// statement's start offset in the editor to convert it to an absolute position.
impl From<sqlx::Error> for AriadneError {
    fn from(err: sqlx::Error) -> Self {
        use sqlx::Error as E;
        match &err {
            E::Database(db) => {
                let sqlstate = db.code().map(|c| c.into_owned());
                // 57014 = query_canceled: user-initiated cancel; not shown as an error.
                let kind = if sqlstate.as_deref() == Some("57014") {
                    ErrorKind::QueryCancelled
                } else {
                    ErrorKind::QueryError
                };
                // Postgres-specific fields (position/hint/detail) via downcast. Ariadne
                // only ever talks to Postgres, but we stay on the safe side.
                let pg = db.try_downcast_ref::<sqlx::postgres::PgDatabaseError>();
                let position = pg.and_then(|p| match p.position() {
                    // Original = a position in the user's SQL; Internal points at a
                    // server-generated inner query we can't show in the editor, so skip it.
                    Some(sqlx::postgres::PgErrorPosition::Original(n)) => Some(n as u32),
                    _ => None,
                });
                let hint = pg.and_then(|p| p.hint().map(str::to_string));
                let detail = pg.and_then(|p| p.detail().map(str::to_string));
                AriadneError {
                    kind,
                    message: db.message().to_string(),
                    detail,
                    sqlstate,
                    position,
                    hint,
                }
            }
            E::PoolTimedOut => {
                AriadneError::new(ErrorKind::ConnectionFailed, "Connection pool timed out")
            }
            E::Io(_) | E::Tls(_) | E::Configuration(_) => {
                AriadneError::new(ErrorKind::ConnectionFailed, err.to_string())
            }
            E::PoolClosed => AriadneError::new(ErrorKind::ConnectionLost, err.to_string()),
            _ => AriadneError::internal(err.to_string()),
        }
    }
}
