//! M3-A2 Tauri v2 shell entry point (`packages/desktop`).
//! Thin IPC bridge to `@madc/engine` over `$MADC_HOME/engine.sock` via `madc-engine serve`.
//! Holds no agent loop, no tools, and no credentials (`PLAN-madc-M3-build-plan.md` §1).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launcher;

use launcher::{validate_rpc_method, validate_rpc_params, ConnectionInfo, LaunchConfig};
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

#[cfg(unix)]
fn rpc_request_blocking(
    shared: &Mutex<Option<launcher::SocketClient>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    validate_rpc_method(method)?;
    validate_rpc_params(method, &params)?;
    let mut guard = shared
        .lock()
        .map_err(|_| "engine state lock poisoned".to_string())?;
    let client = guard
        .as_mut()
        .ok_or_else(|| "not connected to @madc/engine".to_string())?;
    client.request(method, params)
}

#[tauri::command]
async fn rpc_request(
    state: State<'_, EngineState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    #[cfg(unix)]
    {
        let shared = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || rpc_request_blocking(&shared, &method, params))
            .await
            .map_err(|e| format!("rpc task failed: {e}"))?
    }
    #[cfg(not(unix))]
    {
        validate_rpc_method(&method)?;
        validate_rpc_params(&method, &params)?;
        let _ = (state, params);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    #[test]
    fn rpc_request_blocking_enforces_allowlist_and_r5_before_lock_and_keeps_socket_open() {
        let state: Mutex<Option<launcher::SocketClient>> = Mutex::new(None);
        let denied = rpc_request_blocking(&state, "thread/resume", json!({}))
            .expect_err("disallowed method must fail allowlist check");
        assert!(
            denied.contains("not allowed"),
            "expected 'not allowed' error, got: {denied}"
        );
        assert!(
            !denied.contains("not connected"),
            "allowlist must run before connection check, got: {denied}"
        );

        let r5_err = rpc_request_blocking(
            &state,
            "turn/start",
            json!({
                "threadId": "thr_1",
                "input": [{ "type": "text", "text": "hi" }],
                "mode": "interactive"
            }),
        )
        .expect_err("invalid params must fail R5 before lock/connection check");
        assert!(
            r5_err.starts_with("RPC params refused by desktop shell for turn/start: "),
            "expected R5 prefix, got: {r5_err}"
        );

        let allowed = rpc_request_blocking(&state, "room/inspect", json!({}))
            .expect_err("allowed method with no client should reach connection check");
        assert!(
            allowed.contains("not connected"),
            "expected 'not connected' for allowed method, got: {allowed}"
        );

        let poisoned = Arc::new(Mutex::new(None::<launcher::SocketClient>));
        let poisoned_c = Arc::clone(&poisoned);
        let _ = std::thread::spawn(move || {
            let _g = poisoned_c.lock().unwrap();
            panic!("poison deliberately");
        })
        .join();
        assert!(rpc_request_blocking(&poisoned, "thread/handoff", json!({})).is_err());
        let r5_poisoned = rpc_request_blocking(&poisoned, "thread/start", json!({ "cwd": "rel" }))
            .expect_err("R5 must fire before poisoned mutex check");
        assert!(r5_poisoned.starts_with("RPC params refused by desktop shell for thread/start: "));

        let tmp = std::env::temp_dir().join(format!("madc-r5-open-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let peer = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let init_msg: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(init_msg["method"], "initialize");
            writeln!(
                writer,
                r#"{{"id":{},"result":{{"protocolVersion":"madc-m1/1","serverInfo":{{"name":"madc-engine","version":"0.0.0"}}}}}}"#,
                init_msg["id"]
            )
            .unwrap();
            writer.flush().unwrap();

            line.clear();
            let n = reader.read_line(&mut line).unwrap();
            assert!(n > 0, "socket closed unexpectedly after R5");
            let next_msg: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(next_msg["method"], "room/inspect");
            writeln!(
                writer,
                r#"{{"id":{},"result":{{"room":{{"home":"/tmp","threads":[],"counts":{{"threads":0,"pass":0,"warn":0,"fail":0,"openDecisions":0}}}}}}}}"#,
                next_msg["id"]
            )
            .unwrap();
            writer.flush().unwrap();
        });

        let client = launcher::SocketClient::connect_existing_for_test(tmp.to_str().unwrap())
            .expect("connect test socket");
        let conn_state = Mutex::new(Some(client));
        let refused = rpc_request_blocking(
            &conn_state,
            "turn/start",
            json!({
                "threadId": "thr_1",
                "input": [{ "type": "text", "text": "ping" }],
                "mode": "interactive"
            }),
        )
        .expect_err("R5 must refuse mode=interactive");
        assert!(refused.starts_with("RPC params refused by desktop shell for turn/start: "));
        assert!(conn_state.lock().unwrap().is_some(), "client must remain connected");

        let ok = rpc_request_blocking(&conn_state, "room/inspect", json!({}))
            .expect("subsequent room/inspect must succeed on same socket");
        assert_eq!(ok["room"]["counts"]["threads"], 0);
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }
}
