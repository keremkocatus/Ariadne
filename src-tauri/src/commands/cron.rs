//! pg_cron job management: list jobs with their latest run, browse run history, and
//! create / alter / delete jobs. Everything goes through pg_cron's own SQL API
//! (`cron.schedule`, `cron.alter_job`, `cron.unschedule`) with bound parameters.
//!
//! pg_cron keeps its tables in a single database (`cron.database_name`); from any
//! other database the extension isn't there, which `cron_overview` reports instead
//! of failing.

use serde::{Deserialize, Serialize};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use tauri::State;

use crate::error::AriadneError;
use crate::state::AppState;

/// How many of the newest run records feed the per-job "last run" and failure
/// counts. `cron.job_run_details` has no index on `jobid` and can grow without bound,
/// so the overview only ever reads this window off the primary key.
const RECENT_RUNS_WINDOW: i64 = 5000;

#[derive(Serialize)]
pub struct CronJob {
    pub job_id: i64,
    /// Null for jobs created with the unnamed `cron.schedule(schedule, command)`.
    pub name: Option<String>,
    pub schedule: String,
    pub command: String,
    pub database: String,
    pub username: String,
    pub active: bool,
    /// succeeded | failed | running | starting | sending | connecting
    pub last_status: Option<String>,
    pub last_start: Option<String>,
    pub last_duration_ms: Option<i64>,
    pub last_message: Option<String>,
    /// Runs and failures within the recent-runs window.
    pub recent_runs: i64,
    pub recent_failures: i64,
}

#[derive(Serialize)]
pub struct CronOverview {
    /// Whether pg_cron is installed in the connected database.
    pub installed: bool,
    pub version: Option<String>,
    /// The database pg_cron is configured to live in, when the setting is readable.
    pub cron_database: Option<String>,
    pub current_database: String,
    /// False when `cron.job_run_details` can't be read (old pg_cron or no privilege).
    pub has_run_details: bool,
    pub jobs: Vec<CronJob>,
}

