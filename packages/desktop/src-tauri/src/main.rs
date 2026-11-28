//! M3-A4 Tauri v2 shell entry point (`packages/desktop`).
//! Thin IPC bridge to `@madc/engine` over `$MADC_HOME/engine.sock` via `madc-engine serve`.
//! Holds no agent loop, no tools, and no credentials (`PLAN-madc-M3-build-plan.md` §1).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launcher;

#[cfg(not(unix))]
use launcher::{validate_rpc_method, validate_rpc_params};
use launcher::{ConnectionInfo, LaunchConfig};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(unix)]
struct TauriEventSink(AppHandle);

#[cfg(unix)]
impl launcher::EventSink for TauriEventSink {
    fn emit_engine_event(&self, payload: Value) -> Result<(), String> {
        self.0
            .emit("madc:engine-event", payload)
            .map_err(|e| format!("emit madc:engine-event failed: {e}"))
    }

    fn emit_quit_requested(&self, payload: Value) -> Result<(), String> {
        self.0
            .emit("madc:quit-requested", payload)
            .map_err(|e| format!("emit madc:quit-requested failed: {e}"))
    }
}

#[cfg(unix)]
struct EngineState(Arc<launcher::DesktopController>);

#[cfg(not(unix))]
struct EngineState;

#[tauri::command]
async fn connect_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
) -> Result<ConnectionInfo, String> {
    #[cfg(unix)]
    {
        let ctrl = Arc::clone(&state.0);
        let sink: Arc<dyn launcher::EventSink> = Arc::new(TauriEventSink(app));
        tauri::async_runtime::spawn_blocking(move || {
            let config = LaunchConfig::from_env()?;
            ctrl.connect_engine_blocking(&config, sink)
        })
        .await
        .map_err(|e| format!("connect task failed: {e}"))?
    }
    #[cfg(not(unix))]
    {
        let _ = (app, state);
        Err("Windows named-pipe desktop transport is unverified in M3-A2".to_string())
    }
}

#[tauri::command]
async fn rpc_request(
    state: State<'_, EngineState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    #[cfg(unix)]
    {
        let ctrl = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || ctrl.rpc_request_blocking(&method, params))
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
        let ctrl = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || ctrl.disconnect_engine_blocking())
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
    #[cfg(unix)]
    let state = EngineState(Arc::new(launcher::DesktopController::new()));
    #[cfg(not(unix))]
    let state = EngineState;

    let app = tauri::Builder::default()
        .manage(state)
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
                let _ = state.0.disconnect_engine_blocking();
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
        let ctrl = launcher::DesktopController::new();
        let denied = ctrl
            .rpc_request_blocking("thread/resume", json!({}))
            .expect_err("disallowed method must fail allowlist check");
        assert!(
            denied.contains("not allowed"),
            "expected 'not allowed' error, got: {denied}"
        );
        assert!(
            !denied.contains("not connected"),
            "allowlist must run before connection check, got: {denied}"
        );

        let r5_err = ctrl
            .rpc_request_blocking(
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

        let allowed = ctrl
            .rpc_request_blocking("room/inspect", json!({}))
            .expect_err("allowed method with no client should reach connection check");
        assert!(
            allowed.contains("not connected"),
            "expected 'not connected' for allowed method, got: {allowed}"
        );

        // Connected peer test: R5 leaves the socket open for subsequent room/inspect.
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
        *ctrl.client.lock().unwrap() = Some(client);
        let refused = ctrl
            .rpc_request_blocking(
                "turn/start",
                json!({
                    "threadId": "thr_1",
                    "input": [{ "type": "text", "text": "ping" }],
                    "mode": "interactive"
                }),
            )
            .expect_err("R5 must refuse mode=interactive");
        assert!(refused.starts_with("RPC params refused by desktop shell for turn/start: "));
        assert!(
            ctrl.client.lock().unwrap().as_ref().unwrap().is_open(),
            "client must remain connected"
        );

        let ok = ctrl
            .rpc_request_blocking("room/inspect", json!({}))
            .expect("subsequent room/inspect must succeed on same socket");
        assert_eq!(ok["room"]["counts"]["threads"], 0);
        let _ = ctrl.disconnect_engine_blocking();
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }
}
