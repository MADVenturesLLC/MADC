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
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
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
pub const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
pub const MAX_STDERR_RETAINED_BYTES: usize = 64 * 1024;
pub const INTERACTIVE_RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// M3-A2 desktop IPC method allowlist (read-only + handshake). Any method outside this set is
/// refused in Rust before touching the engine socket.
pub const ALLOWED_RPC_METHODS: &[&str] = &[
    "initialize",
    "room/inspect",
    "session/search",
    "session/read",
];

pub fn validate_rpc_method(method: &str) -> Result<(), String> {
    if ALLOWED_RPC_METHODS.contains(&method) {
        Ok(())
    } else {
        Err(format!("RPC method not allowed by M3-A2 desktop shell: {method}"))
    }
}

/// Append a chunk to the retained stderr buffer while keeping only the tail within `max_bytes`
/// on a valid UTF-8 boundary. The drain thread continues reading until EOF so `serve` never
/// blocks on a full stderr pipe (§1.3).
pub fn push_stderr_capped(buf: &mut String, chunk: &str, max_bytes: usize) {
    buf.push_str(chunk);
    if buf.len() > max_bytes {
        let mut cut = buf.len() - max_bytes;
        while cut < buf.len() && !buf.is_char_boundary(cut) {
            cut += 1;
        }
        buf.drain(..cut);
    }
}

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

/// Strip Rust's Windows verbatim prefix (`\\?\` or `\\?\UNC\`) so the canonical path matches
/// Node's `fs.realpathSync.native(MADC_HOME)` before SHA-256 hashing (amendment 1 §2 / §4).
/// Windows named-pipe transport remains unverified in CI.
pub fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Compute the Windows named pipe path from a canonicalized `MADC_HOME` string.
pub fn windows_pipe_name_from_realpath(canonical_path: &str) -> String {
    let normalized = strip_windows_verbatim_prefix(canonical_path);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!(r"\\.\pipe\madc-{hex}")
}

/// Canonical socket/pipe path per amendment 1 §1, §2 & §4.
/// Returns `Ok(None)` on Windows when `$MADC_HOME` does not exist yet (pin line 50: no listener
/// can exist yet, so the caller skips the probe and spawns `serve`).
/// Windows branch is unverified in CI.
pub fn try_engine_socket_path(home: &Path) -> Result<Option<String>, String> {
    if cfg!(windows) {
        match std::fs::canonicalize(home) {
            Ok(canonical) => Ok(Some(windows_pipe_name_from_realpath(
                &canonical.to_string_lossy(),
            ))),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Windows pipe realpath failed: {e}")),
        }
    } else {
        Ok(Some(home.join("engine.sock").to_string_lossy().into_owned()))
    }
}

/// Canonical socket/pipe path when `$MADC_HOME` is expected to exist.
#[allow(dead_code)]
pub fn engine_socket_path(home: &Path) -> Result<String, String> {
    try_engine_socket_path(home)?
        .ok_or_else(|| "Windows pipe realpath failed (home absent)".to_string())
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
    stderr_done: Option<mpsc::Receiver<()>>,
    stderr_thread: Option<thread::JoinHandle<()>>,
    initialized: bool,
}

