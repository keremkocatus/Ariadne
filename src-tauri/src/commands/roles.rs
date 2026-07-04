//! Rol/kullanıcı listesi (design 15 §P1-U4, salt-okunur). On-demand — cache'e
//! girmez. `pg_roles` tüm kullanıcılara okunabilir (şifre alanı hariç); düşük
//! yetkide bazı alanlar kısıtlı olabilir, hata yerine kısmi veri döneriz.

use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::error::AriadneError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct RoleInfo {
    pub name: String,
    pub is_superuser: bool,
    pub can_login: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub replication: bool,
    /// Şifre geçerlilik sonu (timestamptz metni) — yoksa null.
    pub valid_until: Option<String>,
    /// Doğrudan üye olunan roller.
    pub member_of: Vec<String>,
}

#[tauri::command]
pub async fn list_roles(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RoleInfo>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let rows = sqlx::query(
        "SELECT r.rolname AS name, r.rolsuper AS is_superuser, r.rolcanlogin AS can_login, \
                r.rolcreatedb AS create_db, r.rolcreaterole AS create_role, \
                r.rolreplication AS replication, \
                CASE WHEN r.rolvaliduntil IS NULL THEN NULL ELSE r.rolvaliduntil::text END AS valid_until, \
                COALESCE(ARRAY( \
                    SELECT g.rolname FROM pg_catalog.pg_auth_members m \
                    JOIN pg_catalog.pg_roles g ON g.oid = m.roleid \
                    WHERE m.member = r.oid ORDER BY g.rolname \
                ), ARRAY[]::name[])::text[] AS member_of \
         FROM pg_catalog.pg_roles r \
         ORDER BY r.rolname",
    )
    .fetch_all(&conn.pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(RoleInfo {
                name: r.try_get("name")?,
                is_superuser: r.try_get("is_superuser")?,
                can_login: r.try_get("can_login")?,
                create_db: r.try_get("create_db")?,
                create_role: r.try_get("create_role")?,
                replication: r.try_get("replication")?,
                valid_until: r.try_get("valid_until")?,
                member_of: r.try_get("member_of")?,
            })
        })
        .collect()
}
