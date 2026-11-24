//! M3-A2 Tauri v2 shell entry point (`packages/desktop`).
//! Thin IPC bridge to `@madc/engine` over `$MADC_HOME/engine.sock` via `madc-engine serve`.
//! Holds no agent loop, no tools, and no credentials (`PLAN-madc-M3-build-plan.md` §1).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launcher;

use launcher::{ConnectionInfo, LaunchConfig};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

#[cfg(unix)]
struct EngineState(Mutex<Option<launcher::SocketClient>>);

#[cfg(not(unix))]
struct EngineState(Mutex<Option<()>>);

#[tauri::command]
fn connect_engine(state: State<'_, EngineState>) -> Result<ConnectionInfo, String> {
    #[cfg(unix)]
    {
        let mut guard = state
            .0
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
    }
    #[cfg(not(unix))]
    {
        let _ = state;
        Err("Windows named-pipe desktop transport is unverified in M3-A2".to_string())
    }
}

#[tauri::command]
fn rpc_request(
    state: State<'_, EngineState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    #[cfg(unix)]
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "engine state lock poisoned".to_string())?;
        let client = guard
            .as_mut()
            .ok_or_else(|| "not connected to @madc/engine".to_string())?;
        client.request(&method, params)
    }
    #[cfg(not(unix))]
    {
        let _ = (state, method, params);
        Err("Windows named-pipe desktop transport is unverified in M3-A2".to_string())
    }
}

#[tauri::command]
fn disconnect_engine(state: State<'_, EngineState>) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "engine state lock poisoned".to_string())?;
        if let Some(client) = guard.take() {
            client.disconnect();
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = state;
        Ok(())
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(EngineState(Mutex::new(None)))
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
                        client.disconnect();
                    }
                }
            }
        }
    });
}
