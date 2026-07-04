//! İnce IPC katmanı (design 01 §4): deserialize → ilgili modülü çağır → serialize.
//! İş mantığı `db/`, `cache/`, `profiles/` içinde yaşar.

pub mod activity;
pub mod complete;
pub mod connect;
pub mod details;
pub mod files;
pub mod profile;
pub mod query;
pub mod roles;
pub mod schema;
