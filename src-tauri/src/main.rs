// Release'te Windows'ta konsol penceresi açılmasın.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Tüm iş `lib.rs`'te (design 11 §R1); main yalnızca giriş noktasıdır.
fn main() {
    ariadne_lib::run();
}