impl SpawnedServe {
    /// Wait (bounded by `timeout`, pattern 1) for the stderr drain thread to observe EOF and
    /// return the retained tail of drained stderr text.
    fn drain_stderr(&mut self, timeout: Duration) -> String {
        if let Some(rx) = self.stderr_done.take() {
            if rx.recv_timeout(timeout).is_ok() {
                if let Some(handle) = self.stderr_thread.take() {
                    let _ = handle.join();
                }
            } else {
                // Bounded wait expired (e.g. a grandchild kept stderr open): detach rather than hang.
                let _ = self.stderr_thread.take();
            }
        }
        self.stderr_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    fn try_wait_status(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Stop `serve` per amendment 1 §5 and return its exit status once reaped:
    /// - Initialized child: close stdin (EOF) first; wait up to 7 s before SIGKILL.
    /// - Never-initialized child: on Unix, SIGTERM first (keeping stdin open so the signal wins
    ///   as first trigger), then SIGKILL after 2 s; on Windows, close stdin first.
    fn stop(&mut self) -> Option<ExitStatus> {
        if self.initialized {
            // Close stdin (EOF) first (§5 & §4 Windows).
            drop(self.stdin.take());
            let deadline = Instant::now() + INITIALIZED_KILL_GRACE;
            while Instant::now() < deadline {
                if let Some(status) = self.try_wait_status() {
                    return Some(status);
                }
                thread::sleep(Duration::from_millis(20));
            }
            let _ = self.child.kill();
            self.child.wait().ok()
        } else {
            #[cfg(not(unix))]
            drop(self.stdin.take());
            #[cfg(unix)]
            unsafe {
                libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
            }
            let deadline = Instant::now() + UNINITIALIZED_KILL_GRACE;
            while Instant::now() < deadline {
                if let Some(status) = self.try_wait_status() {
                    drop(self.stdin.take());
                    return Some(status);
                }
                thread::sleep(Duration::from_millis(20));
            }
            let _ = self.child.kill();
            let status = self.child.wait().ok();
            drop(self.stdin.take());
            status
        }
    }
}

impl Drop for SpawnedServe {
    fn drop(&mut self) {
        if self.try_wait_status().is_none() {
            let _ = self.stop();
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
fn connect_unix_with_deadline_using<F>(
    socket_path: &str,
    deadline: Instant,
    connector: F,
) -> Result<UnixStream, String>
where
    F: FnOnce(&str) -> std::io::Result<UnixStream> + Send + 'static,
{
    let rem = deadline.saturating_duration_since(Instant::now());
    if rem.is_zero() {
        return Err(format!("connect({socket_path}) timed out before connect"));
    }
    let path_owned = socket_path.to_string();
    let (tx, rx) = mpsc::sync_channel::<std::io::Result<UnixStream>>(1);
    thread::spawn(move || {
        let res = connector(&path_owned);
        // If the caller already timed out and dropped `rx`, `send` fails and drops any late
        // `UnixStream` cleanly rather than leaking the fd.
        let _ = tx.send(res);
    });
    match rx.recv_timeout(rem) {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => Err(format!("connect({socket_path}) failed: {e}")),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("connect({socket_path}) timed out")),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(format!("connect({socket_path}) thread exited unexpectedly"))
        }
    }
}

#[cfg(unix)]
impl SocketClient {
    /// Connect and run `initialize` within ONE total deadline (`timeout`), matching amendment 1
    /// §2 line 47 ("within 1 s (connect plus reply)").
    fn connect_and_initialize(
        socket_path: &str,
        timeout: Duration,
        reused_existing: bool,
        started_at: Instant,
    ) -> Result<Self, String> {
        Self::connect_and_initialize_with_connector(
            socket_path,
            timeout,
            reused_existing,
            started_at,
            |p| UnixStream::connect(p),
        )
    }

    fn connect_and_initialize_with_connector<F>(
        socket_path: &str,
        timeout: Duration,
        reused_existing: bool,
        started_at: Instant,
        connector: F,
    ) -> Result<Self, String>
    where
        F: FnOnce(&str) -> std::io::Result<UnixStream> + Send + 'static,
    {
        let deadline = Instant::now() + timeout;
        let stream = connect_unix_with_deadline_using(socket_path, deadline, connector)?;

        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() {
            return Err("initialize probe timed out after connect".to_string());
        }
        stream
            .set_read_timeout(Some(rem))
            .map_err(|e| format!("set_read_timeout failed: {e}"))?;
        stream
            .set_write_timeout(Some(rem))
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

        let init_result = client.request_with_deadline(
            "initialize",
            json!({
                "clientInfo": { "name": "madc-desktop", "version": "0.0.0" },
                "capabilities": { "subscribeRoom": true }
            }),
            deadline,
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

        // Set interactive timeout for subsequent RPC calls.
        let _ = client.writer.set_read_timeout(Some(INTERACTIVE_RPC_TIMEOUT));
        let _ = client.writer.set_write_timeout(Some(INTERACTIVE_RPC_TIMEOUT));
        let _ = client
            .reader
            .get_ref()
            .set_read_timeout(Some(INTERACTIVE_RPC_TIMEOUT));

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
        self.request_with_deadline(method, params, Instant::now() + INTERACTIVE_RPC_TIMEOUT)
    }

    fn request_with_deadline(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
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

        let write_rem = deadline.saturating_duration_since(Instant::now());
        if write_rem.is_zero() {
            return Err(format!("RPC {method} timed out before write"));
        }
        self.writer
            .set_write_timeout(Some(write_rem))
            .map_err(|e| format!("set_write_timeout failed: {e}"))?;
        self.writer
            .write_all(line.as_bytes())
            .map_err(|e| format!("socket write failed: {e}"))?;
        self.writer
            .flush()
            .map_err(|e| format!("socket flush failed: {e}"))?;

        loop {
            let read_rem = deadline.saturating_duration_since(Instant::now());
            if read_rem.is_zero() {
                return Err(format!("RPC {method} timed out waiting for reply"));
            }
            self.reader
                .get_ref()
                .set_read_timeout(Some(read_rem))
                .map_err(|e| format!("set_read_timeout failed: {e}"))?;

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
            let _ = s.stop();
        }
    }
}

/// Probe `$MADC_HOME/engine.sock` per amendment 1 §2, or spawn `madc-engine serve` per §1, §2, §5.
#[cfg(unix)]
pub fn connect_or_spawn(config: &LaunchConfig) -> Result<SocketClient, String> {
    connect_or_spawn_with_window(config, START_WINDOW)
}

#[cfg(unix)]
fn connect_or_spawn_with_window(
    config: &LaunchConfig,
    start_window: Duration,
) -> Result<SocketClient, String> {
    let started_at = Instant::now();

    // §2: Probe existing listener within 1 s (connect + initialize). If home does not exist yet
    // (Windows absent home, pin line 50), `try_engine_socket_path` returns Ok(None) and we spawn.
    if let Some(socket_path) = try_engine_socket_path(&config.home)? {
        if let Ok(client) =
            SocketClient::connect_and_initialize(&socket_path, PROBE_TIMEOUT, true, started_at)
        {
            return Ok(client);
        }
    }

    // §1.3: Spawn `madc-engine serve` with piped stdin (held open), stdout null, piped stderr
    // drained for the whole life of `serve` (retaining a bounded tail).
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
    let (done_tx, done_rx) = mpsc::sync_channel::<()>(1);
    let stderr_thread = child.stderr.take().map(|mut stderr| {
        let buf_clone = Arc::clone(&stderr_buf);
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&chunk[..n]);
                        if let Ok(mut guard) = buf_clone.lock() {
                            push_stderr_capped(&mut guard, &s, MAX_STDERR_RETAINED_BYTES);
                        }
                    }
                }
            }
            let _ = done_tx.send(());
        })
    });

    let mut spawned = SpawnedServe {
        child,
        stdin,
        stderr_buf,
        stderr_done: if stderr_thread.is_some() {
            Some(done_rx)
        } else {
            None
        },
        stderr_thread,
        initialized: false,
    };

    // §5: Wait up to `start_window` (5 s) for `initialize` to succeed over `engine.sock`.
    let deadline = Instant::now() + start_window;
    while Instant::now() < deadline {
        if let Some(status) = spawned.try_wait_status() {
            let code = status.code();
            let signal = status.signal();
            let class = classify_exit(code, signal, false);
            // §2 & §5: On child exit 20 before initialize, re-probe once until the start window ends.
            if code == Some(20) {
                while Instant::now() < deadline {
                    if let Ok(Some(socket_path)) = try_engine_socket_path(&config.home) {
                        let rem = deadline
                            .saturating_duration_since(Instant::now())
                            .min(PROBE_TIMEOUT);
                        if !rem.is_zero() {
                            if let Ok(client) = SocketClient::connect_and_initialize(
                                &socket_path,
                                rem,
                                true,
                                started_at,
                            ) {
                                return Ok(client);
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                let stderr_text = spawned.drain_stderr(STDERR_DRAIN_TIMEOUT);
                if let Some(guidance) = format_lock_owner_guidance(&stderr_text) {
                    return Err(format!(
                        "madc-engine serve exited 20 ({class:?}). {guidance}\nstderr:\n{stderr_text}"
                    ));
                }
                return Err(format!(
                    "madc-engine serve exited 20 ({class:?}) and re-probe found no listener.\nstderr:\n{stderr_text}"
                ));
            }
            let stderr_text = spawned.drain_stderr(STDERR_DRAIN_TIMEOUT);
            return Err(format!(
                "madc-engine serve exited before initialize (code={code:?}, signal={signal:?}, class={class:?}).\nstderr:\n{stderr_text}"
            ));
        }

        if let Ok(Some(socket_path)) = try_engine_socket_path(&config.home) {
            let rem = deadline
                .saturating_duration_since(Instant::now())
                .min(PROBE_TIMEOUT);
            if !rem.is_zero() {
                if let Ok(mut client) = SocketClient::connect_and_initialize(
                    &socket_path,
                    rem,
                    false,
                    started_at,
                ) {
                    spawned.initialized = true;
                    client.spawned = Some(spawned);
                    return Ok(client);
                }
            }
        }
        thread::sleep(Duration::from_millis(20));
    }

    // §5: Deadline passed without initialize -> SIGTERM, then SIGKILL after 2 s.
    // Report the child's exit status and drained stderr (pin §5 line 132).
    let status = spawned.stop();
    let code = status.and_then(|s| s.code());
    let signal = status.and_then(|s| s.signal());
    let stderr_text = spawned.drain_stderr(STDERR_DRAIN_TIMEOUT);
    Err(format!(
        "madc-engine serve did not complete initialize within {} ms (exit code={code:?}, signal={signal:?}).\nstderr:\n{stderr_text}",
        start_window.as_millis()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

    #[test]
    fn rpc_allowlist_permits_only_m3_a2_methods() {
        for allowed in ["initialize", "room/inspect", "session/search", "session/read"] {
            assert!(
                validate_rpc_method(allowed).is_ok(),
                "expected allowed method {allowed}"
            );
        }
        for denied in [
            "turn/start",
            "thread/start",
            "thread/resume",
            "thread/handoff",
            "decision/raise",
            "decision/resolve",
            "auth/set",
            "auth/remove",
            "room/inspect ",
            "",
        ] {
            let err = validate_rpc_method(denied).expect_err("expected disallowed method");
            assert!(err.contains("not allowed"), "unexpected err: {err}");
        }
    }

    #[test]
    fn windows_pipe_name_strips_verbatim_prefix_and_matches_node_sha256() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\m\.madc"),
            r"C:\Users\m\.madc"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\.madc"),
            r"\\server\share\.madc"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"C:\Users\m\.madc"),
            r"C:\Users\m\.madc"
        );

        let from_verbatim = windows_pipe_name_from_realpath(r"\\?\C:\Users\m\.madc");
        let from_plain = windows_pipe_name_from_realpath(r"C:\Users\m\.madc");
        assert_eq!(
            from_verbatim, from_plain,
            "verbatim \\\\?\\ prefix must hash identically to Node realpathSync.native"
        );
        assert!(from_plain.starts_with(r"\\.\pipe\madc-"));
        assert_eq!(from_plain.len(), r"\\.\pipe\madc-".len() + 16);
    }

    #[test]
    fn stderr_retention_caps_to_tail_and_preserves_final_reason_line() {
        let mut buf = String::new();
        let filler = "x".repeat(4096);
        for _ in 0..32 {
            push_stderr_capped(&mut buf, &filler, MAX_STDERR_RETAINED_BYTES);
        }
        let reason = "\nmadc-engine serve: home owned by pid 7777: /tmp/h/engine.lock\n";
        push_stderr_capped(&mut buf, reason, MAX_STDERR_RETAINED_BYTES);
        assert!(
            buf.len() <= MAX_STDERR_RETAINED_BYTES,
            "buf len {} exceeded cap {}",
            buf.len(),
            MAX_STDERR_RETAINED_BYTES
        );
        let guidance = format_lock_owner_guidance(&buf).expect("final reason line preserved in tail");
        assert!(guidance.contains("7777"));
        assert!(guidance.contains("/tmp/h/engine.lock"));
    }

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
    fn connect_and_initialize_enforces_single_total_deadline_across_chatty_reads() {
        let home = PathBuf::from(format!("/tmp/madc-dt-l1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");
        let sock_path = home.join("engine.sock");
        let listener = UnixListener::bind(&sock_path).expect("bind test listener");

        let server_thread = thread::spawn(move || {
            if let Ok((mut conn, _)) = listener.accept() {
                // Keep sending asynchronous notifications every 40 ms without ever replying to
                // `initialize`. A per-read timeout would reset on every notification and wait
                // forever; one total deadline must terminate within ~250 ms.
                for _ in 0..40 {
                    let note = "{\"method\":\"room/updated\",\"params\":{\"reason\":\"thread\",\"threadId\":\"thr_1\"}}\n";
                    if conn.write_all(note.as_bytes()).is_err() {
                        break;
                    }
                    let _ = conn.flush();
                    thread::sleep(Duration::from_millis(40));
                }
            }
        });

        let started = Instant::now();
        let res = SocketClient::connect_and_initialize(
            &sock_path.to_string_lossy(),
            Duration::from_millis(250),
            true,
            started,
        );
        let elapsed = started.elapsed();
        assert!(res.is_err(), "expected timeout against chatty server");
        assert!(
            elapsed < Duration::from_millis(600),
            "single total deadline exceeded: elapsed={elapsed:?}"
        );

        let _ = server_thread.join();
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn connect_and_initialize_bounds_connect_on_full_backlog_and_stalled_connect_l1() {
        // 1. Cross-platform Unix check (macOS + Linux): a stalled connect respects the single
        //    deadline and returns Err within deadline + 500 ms (never hangs).
        {
            let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
            let probe_timeout = Duration::from_millis(200);
            let watchdog_timeout = probe_timeout + Duration::from_millis(800);
            let (done_tx, done_rx) = mpsc::sync_channel::<Result<(), String>>(1);

            let t0 = Instant::now();
            thread::spawn(move || {
                let res = SocketClient::connect_and_initialize_with_connector(
                    "/tmp/madc-dt-l1-stall.sock",
                    probe_timeout,
                    true,
                    Instant::now(),
                    move |_| {
                        let _ = release_rx.recv_timeout(Duration::from_secs(5));
                        Err(std::io::Error::new(ErrorKind::TimedOut, "stalled"))
                    },
                )
                .map(|_| ());
                let _ = done_tx.send(res);
            });

            let result = done_rx.recv_timeout(watchdog_timeout);
            let elapsed = t0.elapsed();
            let _ = release_tx.send(());
            let err = result
                .expect("connect_and_initialize hung past watchdog timeout")
                .expect_err("expected Err on stalled connect");
            assert!(
                err.contains("timed out"),
                "expected connect timeout error, got: {err}"
            );
            assert!(
                elapsed < probe_timeout + Duration::from_millis(500),
                "stalled connect exceeded deadline + 500 ms: elapsed={elapsed:?}"
            );
        }

        // 2. Full AF_UNIX listen backlog (backlog=1, never accept): on Linux, a blocking
        //    `UnixStream::connect` waits in the kernel once the backlog is full; on macOS/XNU it
        //    returns ECONNREFUSED immediately. Both platforms compile and exercise the exact
        //    `connect_and_initialize` path under a bounded watchdog.
        struct RawFdGuard(libc::c_int);
        impl Drop for RawFdGuard {
            fn drop(&mut self) {
                unsafe {
                    libc::close(self.0);
                }
            }
        }

        let home = PathBuf::from(format!("/tmp/madc-dt-l1-bl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");
        let sock_path = home.join("engine.sock");
        let sock_str = sock_path.to_string_lossy().into_owned();

        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(fd >= 0, "socket(AF_UNIX) failed");
        let _listener_guard = RawFdGuard(fd);

        let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let path_bytes = sock_str.as_bytes();
        assert!(path_bytes.len() < addr.sun_path.len());
        unsafe {
            std::ptr::copy_nonoverlapping(
                path_bytes.as_ptr(),
                addr.sun_path.as_mut_ptr().cast::<u8>(),
                path_bytes.len(),
            );
            let rc_bind = libc::bind(
                fd,
                (&addr as *const libc::sockaddr_un).cast::<libc::sockaddr>(),
                std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
            );
            assert_eq!(rc_bind, 0, "bind failed: {}", std::io::Error::last_os_error());
            let rc_listen = libc::listen(fd, 1);
            assert_eq!(rc_listen, 0, "listen(1) failed: {}", std::io::Error::last_os_error());
        }

        // Fill the listen backlog without calling accept() using non-blocking sockets.
        let mut fillers: Vec<RawFdGuard> = Vec::new();
        let mut hit_would_block = false;
        for _ in 0..32 {
            let cfd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
            assert!(cfd >= 0);
            unsafe {
                let flags = libc::fcntl(cfd, libc::F_GETFL, 0);
                libc::fcntl(cfd, libc::F_SETFL, flags | libc::O_NONBLOCK);
                let rc = libc::connect(
                    cfd,
                    (&addr as *const libc::sockaddr_un).cast::<libc::sockaddr>(),
                    std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
                );
                if rc == 0 {
                    fillers.push(RawFdGuard(cfd));
                } else {
                    let err = std::io::Error::last_os_error();
                    libc::close(cfd);
                    if err.kind() == ErrorKind::WouldBlock {
                        hit_would_block = true;
                    }
                    break;
                }
            }
        }
        assert!(!fillers.is_empty(), "expected at least one backlog filler connection");

        let probe_timeout = Duration::from_millis(200);
        let watchdog_timeout = probe_timeout + Duration::from_millis(800);
        let (done_tx, done_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let sock_for_thread = sock_str.clone();
        let t0 = Instant::now();
        thread::spawn(move || {
            let res = SocketClient::connect_and_initialize(
                &sock_for_thread,
                probe_timeout,
                true,
                Instant::now(),
            )
            .map(|_| ());
            let _ = done_tx.send(res);
        });

        let result = done_rx.recv_timeout(watchdog_timeout);
        let elapsed = t0.elapsed();
        drop(fillers);
        drop(_listener_guard);
        let _ = std::fs::remove_dir_all(&home);

        let err = result
            .expect("connect_and_initialize hung past watchdog timeout on full backlog")
            .expect_err("expected Err on full backlog");
        if cfg!(target_os = "linux") {
            assert!(hit_would_block, "expected EAGAIN/WouldBlock on full Linux AF_UNIX backlog");
            assert!(
                err.contains("timed out"),
                "expected connect timeout on full Linux backlog, got: {err}"
            );
        }
        assert!(
            elapsed < probe_timeout + Duration::from_millis(500),
            "full-backlog connect exceeded deadline + 500 ms: elapsed={elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn exit_20_drains_delayed_stderr_before_returning_guidance_m3a2_n4() {
        // M3A2-N4: fake `serve` exits 20 immediately while a subshell still holding stderr open
        // writes the pinned exit-20 reason line after 150 ms. With a 60 ms start_window, the
        // re-probe loop ends BEFORE the reason line is written, so this test fails without the
        // bounded stderr drain wait/join in `SpawnedServe::drain_stderr`.
        let home = PathBuf::from(format!("/tmp/madc-dt-n4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");

        let fake_serve = home.join("fake-serve.sh");
        std::fs::write(
            &fake_serve,
            "#!/bin/sh\n(sleep 0.15; printf 'madc-engine serve: home owned by pid 4242: %s/engine.lock\\n' \"$MADC_HOME\" >&2) &\nexit 20\n",
        )
        .expect("write fake serve");
        std::fs::set_permissions(&fake_serve, std::fs::Permissions::from_mode(0o700))
            .expect("chmod fake serve");

        let cfg = LaunchConfig {
            home: home.clone(),
            runtime_bin: "/bin/sh".to_string(),
            engine_entry: fake_serve,
        };

        let err = match connect_or_spawn_with_window(&cfg, Duration::from_millis(60)) {
            Ok(_) => panic!("expected exit 20 failure"),
            Err(e) => e,
        };
        assert!(err.contains("exited 20"), "got: {err}");
        assert!(
            err.contains("Home lock held by PID 4242"),
            "expected delayed stderr reason line to be drained via bounded join, got: {err}"
        );
        assert!(err.contains("Manual recovery:"), "got: {err}");

        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn drain_stderr_respects_timeout_when_grandchild_holds_pipe_open() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("(sleep 5) & echo early >&2; exit 20")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        let mut child = child;
        let stdin = child.stdin.take();
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let (done_tx, done_rx) = mpsc::sync_channel::<()>(1);
        let stderr_thread = child.stderr.take().map(|mut stderr| {
            let buf_clone = Arc::clone(&stderr_buf);
            thread::spawn(move || {
                let mut chunk = [0u8; 4096];
                loop {
                    match stderr.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let s = String::from_utf8_lossy(&chunk[..n]);
                            if let Ok(mut guard) = buf_clone.lock() {
                                push_stderr_capped(&mut guard, &s, MAX_STDERR_RETAINED_BYTES);
                            }
                        }
                    }
                }
                let _ = done_tx.send(());
            })
        });
        let _ = child.wait();
        let mut spawned = SpawnedServe {
            child,
            stdin,
            stderr_buf,
            stderr_done: Some(done_rx),
            stderr_thread,
            initialized: false,
        };
        let t0 = Instant::now();
        let text = spawned.drain_stderr(Duration::from_millis(120));
        let elapsed = t0.elapsed();
        assert!(
            elapsed < Duration::from_millis(1000),
            "bounded drain_stderr hung waiting on grandchild: {elapsed:?}"
        );
        assert!(text.contains("early"), "got: {text}");
    }

    #[cfg(unix)]
    #[test]
    fn start_timeout_reports_child_exit_status_and_stderr() {
        let home = PathBuf::from(format!("/tmp/madc-dt-l9-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");

        let fake_serve = home.join("hang-serve.sh");
        std::fs::write(
            &fake_serve,
            "#!/bin/sh\necho '[madc-engine] slow-boot-marker' >&2\nexec sleep 10\n",
        )
        .expect("write hang serve");
        std::fs::set_permissions(&fake_serve, std::fs::Permissions::from_mode(0o700))
            .expect("chmod hang serve");

        let cfg = LaunchConfig {
            home: home.clone(),
            runtime_bin: "/bin/sh".to_string(),
            engine_entry: fake_serve,
        };

        let err = match connect_or_spawn_with_window(&cfg, Duration::from_millis(150)) {
            Ok(_) => panic!("expected start timeout"),
            Err(e) => e,
        };
        assert!(
            err.contains("did not complete initialize"),
            "expected timeout message, got: {err}"
        );
        assert!(
            err.contains("exit code=") && err.contains("signal=Some(15)"),
            "expected child exit status (SIGTERM=15) in start-timeout report, got: {err}"
        );
        assert!(
            err.contains("slow-boot-marker"),
            "expected drained stderr in start-timeout report, got: {err}"
        );
        let _ = std::fs::remove_dir_all(&home);
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

    #[cfg(unix)]
    #[test]
    fn exit_20_drains_stderr_and_surfaces_manual_lock_guidance_without_removing_lock() {
        let home = PathBuf::from(format!("/tmp/madc-dt-lk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");
        let lock = home.join("engine.lock");
        let pid = std::process::id();
        std::fs::write(
            &lock,
            format!(
                "{{\"pid\":{pid},\"startedAt\":1,\"token\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}"
            ),
        )
        .expect("write live lock");

        let runtime_bin = env::var("MADC_ENGINE_RUNTIME").unwrap_or_else(|_| "node".to_string());
        let engine_entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../engine/src/bin.ts");
        let cfg = LaunchConfig {
            home: home.clone(),
            runtime_bin,
            engine_entry,
        };

        let err = match connect_or_spawn(&cfg) {
            Ok(_) => panic!("expected exit 20 failure when live engine.lock has no listener"),
            Err(e) => e,
        };
        assert!(err.contains("exited 20"), "got: {err}");
        assert!(
            err.contains(&format!("Home lock held by PID {pid}")),
            "expected §2a lock holder guidance, got: {err}"
        );
        assert!(
            err.contains("Manual recovery:"),
            "expected manual recovery instructions, got: {err}"
        );
        assert!(lock.exists(), "launcher must never delete engine.lock");
        let _ = std::fs::remove_dir_all(&home);
    }
}
