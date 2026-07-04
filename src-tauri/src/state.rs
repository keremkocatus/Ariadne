//! Shared application state.
//!
//! `connections`: connection_id → active connection (pool + ArcSwap cache). The
//! cache is held as an immutable snapshot; a refresh builds a new cache and swaps it
//! in atomically.

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
    /// Links the connection back to its profile (for reconnect / pin resolution).
    #[allow(dead_code)]
    pub profile_id: ProfileId,
    pub pool: PgPool,
    pub schema_cache: ArcSwap<SchemaCache>,
    /// Server info captured at connect time (database/user/color) — commands like
    /// `list_databases` read which database the connection is on from here.
    pub info: ConnectionInfo,
    /// Cursors, tab sessions, and PIDs for cancellation.
    pub exec: crate::db::exec::ExecRegistry,
    /// Whether a cache refresh is in flight — coalesces overlapping requests.
    pub refreshing: AtomicBool,
}

/// The return value of `connect`.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionInfo {
    pub connection_id: ConnectionId,
    pub profile_id: ProfileId,
    pub server_version: String,
    pub database: String,
    pub user: String,
    pub color: Option<String>,
}
