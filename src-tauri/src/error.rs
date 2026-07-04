//! Tek hata tipi: AriadneError (design 02 §2).
//!
//! IPC sınırında frontend'e giden serializable şekil. İçeride sqlx/io hataları
//! `?` ile bu tipe otomatik yükselir (From impl'leri aşağıda) — her yerde `match`
//! yazmaya gerek yok.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AriadneError {
    pub kind: ErrorKind,
    /// Kullanıcıya gösterilecek tek satır.
    pub message: String,
    /// Katlanabilir teknik detay.
    pub detail: Option<String>,
    /// Postgres kaynaklı hatalarda: "42P01" gibi.
    pub sqlstate: Option<String>,
    /// SQL içindeki 1-based offset → Monaco marker (M2+).
    pub position: Option<u32>,
    /// Postgres'in HINT alanı.
    pub hint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    ConnectionFailed,
    ConnectionLost,
    QueryError,
    QueryCancelled,
    // Hata taksonomisinin parçaları; ayrık UI sunumu Phase 1'de (şimdilik sqlx
    // timeout'u QueryError'a düşer, pg_query hataları sunucuya bırakılır).
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

    /// Client-side pg_query parse hatası kurucusu (Phase 1'de inline marker için).
    #[allow(dead_code)]
    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::ParseError, message)
    }
}

/// sqlx hatalarını IPC şekline çevir. M0'da sqlstate + mesaj çıkarılır;
/// position/hint (Monaco marker'ı için) M2'de zenginleştirilecek.
impl From<sqlx::Error> for AriadneError {
    fn from(err: sqlx::Error) -> Self {
        use sqlx::Error as E;
        match &err {
            E::Database(db) => {
                let sqlstate = db.code().map(|c| c.into_owned());
                // 57014 = query_canceled: kullanıcı iptali; UI hata gibi göstermez (design 05 §3).
                let kind = if sqlstate.as_deref() == Some("57014") {
                    ErrorKind::QueryCancelled
                } else {
                    ErrorKind::QueryError
                };
                AriadneError {
                    kind,
                    message: db.message().to_string(),
                    detail: None,
                    sqlstate,
                    position: None,
                    hint: None,
                }
            }
            E::PoolTimedOut => AriadneError::new(
                ErrorKind::ConnectionFailed,
                "Connection pool timed out",
            ),
            E::Io(_) | E::Tls(_) | E::Configuration(_) => {
                AriadneError::new(ErrorKind::ConnectionFailed, err.to_string())
            }
            E::PoolClosed => {
                AriadneError::new(ErrorKind::ConnectionLost, err.to_string())
            }
            _ => AriadneError::internal(err.to_string()),
        }
    }
}
