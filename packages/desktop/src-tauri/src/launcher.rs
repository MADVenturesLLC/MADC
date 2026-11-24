//! M3-A2 launcher for `madc-engine serve` (`docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`
//! §1, §2, §2a, §4, §5, §6).
//!
//! Connects over `$MADC_HOME/engine.sock` on POSIX (Windows named pipe unverified), never embeds
//! any agent loop, tools, or credentials, never auto-retries or respawns on failure, and never
//! removes `$MADC_HOME/engine.lock`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

pub const PROTOCOL_VERSION: &str = "madc-m1/1";
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
pub const START_WINDOW: Duration = Duration::from_secs(5);
pub const UNINITIALIZED_KILL_GRACE: Duration = Duration::from_secs(2);
pub const INITIALIZED_KILL_GRACE: Duration = Duration::from_secs(7);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub socket_path: String,
    pub reused_existing: bool,
    pub protocol_version: String,
    pub server_name: String,
    pub server_version: String,
    pub cold_start_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ServeExitClass {
    Clean { code: i32 },
    Stopped { code: Option<i32>, signal: Option<i32> },
    UsageOrHome { code: i32 },
    Owned { code: i32 },
    UnsafePath { code: i32 },
    ListenError { code: i32 },
    ShutdownDeadline { code: i32 },
    InternalFault { code: i32, raw_code: Option<i32> },
}

/// Classify a `madc-engine serve` exit per amendment 1 §6.
pub fn classify_exit(
    code: Option<i32>,
    signal: Option<i32>,
    launcher_killed: bool,
) -> ServeExitClass {
    if code.is_none() && signal.is_some() {
        return ServeExitClass::Stopped { code: None, signal };
    }
    #[cfg(windows)]
    if code == Some(1) && launcher_killed {
        return ServeExitClass::Stopped {
            code: Some(1),
            signal: None,
        };
    }
    #[cfg(not(windows))]
    let _ = launcher_killed;

    match code {
        Some(0) | Some(130) | Some(143) => ServeExitClass::Clean {
            code: code.unwrap(),
        },
        Some(2) => ServeExitClass::UsageOrHome { code: 2 },
        Some(20) => ServeExitClass::Owned { code: 20 },
        Some(21) => ServeExitClass::UnsafePath { code: 21 },
        Some(22) => ServeExitClass::ListenError { code: 22 },
        Some(23) => ServeExitClass::ShutdownDeadline { code: 23 },
        Some(24) => ServeExitClass::InternalFault {
            code: 24,
            raw_code: Some(24),
        },
        other => ServeExitClass::InternalFault {
            code: 24,
            raw_code: other,
        },
    }
}

/// Parse amendment 1 §2a's pinned exit-20 lock-holder reason line and build the manual recovery
/// message. The launcher never deletes `engine.lock`.
pub fn format_lock_owner_guidance(stderr_text: &str) -> Option<String> {
    const PREFIX: &str = "madc-engine serve: home owned by pid ";
    for line in stderr_text.lines().rev() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(PREFIX) {
            if let Some((pid_str, lock_path)) = rest.split_once(": ") {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if pid > 0 && !lock_path.is_empty() {
                        let check_hint = if cfg!(windows) {
                            format!("confirm in Task Manager no `madc-engine serve` process with PID {pid} is running")
                        } else {
                            format!("confirm no `madc-engine serve` process with PID {pid} is running (`ps -p {pid} -o command=`)")
                        };
                        return Some(format!(
                            "Home lock held by PID {pid} ({lock_path}). Manual recovery: (i) {check_hint}; (ii) if none is running, manually remove {lock_path}."
                        ));
                    }
                }
            }
        }
    }
    None
}

/// Resolve `$MADC_HOME` (absolute override or `$HOME/.madc`).
pub fn resolve_madc_home() -> Result<PathBuf, String> {
    if let Ok(override_val) = env::var("MADC_HOME") {
        if !override_val.is_empty() {
            let p = PathBuf::from(&override_val);
            if !p.is_absolute() {
                return Err("MADC_HOME must be an absolute path".to_string());
            }
            return Ok(p);
        }
    }
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|_| "cannot resolve HOME directory".to_string())?;
    Ok(PathBuf::from(home).join(".madc"))
}

