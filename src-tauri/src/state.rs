//! Paylaşılan uygulama state'i (design 01 §3).
//!
//! `connections`: connection_id → aktif bağlantı (pool + ArcSwap cache). Cache
//! immutable snapshot olarak tutulur; refresh yeni cache kurup atomik swap eder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use arc_swap::ArcSwap;
use serde::Serialize;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};

use crate::cache::SchemaCache;
use crate::error::{AriadneError, ErrorKind};
use crate::profiles::{ConnectionProfile, ProfileId, ProfileStore, SslMode};

pub type ConnectionId = String;

pub struct AppState {
    pub connections: RwLock<HashMap<ConnectionId, Arc<ActiveConnection>>>,
    pub profiles: ProfileStore,
}

impl AppState {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            profiles: ProfileStore::load(config_dir),
        }
    }

    pub fn connection(&self, id: &str) -> Result<Arc<ActiveConnection>, AriadneError> {
        self.connections
            .read()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| {
                AriadneError::new(ErrorKind::ConnectionLost, "Connection not found or closed")
            })
    }
}

pub struct ActiveConnection {
    pub id: ConnectionId,
    /// Bağlantıyı profiline geri bağlar (reconnect / pin çözümü — Phase 1).
    #[allow(dead_code)]
    pub profile_id: ProfileId,
    pub pool: PgPool,
    pub schema_cache: ArcSwap<SchemaCache>,
    /// connect anındaki sunucu bilgisi; şimdilik frontend'e ayrıca döner.
    #[allow(dead_code)]
    pub info: ConnectionInfo,
    /// Cursor'lar, tab session'ları, iptal için PID'ler (design 05).
    pub exec: crate::db::exec::ExecRegistry,
}

/// connect dönüşü (design 02 §3).
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionInfo {
    pub connection_id: ConnectionId,
    pub profile_id: ProfileId,
    pub server_version: String,
    pub database: String,
    pub user: String,
    pub color: Option<String>,
}

fn map_ssl(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

/// Profil + şifreden pool kurar (design 06 §3 havuz ayarları). `application_name`
/// daima `ariadne`; `statement_timeout` ve `read_only` her yeni bağlantıda SET edilir.
pub async fn build_pool(
    profile: &ConnectionProfile,
    password: Option<&str>,
) -> Result<PgPool, AriadneError> {
    let mut opts = PgConnectOptions::new()
        .host(&profile.host)
        .port(profile.port)
        .database(&profile.database)
        .username(&profile.user)
        .ssl_mode(map_ssl(profile.ssl_mode))
        .application_name("ariadne");
    if let Some(pw) = password {
        opts = opts.password(pw);
    }

    let stmt_timeout = profile.statement_timeout_ms;
    let read_only = profile.read_only;

    PgPoolOptions::new()
        .max_connections(5)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .test_before_acquire(true)
        .after_connect(move |conn, _meta| {
            Box::pin(async move {
                if let Some(ms) = stmt_timeout {
                    sqlx::query(&format!("SET statement_timeout = {ms}"))
                        .execute(&mut *conn)
                        .await?;
                }
                if read_only {
                    sqlx::query("SET default_transaction_read_only = on")
                        .execute(&mut *conn)
                        .await?;
                }
                Ok(())
            })
        })
        .connect_with(opts)
        .await
        .map_err(AriadneError::from)
}
