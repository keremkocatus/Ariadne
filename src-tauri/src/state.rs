//! Paylaşılan uygulama state'i (design 01 §3).
//!
//! M0: tek hardcoded bağlantı. Pool ilk `run_query`'de lazy kurulur ve
//! `OnceCell` ile tekrar kullanılır. M1'de bu, `connection_id → ActiveConnection`
//! map'ine dönüşecek (profiller + keyring).

use sqlx::postgres::{PgPool, PgPoolOptions};
use tokio::sync::OnceCell;

use crate::error::AriadneError;

/// M0 hardcoded varsayılan bağlantı. `ARIADNE_DATABASE_URL` env ile ezilebilir,
/// böylece test için kendi DB'ni gösterebilirsin.
const DEFAULT_DATABASE_URL: &str = "postgres://postgres:postgres@localhost:5432/postgres";

pub struct AppState {
    pool: OnceCell<PgPool>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            pool: OnceCell::new(),
        }
    }

    /// Pool'u (gerekiyorsa kurarak) döndürür. İlk çağrıda bağlantı kurulur;
    /// başarısızsa `ConnectionFailed` yükselir.
    pub async fn pool(&self) -> Result<&PgPool, AriadneError> {
        self.pool
            .get_or_try_init(|| async {
                let url = std::env::var("ARIADNE_DATABASE_URL")
                    .unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string());
                PgPoolOptions::new()
                    .max_connections(5)
                    .connect(&url)
                    .await
            })
            .await
            .map_err(AriadneError::from)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