#[tauri::command]
pub async fn cron_overview(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<CronOverview, AriadneError> {
    let conn = state.connection(&connection_id)?;
    fetch_overview(&conn.pool).await
}

async fn fetch_overview(pool: &PgPool) -> Result<CronOverview, AriadneError> {
    let head = sqlx::query(
        "SELECT (SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') AS version, \
                NULLIF(current_setting('cron.database_name', true), '') AS cron_database, \
                current_database()::text AS current_database",
    )
    .fetch_one(pool)
    .await?;
    let version: Option<String> = head.try_get("version")?;
    let mut overview = CronOverview {
        installed: version.is_some(),
        version,
        cron_database: head.try_get("cron_database")?,
        current_database: head.try_get("current_database")?,
        has_run_details: true,
        jobs: Vec::new(),
    };
    if !overview.installed {
        return Ok(overview);
    }

    // `to_jsonb(j) ->> 'jobname'` instead of `j.jobname`: the column only exists from
    // pg_cron 1.3 on, and a direct reference would fail to plan on older versions.
    let with_runs = sqlx::query(
        "WITH recent AS ( \
             SELECT * FROM cron.job_run_details ORDER BY runid DESC LIMIT $1 \
         ), last AS ( \
             SELECT DISTINCT ON (jobid) jobid, status, start_time, end_time, return_message \
             FROM recent ORDER BY jobid, runid DESC \
         ), agg AS ( \
             SELECT jobid, count(*) AS runs, \
                    count(*) FILTER (WHERE status = 'failed') AS failures \
             FROM recent GROUP BY jobid \
         ) \
         SELECT j.jobid::int8 AS job_id, to_jsonb(j) ->> 'jobname' AS name, \
                j.schedule::text AS schedule, j.command::text AS command, \
                j.database::text AS database, j.username::text AS username, j.active, \
                last.status::text AS last_status, last.start_time::text AS last_start, \
                (EXTRACT(EPOCH FROM (last.end_time - last.start_time)) * 1000)::int8 \
                    AS last_duration_ms, \
                last.return_message::text AS last_message, \
                COALESCE(agg.runs, 0)::int8 AS recent_runs, \
                COALESCE(agg.failures, 0)::int8 AS recent_failures \
         FROM cron.job j \
         LEFT JOIN last ON last.jobid = j.jobid \
         LEFT JOIN agg ON agg.jobid = j.jobid \
         ORDER BY j.jobid",
    )
    .bind(RECENT_RUNS_WINDOW)
    .fetch_all(pool)
    .await;

    let rows = match with_runs {
        Ok(rows) => rows,
        Err(_) => {
            // No run history available: still list the jobs themselves.
            overview.has_run_details = false;
            sqlx::query(
                "SELECT j.jobid::int8 AS job_id, to_jsonb(j) ->> 'jobname' AS name, \
                        j.schedule::text AS schedule, j.command::text AS command, \
                        j.database::text AS database, j.username::text AS username, j.active, \
                        NULL::text AS last_status, NULL::text AS last_start, \
                        NULL::int8 AS last_duration_ms, NULL::text AS last_message, \
                        0::int8 AS recent_runs, 0::int8 AS recent_failures \
                 FROM cron.job j ORDER BY j.jobid",
            )
            .fetch_all(pool)
            .await?
        }
    };
    overview.jobs = rows
        .into_iter()
        .map(job_from_row)
        .collect::<Result<_, _>>()?;
    Ok(overview)
}

fn job_from_row(r: PgRow) -> Result<CronJob, AriadneError> {
    Ok(CronJob {
        job_id: r.try_get("job_id")?,
        name: r.try_get("name")?,
        schedule: r.try_get("schedule")?,
        command: r.try_get("command")?,
        database: r.try_get("database")?,
        username: r.try_get("username")?,
        active: r.try_get("active")?,
        last_status: r.try_get("last_status")?,
        last_start: r.try_get("last_start")?,
        last_duration_ms: r.try_get("last_duration_ms")?,
        last_message: r.try_get("last_message")?,
        recent_runs: r.try_get("recent_runs")?,
        recent_failures: r.try_get("recent_failures")?,
    })
}

#[derive(Serialize)]
pub struct CronRun {
    pub run_id: i64,
    pub status: String,
    pub message: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_ms: Option<i64>,
    /// The command as it was when this run executed (it may have been edited since).
    pub command: String,
}

/// A job's most recent runs, newest first.
#[tauri::command]
pub async fn cron_job_runs(
    connection_id: String,
    job_id: i64,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<CronRun>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    fetch_runs(&conn.pool, job_id, limit.unwrap_or(100).clamp(1, 1000)).await
}

async fn fetch_runs(pool: &PgPool, job_id: i64, limit: i64) -> Result<Vec<CronRun>, AriadneError> {
    let rows = sqlx::query(
        "SELECT runid::int8 AS run_id, status::text AS status, return_message::text AS message, \
                start_time::text AS start_time, end_time::text AS end_time, \
                (EXTRACT(EPOCH FROM (end_time - start_time)) * 1000)::int8 AS duration_ms, \
                command::text AS command \
         FROM cron.job_run_details \
         WHERE jobid = $1 \
         ORDER BY runid DESC \
         LIMIT $2",
    )
    .bind(job_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(CronRun {
                run_id: r.try_get("run_id")?,
                status: r
                    .try_get::<Option<String>, _>("status")?
                    .unwrap_or_default(),
                message: r.try_get("message")?,
                start_time: r.try_get("start_time")?,
                end_time: r.try_get("end_time")?,
                duration_ms: r.try_get("duration_ms")?,
                command: r
                    .try_get::<Option<String>, _>("command")?
                    .unwrap_or_default(),
            })
        })
        .collect()
}

#[derive(Deserialize)]
pub struct CronJobInput {
    /// `None` creates a job; `Some` alters that job in place.
    pub job_id: Option<i64>,
    pub name: String,
    pub schedule: String,
    pub command: String,
    /// The database the command runs in; `None` = the current one.
    pub database: Option<String>,
    pub active: bool,
}

/// Creates or alters a job and returns its id. pg_cron validates the schedule and
/// reports a bad one as an ordinary error.
#[tauri::command]
pub async fn cron_save_job(
    connection_id: String,
    job: CronJobInput,
    state: State<'_, AppState>,
) -> Result<i64, AriadneError> {
    let conn = state.connection(&connection_id)?;
    save_job(&conn.pool, &job).await
}

