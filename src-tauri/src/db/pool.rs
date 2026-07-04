//! Pool setup. Builds a PgPool from a profile + password; `application_name` is
//! always `ariadne`, and `statement_timeout` / read-only are SET on every new
//! connection.

use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};

use crate::error::AriadneError;
use crate::profiles::{ConnectionProfile, SslMode};

fn map_ssl(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

/// `database_override`: if given, connect to this database instead of the profile's
/// (used to switch to another database on the same server). Postgres requires a new
/// connection to change database, so this is really an "open a second pool" path,
/// not a mutation of the existing one.
pub async fn build_pool(
    profile: &ConnectionProfile,
    password: Option<&str>,
    database_override: Option<&str>,
) -> Result<PgPool, AriadneError> {
    let mut opts = PgConnectOptions::new()
        .host(&profile.host)
        .port(profile.port)
        .database(database_override.unwrap_or(&profile.database))
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
