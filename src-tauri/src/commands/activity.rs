//! Sunucu aktivitesi + backend sinyalleme (design 17 §P1-V4). Prod yangını
//! personası (P2): "kim ne koşuyor" → "şunu iptal et / öldür". `pg_stat_activity`
//! cluster-geneli olduğundan tüm DB'ler görünür; on-demand, cache'e girmez.

use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::error::{AriadneError, ErrorKind};
use crate::state::AppState;

#[derive(Serialize)]
pub struct ActivityRow {
    pub pid: i32,
    pub datname: Option<String>,
    pub usename: Option<String>,
    pub application_name: String,
    pub client_addr: Option<String>,
    pub state: Option<String>,
    /// wait_event_type[:wait_event] birleşik (yoksa null).
    pub wait_event: Option<String>,
    pub backend_start: Option<String>,
    pub query_start: Option<String>,
    /// Aktif sorgunun şu ana kadarki süresi (ms); aktif değilse null.
    pub duration_ms: Option<i64>,
    /// Sorgu metninin ilk 200 karakteri (yetkisiz kullanıcıda `<insufficient privilege>`).
    pub query: String,
    /// Bu satır listeyi çeken bağlantının kendi backend'i mi (tam eşleşme).
    pub is_self: bool,
    /// Ariadne'nin herhangi bir backend'i mi (application_name='ariadne') — kullanıcı
    /// kendi uygulamasının bağlantısını yanlışlıkla öldürmesin diye işaretlenir.
    pub is_app: bool,
}

/// `pg_stat_activity` client backend'leri (design 17 §P1-V4). Aktifler önce,
/// en uzun süredir koşan en üstte.
#[tauri::command]
pub async fn list_activity(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ActivityRow>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let rows = sqlx::query(
        "SELECT pid, datname, usename, \
                COALESCE(application_name, '') AS application_name, \
                CASE WHEN client_addr IS NULL THEN NULL ELSE host(client_addr) END AS client_addr, \
                state, \
                CASE WHEN wait_event_type IS NULL THEN NULL \
                     ELSE wait_event_type || COALESCE(':' || wait_event, '') END AS wait_event, \
                backend_start::text AS backend_start, \
                CASE WHEN query_start IS NULL THEN NULL ELSE query_start::text END AS query_start, \
                CASE WHEN state = 'active' AND query_start IS NOT NULL \
                     THEN (EXTRACT(EPOCH FROM (now() - query_start)) * 1000)::int8 \
                     ELSE NULL END AS duration_ms, \
                LEFT(query, 200) AS query, \
                (pid = pg_backend_pid()) AS is_self, \
                (application_name = 'ariadne') AS is_app \
         FROM pg_catalog.pg_stat_activity \
         WHERE backend_type = 'client backend' \
         ORDER BY (state = 'active') DESC, query_start ASC NULLS LAST",
    )
    .fetch_all(&conn.pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(ActivityRow {
                pid: r.try_get("pid")?,
                datname: r.try_get("datname")?,
                usename: r.try_get("usename")?,
                application_name: r.try_get("application_name")?,
                client_addr: r.try_get("client_addr")?,
                state: r.try_get("state")?,
                wait_event: r.try_get("wait_event")?,
                backend_start: r.try_get("backend_start")?,
                query_start: r.try_get("query_start")?,
                duration_ms: r.try_get("duration_ms")?,
                query: r.try_get::<Option<String>, _>("query")?.unwrap_or_default(),
                is_self: r.try_get("is_self")?,
                is_app: r.try_get("is_app")?,
            })
        })
        .collect()
}

/// Bir backend'e sinyal gönderir (design 17 §P1-V4): `cancel` = pg_cancel_backend
/// (koşan sorguyu durdur), `terminate` = pg_terminate_backend (bağlantıyı kopar).
/// Dönen bool: böyle bir backend var/sinyallendi mi. Yetki hatası (superuser değil
/// + başka rolün backend'i) normal AriadneError yolundan SQLSTATE ile akar.
#[tauri::command]
pub async fn signal_backend(
    connection_id: String,
    pid: i32,
    mode: String,
    state: State<'_, AppState>,
) -> Result<bool, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let sql = signal_sql(&mode)
        .ok_or_else(|| AriadneError::new(ErrorKind::Internal, "invalid signal mode"))?;
    let ok: bool = sqlx::query_scalar(sql)
        .bind(pid)
        .fetch_one(&conn.pool)
        .await
        .map_err(AriadneError::from)?;
    Ok(ok)
}

