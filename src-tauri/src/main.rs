// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// All logic lives in `lib.rs`; `main` is only the entry point. Keeping it thin
// lets integration tests import the crate as `ariadne_lib::…`.
fn main() {
    ariadne_lib::run();
}
