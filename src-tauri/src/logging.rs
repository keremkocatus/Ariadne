//! Structured logging setup.
//!
//! Console (dev) + a daily rolling file (`app_log_dir/ariadne.YYYY-MM-DD.log`, kept
//! for 7 days). The level is set via the `ARIADNE_LOG` env var (default `info`).
//!
//! Redaction rules: SQL text only at `debug` level; duration/row counts at `info`;
//! passwords/connection strings at **no** level. These are enforced at the call
//! sites (`tracing::debug!`/`info!`).

use std::path::PathBuf;

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

/// Installs the global subscriber. Called once (at setup). If the file appender
/// can't be created (permissions/path), it silently falls back to console only — the
/// app still runs.
pub fn init(log_dir: PathBuf) {
    let filter = EnvFilter::try_from_env("ARIADNE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    let file_layer = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("ariadne")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&log_dir)
        .ok()
        .map(|appender| {
            let (non_blocking, guard) = tracing_appender::non_blocking(appender);
            // The guard must live for the whole process (dropping it stops the flush);
            // the OS releases the buffer on process exit anyway. Deliberate leak.
            std::mem::forget(guard);
            fmt::layer().with_ansi(false).with_writer(non_blocking)
        });

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .with(file_layer)
        .init();
}
