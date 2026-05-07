//! Python sidecar lifecycle manager.
//!
//! Spawns python/sidecar.py once per app launch and brokers JSON-stdio
//! requests on top of newline-delimited JSON. We use std::process here
//! (instead of tauri::api::process::Command) so the Tauri 2 sidecar feature
//! flag is not required and the existing system Python venv from
//! troponin-experiments can be reused unchanged.
//!
//! Each request gets a UUID so concurrent invocations from the front-end
//! can de-multiplex responses. The reader thread routes each response to a
//! pending oneshot::Sender keyed by UUID.

use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::thread;

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarStatus {
    Absent,
    Starting,
    Ready { commands: Vec<String> },
    Busy { command: String },
    Error { message: String },
}

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    id: Option<String>,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
    /// Set on the initial "ready" event the sidecar emits at start-up.
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    commands: Option<Vec<String>>,
}

pub struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    status: Mutex<SidecarStatus>,
    _child: Mutex<Child>,
}

static SIDECAR: OnceCell<Arc<Sidecar>> = OnceCell::new();

/// Resolve the absolute path of the Python interpreter that should run the
/// sidecar. Order of resolution:
///   1) TRP_TDMS_PYTHON env var (escape hatch)
///   2) ../troponin-experiments/.venv/Scripts/python(.exe) (Windows dev)
///   3) ../troponin-experiments/.venv/bin/python           (Mac/Linux dev)
///   4) "python3" / "python" on PATH
fn resolve_python(app_root: &Path) -> PathBuf {
    if let Ok(p) = env::var("TRP_TDMS_PYTHON") {
        return PathBuf::from(p);
    }
    let venv_root = app_root
        .parent()
        .unwrap_or(app_root)
        .join("troponin-experiments")
        .join(".venv");

    let candidates = [
        venv_root.join("Scripts").join("python.exe"),
        venv_root.join("Scripts").join("python"),
        venv_root.join("bin").join("python3"),
        venv_root.join("bin").join("python"),
    ];
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    if cfg!(target_os = "windows") {
        PathBuf::from("python")
    } else {
        PathBuf::from("python3")
    }
}

/// Determine the directory that contains src-tauri/, python/, etc.
/// During `tauri dev` the cwd is src-tauri; in production the binary lives
/// elsewhere and we resolve relative to the executable.
fn resolve_app_root() -> PathBuf {
    if let Ok(cwd) = env::current_dir() {
        // src-tauri/ during dev: jump up one
        if cwd.join("python").join("sidecar.py").exists() {
            return cwd;
        }
        if cwd.parent().map(|p| p.join("python").join("sidecar.py").exists()).unwrap_or(false) {
            return cwd.parent().unwrap().to_path_buf();
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Walk up looking for python/sidecar.py
            let mut p = parent.to_path_buf();
            for _ in 0..6 {
                if p.join("python").join("sidecar.py").exists() {
                    return p;
                }
                if !p.pop() {
                    break;
                }
            }
        }
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn start() -> Result<(), String> {
    if SIDECAR.get().is_some() {
        return Ok(());
    }

    let app_root = resolve_app_root();
    let python = resolve_python(&app_root);
    let script = app_root.join("python").join("sidecar.py");

    if !script.exists() {
        return Err(format!(
            "sidecar script not found at {} (resolved app_root={})",
            script.display(),
            app_root.display()
        ));
    }

    eprintln!("[sidecar-rs] python={}", python.display());
    eprintln!("[sidecar-rs] script={}", script.display());

    let mut cmd = Command::new(&python);
    cmd.arg("-u")
        .arg(&script)
        .current_dir(&app_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Hide the console window when launching python on Windows so users
    // don't see a flash of black. On Mac/Linux this flag has no effect.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn python sidecar: {e}"))?;

    let stdout = child.stdout.take().ok_or_else(|| "missing stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "missing stderr".to_string())?;
    let stdin = child.stdin.take().ok_or_else(|| "missing stdin".to_string())?;

    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let pending_for_reader = pending.clone();
    let sidecar = Arc::new(Sidecar {
        stdin: Mutex::new(stdin),
        pending,
        status: Mutex::new(SidecarStatus::Starting),
        _child: Mutex::new(child),
    });

    let sidecar_clone = sidecar.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[sidecar-rs] stdout read error: {e}");
                    break;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed: SidecarResponse = match serde_json::from_str(trimmed) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[sidecar-rs] failed to parse line: {e} :: {trimmed}");
                    continue;
                }
            };

            // Initial ready event has no id; it just announces capabilities.
            if parsed.event.as_deref() == Some("ready") {
                let cmds = parsed.commands.unwrap_or_default();
                eprintln!("[sidecar-rs] ready with {} commands", cmds.len());
                let sc = sidecar_clone.clone();
                tokio::runtime::Handle::try_current()
                    .ok()
                    .map(|h| h.spawn(async move {
                        *sc.status.lock().await = SidecarStatus::Ready { commands: cmds };
                    }));
                continue;
            }

            if let Some(id) = parsed.id {
                let payload = if parsed.ok {
                    json!({ "ok": true, "result": parsed.result.unwrap_or(Value::Null) })
                } else {
                    json!({ "ok": false, "error": parsed.error.unwrap_or(Value::Null) })
                };
                let pending = pending_for_reader.clone();
                tokio::runtime::Handle::try_current().ok().map(|h| {
                    h.spawn(async move {
                        if let Some(tx) = pending.lock().await.remove(&id) {
                            let _ = tx.send(payload);
                        }
                    })
                });
            }
        }
        eprintln!("[sidecar-rs] reader thread exiting");
    });

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[sidecar.py] {line}");
        }
    });

    SIDECAR
        .set(sidecar)
        .map_err(|_| "sidecar already set".to_string())?;
    Ok(())
}

pub async fn status() -> SidecarStatus {
    match SIDECAR.get() {
        None => SidecarStatus::Absent,
        Some(s) => s.status.lock().await.clone(),
    }
}

pub async fn call(command: &str, params: Value) -> Result<Value, String> {
    let sc = SIDECAR
        .get()
        .ok_or_else(|| "sidecar not started".to_string())?
        .clone();

    let id = uuid::Uuid::new_v4().to_string();
    let req = json!({
        "id": id,
        "command": command,
        "params": params,
    });
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";

    let (tx, rx) = oneshot::channel();
    sc.pending.lock().await.insert(id.clone(), tx);

    {
        let mut stdin = sc.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("sidecar stdin write failed: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("sidecar stdin flush failed: {e}"))?;
    }

    {
        let mut s = sc.status.lock().await;
        *s = SidecarStatus::Busy {
            command: command.to_string(),
        };
    }

    let resp = rx
        .await
        .map_err(|_| "sidecar response channel closed".to_string())?;

    // After completion, restore Ready so UI badge resets. We don't know the
    // actual command set here, so we leave the existing one in place if it
    // was already populated.
    {
        let mut s = sc.status.lock().await;
        if let SidecarStatus::Busy { .. } = *s {
            *s = SidecarStatus::Ready {
                commands: vec!["load_spectrum".to_string(), "ping".to_string()],
            };
        }
    }

    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        Ok(resp
            .get("result")
            .cloned()
            .unwrap_or(Value::Null))
    } else {
        let err = resp
            .get("error")
            .cloned()
            .unwrap_or_else(|| json!({"message": "unknown error"}));
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error")
            .to_string();
        let ty = err
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("Error");
        Err(format!("{ty}: {msg}"))
    }
}
