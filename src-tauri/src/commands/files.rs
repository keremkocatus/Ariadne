//! .sql dosya okuma/yazma (design 15 §P1-U4). Native dosya diyaloğu frontend'de
//! `@tauri-apps/plugin-dialog` ile açılır; seçilen yolun içeriği bu komutlarla
//! okunur/yazılır. Yol yalnız kullanıcının diyalogda seçtiği yoldur — bilinçli
//! olarak full-fs plugin izni verilmez (design 15 §P1-U4 riski).

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
