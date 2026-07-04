//! Yapılandırılmış logging kurulumu (design 01 §6).
//!
//! Konsol (dev) + günlük dönen dosya (`app_log_dir/ariadne.YYYY-MM-DD.log`, 7 gün
//! saklama). Seviye env `ARIADNE_LOG` ile ayarlanır (varsayılan `info`).
//!
//! Kurallar (design 06 §2 redaksiyon): SQL metni yalnız `debug` seviyesinde;
//! `info`'da süre/satır sayısı; şifre/connection string **hiçbir** seviyede.
//! Bu kurallar çağrı yerlerinde (`tracing::debug!`/`info!`) uygulanır.

use std::path::PathBuf;

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

/// Global subscriber'ı kurar. Bir kez (setup'ta) çağrılır. Dosya appender'ı
/// kurulamazsa (izin/yol) sessizce yalnız konsola düşer — uygulama çalışır.
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
            // Guard süreç ömrü boyunca yaşamalı (drop olursa flush durur); süreç
            // kapanışında OS zaten buffer'ı bırakır. Kasıtlı sızdırma.
            std::mem::forget(guard);
            fmt::layer().with_ansi(false).with_writer(non_blocking)
        });

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .with(file_layer)
        .init();
}
