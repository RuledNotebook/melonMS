// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use serde_json::Value;
use sidecar::SidecarStatus;

#[tauri::command]
async fn sidecar_status() -> Result<SidecarStatus, String> {
    Ok(sidecar::status().await)
}

#[tauri::command]
async fn sidecar_call(command: String, params: Value) -> Result<Value, String> {
    sidecar::call(&command, params).await
}

fn main() {
    // Spawn the Python sidecar as part of app boot. If it fails we still let
    // the UI render so the user sees a clear error in the status bar instead
    // of a silent failure.
    if let Err(e) = sidecar::start() {
        eprintln!("[main] sidecar start failed: {e}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![sidecar_status, sidecar_call])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