/// Canonical socket/pipe path per amendment 1 §1 & §4.
/// Windows named pipe hashes canonicalized `MADC_HOME` (Windows branch is unverified in CI).
pub fn engine_socket_path(home: &Path) -> Result<String, String> {
    if cfg!(windows) {
        let canonical = std::fs::canonicalize(home)
            .map_err(|e| format!("Windows pipe realpath failed (home absent): {e}"))?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.to_string_lossy().as_bytes());
        let digest = hasher.finalize();
        let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        Ok(format!(r"\\.\pipe\madc-{hex}"))
    } else {
        Ok(home.join("engine.sock").to_string_lossy().into_owned())
    }
}

#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub home: PathBuf,
    pub runtime_bin: String,
    pub engine_entry: PathBuf,
}

impl LaunchConfig {
    pub fn from_env() -> Result<Self, String> {
        let home = resolve_madc_home()?;
        let runtime_bin = env::var("MADC_ENGINE_RUNTIME").unwrap_or_else(|_| "node".to_string());
        let engine_entry = if let Ok(explicit) = env::var("MADC_ENGINE_BIN") {
            PathBuf::from(explicit)
        } else {
            // Default relative to repo root (`packages/desktop/src-tauri` -> `packages/engine/src/bin.ts`).
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../engine/src/bin.ts")
        };
        Ok(Self {
            home,
            runtime_bin,
            engine_entry,
        })
    }
}

struct SpawnedServe {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_buf: Arc<Mutex<String>>,
    initialized: bool,
}

