//! Paylaşılan uygulama state'i (design 01 §3).
//!
//! `connections`: connection_id → aktif bağlantı (pool + ArcSwap cache). Cache
//! immutable snapshot olarak tutulur; refresh yeni cache kurup atomik swap eder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use arc_swap::ArcSwap;
use serde::Serialize;
use sqlx::postgres::PgPool;

use crate::cache::SchemaCache;
use crate::error::{AriadneError, ErrorKind};
use crate::profiles::{ProfileId, ProfileStore};

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
    /// connect anındaki sunucu bilgisi (database/user/color) — `list_databases`
    /// gibi komutlar bağlantının hangi DB'de olduğunu buradan okur.
    pub info: ConnectionInfo,
    /// Cursor'lar, tab session'ları, iptal için PID'ler (design 05).
    pub exec: crate::db::exec::ExecRegistry,
    /// Çalışan bir cache refresh var mı — üst üste istekleri birleştirir (design 03 §5 / 11 §H7).
    pub refreshing: AtomicBool,
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