async fn save_job(pool: &PgPool, job: &CronJobInput) -> Result<i64, AriadneError> {
    let database = job.database.as_deref().filter(|d| !d.trim().is_empty());
    if let Some(id) = job.job_id {
        // A job's name can't be changed by alter_job; the UI keeps it read-only.
        sqlx::query(
            "SELECT cron.alter_job(job_id := $1, schedule := $2, command := $3, \
                                   database := $4, active := $5)",
        )
        .bind(id)
        .bind(&job.schedule)
        .bind(&job.command)
        .bind(database)
        .bind(job.active)
        .execute(pool)
        .await?;
        return Ok(id);
    }

    // One transaction, so a job that should start paused never gets a chance to fire
    // between being scheduled and being deactivated.
    let mut tx = pool.begin().await?;
    let id: i64 = match database {
        Some(db) => {
            sqlx::query_scalar("SELECT cron.schedule_in_database($1, $2, $3, $4)")
                .bind(&job.name)
                .bind(&job.schedule)
                .bind(&job.command)
                .bind(db)
                .fetch_one(&mut *tx)
                .await?
        }
        None => {
            sqlx::query_scalar("SELECT cron.schedule($1, $2, $3)")
                .bind(&job.name)
                .bind(&job.schedule)
                .bind(&job.command)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    if !job.active {
        sqlx::query("SELECT cron.alter_job(job_id := $1, active := false)")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(id)
}

/// Pauses or resumes a job without touching its definition.
#[tauri::command]
pub async fn cron_set_active(
    connection_id: String,
    job_id: i64,
    active: bool,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    sqlx::query("SELECT cron.alter_job(job_id := $1, active := $2)")
        .bind(job_id)
        .bind(active)
        .execute(&conn.pool)
        .await?;
    Ok(())
}

/// Removes a job. Its run history stays in `cron.job_run_details`.
#[tauri::command]
pub async fn cron_delete_job(
    connection_id: String,
    job_id: i64,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    sqlx::query("SELECT cron.unschedule($1::bigint)")
        .bind(job_id)
        .execute(&conn.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates, alters and removes a throwaway job. Skips itself when the target
    /// database has no pg_cron, so it is safe against any server.
    #[tokio::test]
    #[ignore = "requires a live Postgres via ARIADNE_DATABASE_URL"]
    async fn job_lifecycle() {
        let url = std::env::var("ARIADNE_DATABASE_URL").expect("ARIADNE_DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        let overview = fetch_overview(&pool).await.unwrap();
        if !overview.installed {
            eprintln!("pg_cron not installed; skipping");
            return;
        }

        let name = format!("ariadne-test-{}", uuid::Uuid::new_v4());
        let mut job = CronJobInput {
            job_id: None,
            name: name.clone(),
            schedule: "0 0 1 1 *".into(),
            command: "SELECT 1".into(),
            database: None,
            active: false,
        };
        let id = save_job(&pool, &job).await.unwrap();

        let find = |o: CronOverview| o.jobs.into_iter().find(|j| j.job_id == id);
        let created = find(fetch_overview(&pool).await.unwrap()).expect("job listed");
        assert_eq!(created.name.as_deref(), Some(name.as_str()));
        assert!(!created.active, "created paused");

        job.job_id = Some(id);
        job.schedule = "*/10 * * * *".into();
        job.command = "SELECT 2".into();
        job.active = true;
        assert_eq!(save_job(&pool, &job).await.unwrap(), id);
        let altered = find(fetch_overview(&pool).await.unwrap()).expect("job listed");
        assert_eq!(altered.schedule, "*/10 * * * *");
        assert_eq!(altered.command, "SELECT 2");
        assert!(altered.active);

        assert!(fetch_runs(&pool, id, 10).await.unwrap().is_empty());

        job.schedule = "not a schedule".into();
        assert!(
            save_job(&pool, &job).await.is_err(),
            "invalid schedule rejected"
        );

        sqlx::query("SELECT cron.unschedule($1::bigint)")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(find(fetch_overview(&pool).await.unwrap()).is_none());
    }
}
