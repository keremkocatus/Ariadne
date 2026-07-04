//! Thin IPC layer: deserialize → call the relevant module → serialize. The business
//! logic lives in `db/`, `cache/`, and `profiles/`.

pub mod activity;
pub mod complete;
pub mod connect;
pub mod details;
pub mod edit;
pub mod files;
pub mod profile;
pub mod query;
pub mod roles;
pub mod schema;
