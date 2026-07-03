//! İnce IPC katmanı (design 01 §4): deserialize → ilgili modülü çağır → serialize.
//! İş mantığı `db/`, `cache/`, `profiles/` içinde yaşar.

pub mod connect;
pub mod profile;
pub mod query;
pub mod schema;
