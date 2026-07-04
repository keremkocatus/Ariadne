//! Bağlantı profilleri + OS keychain (design 06).
//!
//! Profiller `{app_config_dir}/profiles.json`'da **şifresiz** saklanır; şifreler
//! `keyring` ile OS keychain'e (Windows Credential Manager) yazılır.

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
    #[serde(default)]
    pub options: HashMap<String, String>,
}

fn default_port() -> u16 {
    5432
}

/// save_profile girdisi. `id` yoksa yeni profil (uuid atanır), varsa günceller.
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
    pub options: HashMap<String, String>,
}

impl ProfileInput {
    /// Kalıcılaştırmadan (test_connection) geçici ConnectionProfile üretir.
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
            options: self.options,
        }
    }
}

/// Disk'teki profiller (şifresiz). Bellekte tutulur, değişiklikte persist edilir.
pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<ConnectionProfile>>,
}

impl ProfileStore {
    /// profiles.json'ı yükler (yoksa boş başlar).
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

    /// Profili kaydeder (create/update) + şifre verildiyse keyring'e yazar.
    pub fn save(
        &self,
        input: ProfileInput,
        password: Option<String>,
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

        if let Some(pw) = password {
            set_password(&id, &pw)?;
        }
        Ok(profile)
    }

    /// Profili + keyring kaydını siler.
    pub fn delete(&self, id: &str) -> Result<(), AriadneError> {
        {
            let mut list = self.profiles.lock().unwrap();
            list.retain(|p| p.id != id);
        }
        self.persist()?;
        // Keyring'de kayıt yoksa hata değil.
        let _ = delete_password(id);
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

// ---- Keyring yardımcıları (design 06 §2) ----

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
