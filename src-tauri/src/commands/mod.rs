//! İnce IPC katmanı (design 01 §4): deserialize → ilgili modülü çağır → serialize.
//! İş mantığı `db/`, `cache/`, `complete/` içinde yaşar.

pub mod query;
