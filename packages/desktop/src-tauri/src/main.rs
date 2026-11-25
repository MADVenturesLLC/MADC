//! M3-A2 Tauri v2 shell entry point (`packages/desktop`).
//! Thin IPC bridge to `@madc/engine` over `$MADC_HOME/engine.sock` via `madc-engine serve`.
//! Holds no agent loop, no tools, and no credentials (`PLAN-madc-M3-build-plan.md` §1).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launcher;

use launcher::{validate_rpc_method, ConnectionInfo, LaunchConfig};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, State};

#[cfg(unix)]
struct EngineState(Arc<Mutex<Option<launcher::SocketClient>>>);

#[cfg(not(unix))]
struct EngineState(Arc<Mutex<Option<()>>>);

#[tauri::command]
async fn connect_engine(state: State<'_, EngineState>) -> Result<ConnectionInfo, String> {
    #[cfg(unix)]
    {
        let shared = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = shared
                .lock()
                .map_err(|_| "engine state lock poisoned".to_string())?;
            if let Some(existing) = guard.as_ref() {
                return Ok(existing.info.clone());
            }
            let config = LaunchConfig::from_env()?;
            let client = launcher::connect_or_spawn(&config)?;
            let info = client.info.clone();
            *guard = Some(client);
            Ok(info)
        })
        .await
        .map_err(|e| format!("connect task failed: {e}"))?
    }
    #[cfg(not(unix))]
    {
        let _ = state;
        Err("Windows named-pipe desktop transport is unverified in M3-A2".to_string())
    }
}

#[tauri::command]
async fn rpc_request(
    state: State<'_, EngineState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    validate_rpc_method(&method)?;
    #[cfg(unix)]
    {
        let shared = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = shared
                .lock()
                .map_err(|_| "engine state lock poisoned".to_string())?;
            let client = guard
                .as_mut()
                .ok_or_else(|| "not connected to @madc/engine".to_string())?;
            client.request(&method, params)
        })
        .await
        .map_err(|e| format!("rpc task failed: {e}"))?
    }
    #[cfg(not(unix))]
    {
        let _ = (state, method, params);
        Err("Windows named-pipe desktop transport is unverified in M3-A2".to_string())
    }
}

#[tauri::command]
async fn disconnect_engine(state: State<'_, EngineState>) -> Result<(), String> {
    #[cfg(unix)]
    {
        let shared = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = shared
                .lock()
                .map_err(|_| "engine state lock poisoned".to_string())?;
            if let Some(client) = guard.take() {
                client.disconnect();
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("disconnect task failed: {e}"))?
    }
    #[cfg(not(unix))]
    {
        let _ = state;
        Ok(())
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(EngineState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            connect_engine,
            rpc_request,
            disconnect_engine
        ])
        .build(tauri::generate_context!())
        .expect("error while building MADC Desktop");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            #[cfg(unix)]
            if let Some(state) = app_handle.try_state::<EngineState>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(client) = guard.take() {
                        // Bounded by `INITIALIZED_KILL_GRACE` (7 s) per amendment 1 §5.
                        client.disconnect();
                    }
                }
            }
        }
    });
}