/// StatusBar istatistik şeridi (design 20 §P1-Y3 M5). Düz SQL ile GÜVENİLİR alınan
/// metrikler; CPU/RAM bilinçli olarak YOK (host metriği düz SQL ile alınamaz — bkz.
/// design 20 §6). Tek round-trip, on-demand (cache dışı), 30 sn'de bir poll edilir.
#[derive(Serialize)]
pub struct DbStats {
    /// Kümedeki client backend sayısı (görünür olanlar; düşük yetkide undercount).
    pub active_connections: i64,
    /// `max_connections` GUC (current_setting ile herkese açık; hata olursa None).
    pub max_connections: Option<i64>,
    /// Cache hit oranı 0..1 (pg_stat_database blks_hit / (blks_hit+blks_read)); hiç
    /// aktivite yoksa None.
    pub cache_hit_ratio: Option<f64>,
    /// Aktif veritabanının disk boyutu (bytes); alınamıyorsa None.
    pub db_size_bytes: Option<i64>,
}

/// Aktif bağlantının DB istatistiklerini tek SELECT'te toplar (design 20 §P1-Y3 M5).
#[tauri::command]
pub async fn db_stats(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<DbStats, AriadneError> {
    let conn = state.connection(&connection_id)?;
    collect_db_stats(&conn.pool).await
}

/// db_stats SQL'i (test edilebilir olsun diye komuttan ayrı — State yerine pool alır).
async fn collect_db_stats(pool: &sqlx::PgPool) -> Result<DbStats, AriadneError> {
    let row = sqlx::query(
        "SELECT \
            (SELECT count(*) FROM pg_catalog.pg_stat_activity \
             WHERE backend_type = 'client backend')::int8 AS active_connections, \
            current_setting('max_connections')::int8 AS max_connections, \
            (SELECT sum(blks_hit)::float8 / NULLIF(sum(blks_hit + blks_read), 0) \
             FROM pg_catalog.pg_stat_database) AS cache_hit_ratio, \
            pg_database_size(current_database())::int8 AS db_size_bytes",
    )
    .fetch_one(pool)
    .await
    .map_err(AriadneError::from)?;
    Ok(DbStats {
        active_connections: row
            .try_get::<Option<i64>, _>("active_connections")?
            .unwrap_or(0),
        max_connections: row.try_get("max_connections")?,
        cache_hit_ratio: row.try_get("cache_hit_ratio")?,
        db_size_bytes: row.try_get("db_size_bytes")?,
    })
}

/// Sinyal modu → katalog fonksiyonu. Bilinmeyen mod → None (komut hata döner).
fn signal_sql(mode: &str) -> Option<&'static str> {
    match mode {
        "cancel" => Some("SELECT pg_cancel_backend($1)"),
        "terminate" => Some("SELECT pg_terminate_backend($1)"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{collect_db_stats, signal_sql};

    #[test]
    fn signal_sql_maps_known_modes_only() {
        assert!(signal_sql("cancel").unwrap().contains("pg_cancel_backend"));
        assert!(signal_sql("terminate")
            .unwrap()
            .contains("pg_terminate_backend"));
        assert!(signal_sql("").is_none());
        assert!(signal_sql("drop").is_none());
    }

    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn db_stats_returns_sane_shape() {
        // design 20 M5: alanlar dolu döner (bu bağlantının kendisi bir client backend
        // olduğundan active_connections >= 1; max_connections/db_size erişilebilir).
        let url = std::env::var("ARIADNE_DATABASE_URL").expect("ARIADNE_DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        let s = collect_db_stats(&pool).await.unwrap();
        assert!(s.active_connections >= 1, "en az kendi backend'imiz");
        assert!(
            s.max_connections.unwrap_or(0) > 0,
            "max_connections dolmalı"
        );
        assert!(s.db_size_bytes.unwrap_or(0) > 0, "db boyutu pozitif");
        if let Some(r) = s.cache_hit_ratio {
            assert!((0.0..=1.0).contains(&r), "oran 0..1: {r}");
        }
    }
}
