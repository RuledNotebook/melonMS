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

/// Mac-native folder picker. We bypass `tauri-plugin-dialog` here because
/// `objc2-app-kit 0.3.2` panics with "unexpected NULL returned from
/// +[NSOpenPanel openPanel]" when called inside our process on some Mac
/// configurations. Shelling out to `osascript`'s `choose folder` runs
/// the picker in a separate process that has its own NSApp state, so
/// it works reliably without changing our app's activation policy.
///
/// Returns:
///   Ok(Some(path))  user picked a folder
///   Ok(None)        user cancelled
///   Err(msg)        osascript itself failed (extremely rare on Mac)
#[tauri::command]
async fn pick_folder(title: Option<String>) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let prompt = title.unwrap_or_else(|| {
            "Select a Bruker .d folder, or a folder containing multiple".to_string()
        });
        // AppleScript escapes: only " needs care for our prompt strings.
        let safe_prompt = prompt.replace('"', "\\\"");
        // `tell System Events to activate` puts a real bundled process in
        // the foreground so the dialog parents to it visibly. Bare
        // `activate` activates osascript itself, which has no bundle ID
        // and on macOS 15+ the dialog ends up hidden behind the Tauri
        // window. `default location` forces the panel to render at a
        // non-zero initial size.
        let script = format!(
            "tell application \"System Events\" to activate\n\
             return POSIX path of (choose folder with prompt \"{}\" default location (path to home folder))",
            safe_prompt
        );

        eprintln!("[pick_folder] running osascript with prompt: {prompt}");

        let output = tokio::task::spawn_blocking(move || {
            Command::new("osascript").args(["-e", &script]).output()
        })
        .await
        .map_err(|e| format!("osascript join error: {e}"))?
        .map_err(|e| format!("osascript spawn error: {e}"))?;

        eprintln!(
            "[pick_folder] exit={:?} stdout={:?} stderr={:?}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim(),
        );

        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                return Ok(None);
            }
            return Ok(Some(path));
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        // -128 is the standard user-cancelled error code in AppleScript.
        if stderr.contains("-128") || stderr.to_lowercase().contains("user canceled") {
            return Ok(None);
        }
        Err(format!("osascript failed: {stderr}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = title;
        Err("pick_folder native command is Mac-only; use plugin-dialog elsewhere"
            .to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            sidecar_call,
            pick_folder,
        ])
        .setup(|app| {
            // Stash the AppHandle before spawning the sidecar so its reader
            // thread can emit front-end events (e.g. progress updates).
            sidecar::set_app_handle(app.handle().clone());
            if let Err(e) = sidecar::start() {
                eprintln!("[main] sidecar start failed: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