impl SpawnedServe {
    fn stderr_snapshot(&self) -> String {
        self.stderr_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    fn try_wait_status(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Stop `serve` per amendment 1 §5:
    /// - Initialized child: close stdin (EOF) first; wait up to 7 s before SIGKILL.
    /// - Never-initialized child: SIGTERM, then SIGKILL after 2 s.
    fn stop(&mut self) {
        if self.initialized {
            // Close stdin (EOF) first (§5 & §4 Windows).
            drop(self.stdin.take());
            let deadline = Instant::now() + INITIALIZED_KILL_GRACE;
            while Instant::now() < deadline {
                if self.try_wait_status().is_some() {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        } else {
            drop(self.stdin.take());
            #[cfg(unix)]
            unsafe {
                libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
            }
            let deadline = Instant::now() + UNINITIALIZED_KILL_GRACE;
            while Instant::now() < deadline {
                if self.try_wait_status().is_some() {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl Drop for SpawnedServe {
    fn drop(&mut self) {
        if self.try_wait_status().is_none() {
            self.stop();
        }
    }
}

#[cfg(unix)]
pub struct SocketClient {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
    spawned: Option<SpawnedServe>,
    pub info: ConnectionInfo,
}

#[cfg(unix)]
impl SocketClient {
    fn connect_and_initialize(
        socket_path: &str,
        timeout: Duration,
        reused_existing: bool,
        started_at: Instant,
    ) -> Result<Self, String> {
        let stream = UnixStream::connect(socket_path)
            .map_err(|e| format!("connect({socket_path}) failed: {e}"))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| format!("set_read_timeout failed: {e}"))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|e| format!("set_write_timeout failed: {e}"))?;

        let writer = stream
            .try_clone()
            .map_err(|e| format!("socket clone failed: {e}"))?;
        let mut client = Self {
            reader: BufReader::new(stream),
            writer,
            next_id: 1,
            spawned: None,
            info: ConnectionInfo {
                socket_path: socket_path.to_string(),
                reused_existing,
                protocol_version: String::new(),
                server_name: String::new(),
                server_version: String::new(),
                cold_start_ms: 0,
            },
        };

        let init_result = client.request(
            "initialize",
            json!({
                "clientInfo": { "name": "madc-desktop", "version": "0.0.0" },
                "capabilities": { "subscribeRoom": true }
            }),
        )?;

        let protocol_version = init_result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "protocol version mismatch: expected {PROTOCOL_VERSION}, got {protocol_version}"
            ));
        }

        let server_name = init_result
            .get("serverInfo")
            .and_then(|s| s.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("madc-engine")
            .to_string();
        let server_version = init_result
            .get("serverInfo")
            .and_then(|s| s.get("version"))
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();

        // Clear short probe timeout for subsequent interactive RPC calls (bounded to 10s).
        let _ = client.writer.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = client.writer.set_write_timeout(Some(Duration::from_secs(10)));
        let _ = client
            .reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(10)));

        client.info = ConnectionInfo {
            socket_path: socket_path.to_string(),
            reused_existing,
            protocol_version,
            server_name,
            server_version,
            cold_start_ms: started_at.elapsed().as_millis() as u64,
        };
        Ok(client)
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });
        let mut line = serde_json::to_string(&payload)
            .map_err(|e| format!("failed to serialize request: {e}"))?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .map_err(|e| format!("socket write failed: {e}"))?;
        self.writer
            .flush()
            .map_err(|e| format!("socket flush failed: {e}"))?;

        loop {
            let mut resp_line = String::new();
            let n = self
                .reader
                .read_line(&mut resp_line)
                .map_err(|e| format!("socket read failed: {e}"))?;
            if n == 0 {
                return Err("engine socket closed before response".to_string());
            }
            let trimmed = resp_line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: Value = serde_json::from_str(trimmed)
                .map_err(|e| format!("invalid JSON from engine: {e}"))?;
            // Skip asynchronous notifications while waiting for our matching response id.
            if msg.get("id").and_then(|v| v.as_u64()) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(format!("engine RPC error: {err}"));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    pub fn disconnect(mut self) {
        if let Some(mut s) = self.spawned.take() {
            s.stop();
        }
    }
}

/// Probe `$MADC_HOME/engine.sock` per amendment 1 §2, or spawn `madc-engine serve` per §1, §2, §5.
#[cfg(unix)]
pub fn connect_or_spawn(config: &LaunchConfig) -> Result<SocketClient, String> {
    let started_at = Instant::now();
    let socket_path = engine_socket_path(&config.home)?;

    // §2: Probe existing listener within 1 s (connect + initialize).
    if let Ok(client) =
        SocketClient::connect_and_initialize(&socket_path, PROBE_TIMEOUT, true, started_at)
    {
        return Ok(client);
    }

    // §1.3: Spawn `madc-engine serve` with piped stdin (held open), stdout null, piped stderr
    // drained for the whole life of `serve`.
    let mut child = Command::new(&config.runtime_bin)
        .arg(&config.engine_entry)
        .arg("serve")
        .env("MADC_HOME", &config.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn madc-engine serve: {e}"))?;

    let stdin = child.stdin.take();
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let buf_clone = Arc::clone(&stderr_buf);
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&chunk[..n]);
                        if let Ok(mut guard) = buf_clone.lock() {
                            guard.push_str(&s);
                        }
                    }
                }
            }
        });
    }

    let mut spawned = SpawnedServe {
        child,
        stdin,
        stderr_buf,
        initialized: false,
    };

    // §5: Wait up to 5 s for `initialize` to succeed over `engine.sock`.
    let deadline = Instant::now() + START_WINDOW;
    while Instant::now() < deadline {
        if let Some(status) = spawned.try_wait_status() {
            let code = status.code();
            let signal = status.signal();
            let class = classify_exit(code, signal, false);
            // §2 & §5: On child exit 20 before initialize, re-probe once until the 5 s window ends.
            if code == Some(20) {
                while Instant::now() < deadline {
                    let rem = deadline
                        .saturating_duration_since(Instant::now())
                        .min(PROBE_TIMEOUT);
                    if let Ok(client) = SocketClient::connect_and_initialize(
                        &socket_path,
                        rem.max(Duration::from_millis(50)),
                        true,
                        started_at,
                    ) {
                        return Ok(client);
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                let stderr_text = spawned.stderr_snapshot();
                if let Some(guidance) = format_lock_owner_guidance(&stderr_text) {
                    return Err(format!(
                        "madc-engine serve exited 20 ({class:?}). {guidance}\nstderr:\n{stderr_text}"
                    ));
                }
                return Err(format!(
                    "madc-engine serve exited 20 ({class:?}) and re-probe found no listener.\nstderr:\n{stderr_text}"
                ));
            }
            let stderr_text = spawned.stderr_snapshot();
            return Err(format!(
                "madc-engine serve exited before initialize (code={code:?}, signal={signal:?}, class={class:?}).\nstderr:\n{stderr_text}"
            ));
        }

        let rem = deadline
            .saturating_duration_since(Instant::now())
            .min(PROBE_TIMEOUT);
        if let Ok(mut client) = SocketClient::connect_and_initialize(
            &socket_path,
            rem.max(Duration::from_millis(50)),
            false,
            started_at,
        ) {
            spawned.initialized = true;
            client.spawned = Some(spawned);
            return Ok(client);
        }
        thread::sleep(Duration::from_millis(25));
    }

    // §5: Deadline passed without initialize -> SIGTERM, then SIGKILL after 2 s.
    spawned.stop();
    let stderr_text = spawned.stderr_snapshot();
    Err(format!(
        "madc-engine serve did not complete initialize within 5 s.\nstderr:\n{stderr_text}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_classification_matches_amendment_1_section_6() {
        assert_eq!(classify_exit(Some(0), None, false), ServeExitClass::Clean { code: 0 });
        assert_eq!(classify_exit(Some(130), None, false), ServeExitClass::Clean { code: 130 });
        assert_eq!(classify_exit(Some(143), None, false), ServeExitClass::Clean { code: 143 });
        assert_eq!(classify_exit(Some(2), None, false), ServeExitClass::UsageOrHome { code: 2 });
        assert_eq!(classify_exit(Some(20), None, false), ServeExitClass::Owned { code: 20 });
        assert_eq!(classify_exit(Some(21), None, false), ServeExitClass::UnsafePath { code: 21 });
        assert_eq!(classify_exit(Some(22), None, false), ServeExitClass::ListenError { code: 22 });
        assert_eq!(
            classify_exit(Some(23), None, false),
            ServeExitClass::ShutdownDeadline { code: 23 }
        );
        assert_eq!(
            classify_exit(Some(1), None, false),
            ServeExitClass::InternalFault {
                code: 24,
                raw_code: Some(1)
            }
        );
        assert_eq!(
            classify_exit(None, Some(9), false),
            ServeExitClass::Stopped {
                code: None,
                signal: Some(9)
            }
        );
    }

    #[test]
    fn parses_section_2a_lock_owner_guidance() {
        let stderr = "[madc-engine] starting\nmadc-engine serve: home owned by pid 9123: /tmp/h/engine.lock\n";
        let g = format_lock_owner_guidance(stderr).expect("guidance");
        assert!(g.contains("9123"));
        assert!(g.contains("/tmp/h/engine.lock"));
        assert!(g.contains("manually remove /tmp/h/engine.lock"));
    }

    #[cfg(unix)]
    #[test]
    fn cold_start_connects_to_real_madc_engine_serve_and_reuses_listener() {
        // Keep path well under macOS sun_path 104-byte limit (`env::temp_dir()` on macOS is ~49 bytes).
        let home = PathBuf::from(format!("/tmp/madc-dt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let runtime_bin = env::var("MADC_ENGINE_RUNTIME").unwrap_or_else(|_| "node".to_string());
        let engine_entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../engine/src/bin.ts");

        let cfg = LaunchConfig {
            home: home.clone(),
            runtime_bin,
            engine_entry,
        };

        // 1. Cold start from fresh empty $MADC_HOME: spawns serve, initializes madc-m1/1.
        let mut c1 = connect_or_spawn(&cfg).expect("cold-start connect_or_spawn");
        assert!(!c1.info.reused_existing, "first launch must spawn serve");
        assert_eq!(c1.info.protocol_version, PROTOCOL_VERSION);
        assert!(c1.info.cold_start_ms < 5000, "cold start within 5 s window");
        println!(
            "cold-start verified: protocol={}, cold_start_ms={}",
            c1.info.protocol_version, c1.info.cold_start_ms
        );

        let room = c1.request("room/inspect", json!({})).expect("room/inspect");
        assert!(room.get("room").is_some());

        // 2. Second launcher reuses the live listener without spawning.
        let mut c2 = connect_or_spawn(&cfg).expect("second launcher reuse");
        assert!(c2.info.reused_existing, "second launch must reuse live listener");
        let room2 = c2.request("room/inspect", json!({})).expect("room/inspect 2");
        assert!(room2.get("room").is_some());
        c2.disconnect();

        // 3. Disconnecting the owner closes serve's stdin -> clean exit 0 & cleanup.
        let sock = home.join("engine.sock");
        let lock = home.join("engine.lock");
        c1.disconnect();
        assert!(!sock.exists(), "engine.sock removed on clean shutdown");
        assert!(!lock.exists(), "engine.lock removed on clean shutdown");
        let _ = std::fs::remove_dir_all(&home);
    }
}
