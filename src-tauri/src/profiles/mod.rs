//! Connection profiles + OS keychain.
//!
//! Profiles are stored **without passwords** in `{app_config_dir}/profiles.json`;
//! passwords go to the OS keychain (e.g. Windows Credential Manager) via `keyring`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AriadneError, ErrorKind};

pub type ProfileId = String;

const KEYRING_SERVICE: &str = "ariadne";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: ProfileId,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub statement_timeout_ms: Option<u64>,
    #[serde(default)]
    pub read_only: bool,
    /// Per-profile pool size; None → the default (3). Clamped to 1..=10 at pool build.
    #[serde(default)]
    pub max_pool_connections: Option<u32>,
    #[serde(default)]
    pub options: HashMap<String, String>,
}

fn default_port() -> u16 {
    5432
}

/// Input to save_profile. No `id` → new profile (a uuid is assigned); with `id` → update.
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileInput {
    #[serde(default)]
    pub id: Option<ProfileId>,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub statement_timeout_ms: Option<u64>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub max_pool_connections: Option<u32>,
    #[serde(default)]
    pub options: HashMap<String, String>,
}

impl ProfileInput {
    /// Builds a temporary ConnectionProfile without persisting (for test_connection).
    pub fn into_profile_temp(self) -> ConnectionProfile {
        let id = self.id.clone().unwrap_or_else(|| "__test__".to_string());
        self.into_profile(id)
    }

    fn into_profile(self, id: ProfileId) -> ConnectionProfile {
        ConnectionProfile {
            id,
            name: self.name,
            color: self.color,
            host: self.host,
            port: self.port,
            database: self.database,
            user: self.user,
            ssl_mode: self.ssl_mode,
            statement_timeout_ms: self.statement_timeout_ms,
            read_only: self.read_only,
            max_pool_connections: self.max_pool_connections,
            options: self.options,
        }
    }
}

/// Profiles on disk (without passwords). Held in memory, persisted on change.
pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<ConnectionProfile>>,
}

impl ProfileStore {
    /// Loads profiles.json (starts empty if absent).
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("profiles.json");
        let profiles = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<ConnectionProfile>>(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            profiles: Mutex::new(profiles),
        }
    }

    pub fn list(&self) -> Vec<ConnectionProfile> {
        self.profiles.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionProfile> {
        self.profiles
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// Saves the profile (create/update). `clear_password` removes the stored keyring
    /// entry (there is no other way to drop a saved password — an absent password
    /// means "keep"); otherwise a given password is written to the keyring.
    pub fn save(
        &self,
        input: ProfileInput,
        password: Option<String>,
        clear_password: bool,
    ) -> Result<ConnectionProfile, AriadneError> {
        let id = input
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let profile = input.into_profile(id.clone());

        {
            let mut list = self.profiles.lock().unwrap();
            match list.iter_mut().find(|p| p.id == id) {
                Some(existing) => *existing = profile.clone(),
                None => list.push(profile.clone()),
            }
        }
        self.persist()?;

        if clear_password {
            delete_password(&id)?;
        } else if let Some(pw) = password {
            set_password(&id, &pw)?;
        }
        Ok(profile)
    }

    /// Deletes the profile and its keyring entry.
    pub fn delete(&self, id: &str) -> Result<(), AriadneError> {
        {
            let mut list = self.profiles.lock().unwrap();
            list.retain(|p| p.id != id);
        }
        self.persist()?;
        // NoEntry is already treated as success inside delete_password; anything else
        // (locked/unavailable keychain) leaves an orphaned credential — worth a trace.
        if let Err(e) = delete_password(id) {
            tracing::warn!(error = %e.message, "keyring delete failed; credential may be orphaned");
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), AriadneError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AriadneError::internal(format!("config dir: {e}")))?;
        }
        let list = self.profiles.lock().unwrap();
        let json = serde_json::to_string_pretty(&*list)
            .map_err(|e| AriadneError::internal(format!("serialize profiles: {e}")))?;
        std::fs::write(&self.path, json)
            .map_err(|e| AriadneError::internal(format!("write profiles.json: {e}")))
    }
}

// ---- Keyring helpers ----

fn entry(id: &str) -> Result<keyring::Entry, AriadneError> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(keyring_err)
}

pub fn set_password(id: &str, password: &str) -> Result<(), AriadneError> {
    entry(id)?.set_password(password).map_err(keyring_err)
}

pub fn get_password(id: &str) -> Result<Option<String>, AriadneError> {
    match entry(id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keyring_err(e)),
    }
}

pub fn delete_password(id: &str) -> Result<(), AriadneError> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keyring_err(e)),
    }
}

fn keyring_err(e: keyring::Error) -> AriadneError {
    AriadneError::new(ErrorKind::KeyringError, format!("keyring: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store rooted in a unique temp dir. Passwords are never passed, so the OS
    /// keyring is not touched (except delete on a random id, which is NoEntry → Ok).
    fn temp_store() -> (ProfileStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ariadne-test-{}", uuid::Uuid::new_v4()));
        (ProfileStore::load(dir.clone()), dir)
    }

    fn input(id: Option<&str>, name: &str) -> ProfileInput {
        ProfileInput {
            id: id.map(String::from),
            name: name.into(),
            color: None,
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            user: "postgres".into(),
            ssl_mode: SslMode::Prefer,
            statement_timeout_ms: None,
            read_only: false,
            max_pool_connections: None,
            options: HashMap::new(),
        }
    }

    #[test]
    fn save_new_assigns_id_and_persists() {
        let (store, dir) = temp_store();
        let saved = store.save(input(None, "a"), None, false).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(store.list().len(), 1);
        // Round-trip: a fresh store from the same dir sees the profile.
        let reloaded = ProfileStore::load(dir.clone());
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.get(&saved.id).unwrap().name, "a");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_with_id_updates_in_place() {
        let (store, dir) = temp_store();
        let saved = store.save(input(None, "a"), None, false).unwrap();
        let updated = store
            .save(input(Some(&saved.id), "renamed"), None, false)
            .unwrap();
        assert_eq!(updated.id, saved.id);
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "renamed");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_removes_profile() {
        let (store, dir) = temp_store();
        let saved = store.save(input(None, "a"), None, false).unwrap();
        store.delete(&saved.id).unwrap();
        assert!(store.list().is_empty());
        assert!(ProfileStore::load(dir.clone()).list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_password_on_unknown_id_is_ok() {
        let (store, dir) = temp_store();
        // No stored credential for a fresh uuid: delete inside save must be NoEntry → Ok.
        let saved = store.save(input(None, "a"), None, true).unwrap();
        assert_eq!(store.get(&saved.id).unwrap().name, "a");
        let _ = std::fs::remove_dir_all(dir);
    }
}
