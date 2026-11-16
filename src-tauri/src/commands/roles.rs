//! Roles: listing, a role's grants, and applying role changes. On-demand — not part
//! of the cache. `pg_roles` is readable by all users (except the password field); at
//! low privilege some fields may be restricted, in which case we return partial data
//! rather than an error.

use serde::Serialize;
use sqlx::{Executor, Row};
use tauri::{AppHandle, State};

use crate::db::touches_schema;
use crate::error::AriadneError;
use crate::state::AppState;

use super::schema::spawn_cache_refresh;

#[derive(Serialize)]
pub struct RoleInfo {
    pub name: String,
    pub is_superuser: bool,
    pub can_login: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub replication: bool,
    pub bypass_rls: bool,
    /// Whether the role inherits the privileges of roles it is a member of.
    pub inherit: bool,
    /// Max concurrent connections; -1 = unlimited.
    pub connection_limit: i32,
    /// Password expiry (timestamptz as text) — null if none.
    pub valid_until: Option<String>,
    /// Roles this role is a direct member of.
    pub member_of: Vec<String>,
    /// Roles that are direct members of this role.
    pub members: Vec<String>,
    pub comment: Option<String>,
    /// The role this connection is logged in as.
    pub is_current: bool,
    /// A predefined `pg_*` role; it can be granted but not altered or dropped.
    pub is_system: bool,
}

#[tauri::command]
pub async fn list_roles(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RoleInfo>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let rows = sqlx::query(
        "SELECT r.rolname::text AS name, r.rolsuper AS is_superuser, r.rolcanlogin AS can_login, \
                r.rolcreatedb AS create_db, r.rolcreaterole AS create_role, \
                r.rolreplication AS replication, r.rolbypassrls AS bypass_rls, \
                r.rolinherit AS inherit, r.rolconnlimit::int4 AS connection_limit, \
                CASE WHEN r.rolvaliduntil IS NULL THEN NULL ELSE r.rolvaliduntil::text END AS valid_until, \
                ARRAY( \
                    SELECT g.rolname FROM pg_catalog.pg_auth_members m \
                    JOIN pg_catalog.pg_roles g ON g.oid = m.roleid \
                    WHERE m.member = r.oid ORDER BY g.rolname \
                )::text[] AS member_of, \
                ARRAY( \
                    SELECT g.rolname FROM pg_catalog.pg_auth_members m \
                    JOIN pg_catalog.pg_roles g ON g.oid = m.member \
                    WHERE m.roleid = r.oid ORDER BY g.rolname \
                )::text[] AS members, \
                pg_catalog.shobj_description(r.oid, 'pg_authid') AS comment, \
                (r.rolname = current_user) AS is_current, \
                (r.rolname LIKE 'pg\\_%') AS is_system \
         FROM pg_catalog.pg_roles r \
         ORDER BY (r.rolname LIKE 'pg\\_%'), r.rolname",
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
                bypass_rls: r.try_get("bypass_rls")?,
                inherit: r.try_get("inherit")?,
                connection_limit: r.try_get("connection_limit")?,
                valid_until: r.try_get("valid_until")?,
                member_of: r.try_get("member_of")?,
                members: r.try_get("members")?,
                comment: r.try_get("comment")?,
                is_current: r.try_get("is_current")?,
                is_system: r.try_get("is_system")?,
            })
        })
        .collect()
}

/// One object a role holds explicit privileges on.
#[derive(Serialize)]
pub struct RoleGrant {
    /// database | schema | table | view | sequence | function
    pub object_type: String,
    pub schema: Option<String>,
    pub name: String,
    pub privileges: Vec<String>,
}

/// Rows returned at most; a role with broad grants on a huge schema would otherwise
/// produce an unusably long list.
const GRANT_LIMIT: i64 = 2000;

/// Privileges granted directly to `role` in the current database. Privileges that
/// come from role membership or from `PUBLIC` are not expanded.
#[tauri::command]
pub async fn get_role_grants(
    connection_id: String,
    role: String,
    state: State<'_, AppState>,
) -> Result<Vec<RoleGrant>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let rows = sqlx::query(
        "WITH r AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) \
         SELECT * FROM ( \
             SELECT 'database' AS object_type, NULL::text AS schema, d.datname::text AS name, \
                    array_agg(DISTINCT a.privilege_type::text) AS privileges \
             FROM pg_catalog.pg_database d, aclexplode(d.datacl) a, r \
             WHERE a.grantee = r.oid AND d.datname = current_database() \
             GROUP BY d.datname \
             UNION ALL \
             SELECT 'schema', NULL::text, n.nspname::text, \
                    array_agg(DISTINCT a.privilege_type::text) \
             FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a, r \
             WHERE a.grantee = r.oid \
             GROUP BY n.nspname \
             UNION ALL \
             SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' \
                                   WHEN 'm' THEN 'view' ELSE 'table' END, \
                    n.nspname::text, c.relname::text, \
                    array_agg(DISTINCT a.privilege_type::text) \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, \
                  aclexplode(c.relacl) a, r \
             WHERE a.grantee = r.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') \
             GROUP BY c.relkind, n.nspname, c.relname \
             UNION ALL \
             SELECT 'function', n.nspname::text, \
                    p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', \
                    array_agg(DISTINCT a.privilege_type::text) \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace, \
                  aclexplode(p.proacl) a, r \
             WHERE a.grantee = r.oid \
             GROUP BY n.nspname, p.proname, p.oid \
         ) g \
         ORDER BY array_position(ARRAY['database', 'schema', 'table', 'view', 'sequence', 'function'], \
                                 g.object_type), g.schema, g.name \
         LIMIT $2",
    )
    .bind(&role)
    .bind(GRANT_LIMIT)
    .fetch_all(&conn.pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(RoleGrant {
                object_type: r.try_get("object_type")?,
                schema: r.try_get("schema")?,
                name: r.try_get("name")?,
                privileges: r.try_get("privileges")?,
            })
        })
        .collect()
}

/// Runs administrative statements built by the UI (role and privilege changes) in a
/// single transaction: either all of them apply or none do.
///
/// The SQL is deliberately never logged — `CREATE/ALTER ROLE … PASSWORD` carries the
/// password in plain text.
#[tauri::command]
pub async fn execute_statements(
    connection_id: String,
    statements: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    let mut c = conn.pool.acquire().await.map_err(AriadneError::from)?;
    sqlx::query("BEGIN").execute(&mut *c).await?;
    for stmt in &statements {
        if let Err(e) = c.execute(sqlx::raw_sql(stmt)).await {
            let _ = sqlx::query("ROLLBACK").execute(&mut *c).await;
            return Err(AriadneError::from(e));
        }
    }
    sqlx::query("COMMIT").execute(&mut *c).await?;
    tracing::info!(
        connection_id = %connection_id,
        statements = statements.len(),
        "admin statements applied"
    );
    if statements.iter().any(|s| touches_schema(s)) {
        spawn_cache_refresh(app, conn);
    }
    Ok(())
}
