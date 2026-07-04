//! Reading/writing .sql files. The native file dialog is opened on the frontend via
//! `@tauri-apps/plugin-dialog`; the content of the chosen path is read/written by
//! these commands. The path is only ever the one the user picked in the dialog — the
//! full-fs plugin permission is deliberately NOT granted.

use crate::error::AriadneError;

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, AriadneError> {
    std::fs::read_to_string(&path)
        .map_err(|e| AriadneError::internal(format!("Couldn't read {path}: {e}")))
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), AriadneError> {
    std::fs::write(&path, content)
        .map_err(|e| AriadneError::internal(format!("Couldn't write {path}: {e}")))
}
