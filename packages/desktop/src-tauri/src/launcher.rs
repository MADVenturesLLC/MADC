//! M3-A2 launcher for `madc-engine serve` (`docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`
//! §1, §2, §2a, §4, §5, §6).
//!
//! Connects over `$MADC_HOME/engine.sock` on POSIX (Windows named pipe unverified), never embeds
//! any agent loop, tools, or credentials, never auto-retries or respawns on failure, and never
//! removes `$MADC_HOME/engine.lock`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
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
pub const EXIT_LOCK_WAIT: Duration = Duration::from_secs(2);
pub const DISCONNECT_STOP_BOUND: Duration = INITIALIZED_KILL_GRACE;
pub const EXIT_BOUND: Duration = Duration::from_secs(9);
/// 3 s shown-ack window: builder default under AM2 §6.1, not a Founder ruling, not covered by D-731.
pub const QUIT_SHOWN_ACK_BOUND: Duration = Duration::from_secs(3);
pub const QUIT_FALLBACK_TTL: Duration = Duration::from_secs(30);
pub const MAX_CWD_BYTES: usize = 4096;
pub const MAX_TURN_INPUT_BYTES: usize = 65_536;
/// Maximum distinct `(turn_id, kind)` notifications buffered per thread while a single `turn/start`
/// reply is pending (`AM2 §6.1` / C2). Newest distinct entries past this cap are dropped and counted.
pub const MAX_BUFFERED_TURN_EVENTS_PER_START: usize = 16;

static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);
static NEXT_QUIT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// M3-A4 desktop IPC method allowlist. Any method outside this set is refused in Rust before
/// taking any lock or touching the engine socket. Refusal string keeps the A2/A3 prefix
/// verbatim (`AM2 §1.1` item 4).
pub const ALLOWED_RPC_METHODS: &[&str] = &[
    "initialize",
    "room/inspect",
    "session/search",
    "session/read",
    "seat/list",
    "thread/start",
    "turn/start",
    "turn/interrupt",
];

pub fn validate_rpc_method(method: &str) -> Result<(), String> {
    if ALLOWED_RPC_METHODS.contains(&method) {
        Ok(())
    } else {
        Err(format!("RPC method not allowed by M3-A2 desktop shell: {method}"))
    }
}

pub fn is_valid_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    let bytes = s.as_bytes();
    bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn rpc_param_refused(method: &str, reason: &str) -> String {
    format!("RPC params refused by desktop shell for {method}: {reason}")
}

fn require_empty_object(method: &str, params: &Value) -> Result<(), String> {
    let obj = params
        .as_object()
        .ok_or_else(|| rpc_param_refused(method, "params must be an object"))?;
    if !obj.is_empty() {
        return Err(rpc_param_refused(method, "unknown parameter"));
    }
    Ok(())
}

/// Rust-side parameter validation for M3-A4 desktop methods (`AM2 §1.2`, R5).
/// Runs after `validate_rpc_method` and BEFORE any lock, connection check, or socket write.
/// Never echoes unknown key names and never triggers `disconnect_engine`.
pub fn validate_rpc_params(method: &str, params: &Value) -> Result<(), String> {
    match method {
        "initialize" | "session/search" | "session/read" => Ok(()),
        "room/inspect" | "seat/list" => require_empty_object(method, params),
        "thread/start" => {
            let obj = params
                .as_object()
                .ok_or_else(|| rpc_param_refused(method, "params must be an object"))?;
            for key in obj.keys() {
                if key != "seatId" && key != "cwd" {
                    return Err(rpc_param_refused(method, "unknown parameter"));
                }
            }
            if let Some(seat_val) = obj.get("seatId") {
                let seat = seat_val
                    .as_str()
                    .ok_or_else(|| rpc_param_refused(method, "seatId must be a valid id"))?;
                if !is_valid_id(seat) {
                    return Err(rpc_param_refused(method, "seatId must be a valid id"));
                }
            }
            if let Some(cwd_val) = obj.get("cwd") {
                let cwd = cwd_val.as_str().ok_or_else(|| {
                    rpc_param_refused(method, "cwd must be an absolute path string")
                })?;
                if cwd.is_empty() || cwd.len() > MAX_CWD_BYTES {
                    return Err(rpc_param_refused(
                        method,
                        "cwd length must be 1..=4096 bytes",
                    ));
                }
                if cwd.as_bytes().contains(&0) {
                    return Err(rpc_param_refused(method, "cwd must not contain NUL"));
                }
                if !Path::new(cwd).is_absolute() {
                    return Err(rpc_param_refused(method, "cwd must be an absolute path"));
                }
            }
            Ok(())
        }
        "turn/start" => {
            let obj = params
                .as_object()
                .ok_or_else(|| rpc_param_refused(method, "params must be an object"))?;
            for key in obj.keys() {
                if key != "threadId" && key != "input" && key != "mode" {
                    return Err(rpc_param_refused(method, "unknown parameter"));
                }
            }
            let thread_id = obj
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_param_refused(method, "threadId must be a valid id"))?;
            if !is_valid_id(thread_id) {
                return Err(rpc_param_refused(method, "threadId must be a valid id"));
            }
            let input_arr = obj
                .get("input")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    rpc_param_refused(method, "input must be an array of one text item")
                })?;
            if input_arr.len() != 1 {
                return Err(rpc_param_refused(
                    method,
                    "input must contain exactly one item",
                ));
            }
            let item = input_arr[0]
                .as_object()
                .ok_or_else(|| rpc_param_refused(method, "input item must be an object"))?;
            if item.len() != 2
                || item.get("type").and_then(|v| v.as_str()) != Some("text")
                || item.get("text").and_then(|v| v.as_str()).is_none()
            {
                return Err(rpc_param_refused(
                    method,
                    "input item must have exactly type \"text\" and string text",
                ));
            }
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if text.trim().is_empty() {
                return Err(rpc_param_refused(
                    method,
                    "input text must not be empty",
                ));
            }
            if text.len() > MAX_TURN_INPUT_BYTES {
                return Err(rpc_param_refused(
                    method,
                    "input text exceeds 65536 bytes",
                ));
            }
            if let Some(mode_val) = obj.get("mode") {
                if mode_val.as_str() != Some("headless") {
                    return Err(rpc_param_refused(
                        method,
                        "mode must be absent or \"headless\"",
                    ));
                }
            }
            Ok(())
        }
        "turn/interrupt" => {
            let obj = params
                .as_object()
                .ok_or_else(|| rpc_param_refused(method, "params must be an object"))?;
            for key in obj.keys() {
                if key != "threadId" && key != "turnId" {
                    return Err(rpc_param_refused(method, "unknown parameter"));
                }
            }
            let thread_id = obj
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_param_refused(method, "threadId must be a valid id"))?;
            if !is_valid_id(thread_id) {
                return Err(rpc_param_refused(method, "threadId must be a valid id"));
            }
            let turn_id = obj
                .get("turnId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_param_refused(method, "turnId must be a valid id"))?;
            if !is_valid_id(turn_id) {
                return Err(rpc_param_refused(method, "turnId must be a valid id"));
            }
            Ok(())
        }
        _ => Err(rpc_param_refused(method, "unknown method")),
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

pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub const FORWARD_QUEUE_CAPACITY: usize = 4096;
pub const MAX_SEARCH_MATCHES: usize = 200;
const GENESIS_HASH_ZEROS: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundedLine {
    Line(String),
    Eof,
    Oversize,
    InvalidUtf8,
    ReadError(ErrorKind, String),
}

/// Bounded JSONL frame reader (`AM2 §2.2`) shared by handshake and reader thread.
/// Appends at most `MAX_LINE_BYTES + 1` bytes into `buf` (capping `buf` capacity) and stops
/// without further reading, allocation, or parsing if no `\n` appears within `MAX_LINE_BYTES`.
pub fn read_bounded_line<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> BoundedLine {
    buf.clear();
    loop {
        let avail = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return BoundedLine::ReadError(e.kind(), e.to_string()),
        };
        if avail.is_empty() {
            // AM2 §2.2: unterminated fragment followed by EOF is discarded and ends as eof.
            return BoundedLine::Eof;
        }
        if let Some(nl_pos) = avail.iter().position(|&b| b == b'\n') {
            if buf.len() + nl_pos > MAX_LINE_BYTES {
                return BoundedLine::Oversize;
            }
            if nl_pos > 0 {
                let needed = buf.len() + nl_pos;
                if needed > buf.capacity() {
                    let target = buf
                        .capacity()
                        .saturating_mul(2)
                        .max(needed)
                        .max(4096)
                        .min(MAX_LINE_BYTES + 1);
                    buf.reserve_exact(target - buf.len());
                }
                buf.extend_from_slice(&avail[..nl_pos]);
            }
            reader.consume(nl_pos + 1);
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return match std::str::from_utf8(buf) {
                Ok(s) => BoundedLine::Line(s.to_string()),
                Err(_) => BoundedLine::InvalidUtf8,
            };
        }
        let rem_cap = (MAX_LINE_BYTES + 1).saturating_sub(buf.len());
        let take = avail.len().min(rem_cap);
        if take > 0 {
            let needed = buf.len() + take;
            if needed > buf.capacity() {
                let target = buf
                    .capacity()
                    .saturating_mul(2)
                    .max(needed)
                    .max(4096)
                    .min(MAX_LINE_BYTES + 1);
                buf.reserve_exact(target - buf.len());
            }
            buf.extend_from_slice(&avail[..take]);
        }
        reader.consume(take);
        if buf.len() > MAX_LINE_BYTES {
            return BoundedLine::Oversize;
        }
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_sha40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_finite_number(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}

fn is_uint(v: &Value) -> bool {
    v.as_u64().is_some()
}

fn is_non_empty_trimmed(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty())
}

fn is_lane(s: &str) -> bool {
    matches!(
        s,
        "allowed-direct" | "allowed-via-vendor-agent" | "interactive-only" | "forbidden"
    )
}

fn is_turn_mode(s: &str) -> bool {
    matches!(s, "interactive" | "headless")
}

fn is_session_ref_path(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("sessions/") else {
        return false;
    };
    let Some(id) = rest.strip_suffix(".jsonl") else {
        return false;
    };
    is_valid_id(id)
}

fn validate_rpc_error_body(v: &Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    obj.get("code").is_some_and(is_finite_number)
        && obj.get("message").and_then(|m| m.as_str()).is_some()
}

fn validate_worktree_identity(v: &Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    let Some(top) = obj.get("topLevel").and_then(|v| v.as_str()) else {
        return false;
    };
    if top.is_empty() || top.as_bytes().contains(&0) || !Path::new(top).is_absolute() {
        return false;
    }
    let Some(remote) = obj.get("remote") else {
        return false;
    };
    if !(remote.is_null() || remote.is_string()) {
        return false;
    }
    let Some(head) = obj.get("head") else {
        return false;
    };
    head.is_null() || head.as_str().is_some_and(is_sha40)
}

fn validate_handoff_link(v: &Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    obj.get("sourceThreadId")
        .and_then(|v| v.as_str())
        .is_some_and(is_valid_id)
        && obj
            .get("sourceSeatId")
            .and_then(|v| v.as_str())
            .is_some_and(is_valid_id)
        && obj
            .get("handoffId")
            .and_then(|v| v.as_str())
            .is_some_and(is_valid_id)
        && obj.get("sourceSeq").is_some_and(is_uint)
        && obj
            .get("sourceHash")
            .and_then(|v| v.as_str())
            .is_some_and(is_hex64)
}

fn validate_evidence_ref(v: &Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    match obj.get("kind").and_then(|v| v.as_str()) {
        Some("session" | "servedModel") => {
            obj.len() == 4
                && obj
                    .get("path")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_session_ref_path)
                && obj.get("seq").is_some_and(is_uint)
                && obj
                    .get("hash")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_hex64)
        }
        Some("git") => {
            obj.len() == 3
                && obj
                    .get("sha")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_sha40)
                && obj
                    .get("remote")
                    .is_some_and(|r| r.is_null() || r.is_string())
        }
        _ => false,
    }
}

fn validate_served_model_fields(obj: &serde_json::Map<String, Value>) -> bool {
    obj.get("requestedModel").is_some_and(|v| v.is_string())
        && obj.get("servedModel").is_some_and(|v| v.is_string())
        && obj.get("backing").is_some_and(|v| v.is_string())
        && obj.get("providerId").is_some_and(|v| v.is_string())
        && obj
            .get("lane")
            .and_then(|v| v.as_str())
            .is_some_and(is_lane)
        && obj
            .get("mode")
            .and_then(|v| v.as_str())
            .is_some_and(is_turn_mode)
        && obj
            .get("fallbackFrom")
            .is_some_and(|v| v.is_null() || v.is_string())
        && obj.get("vendorReported").is_some_and(|v| v.is_boolean())
}

/// Closed shape check for `Item` (`AM2 §3.2.1 (e)`).
pub fn validate_item(v: &Value, allow_in_progress: bool) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    if !obj
        .get("id")
        .and_then(|v| v.as_str())
        .is_some_and(is_valid_id)
    {
        return false;
    }
    let Some(status) = obj.get("status").and_then(|v| v.as_str()) else {
        return false;
    };
    let status_ok = matches!(status, "completed" | "failed")
        || (allow_in_progress && status == "inProgress");
    if !status_ok {
        return false;
    }
    match obj.get("kind").and_then(|v| v.as_str()) {
        Some("userMessage") => {
            let Some(content) = obj.get("content").and_then(|v| v.as_array()) else {
                return false;
            };
            content.iter().all(|part| {
                part.as_object().is_some_and(|p| {
                    p.get("type").and_then(|t| t.as_str()) == Some("text")
                        && p.get("text").is_some_and(|t| t.is_string())
                })
            })
        }
        Some("agentMessage") => obj.get("text").is_some_and(|v| v.is_string()),
        Some("toolCall") => {
            obj.get("name").is_some_and(|v| v.is_string()) && obj.contains_key("arguments")
        }
        Some("toolResult") => {
            obj.get("callId").is_some_and(|v| v.is_string())
                && obj.get("name").is_some_and(|v| v.is_string())
                && obj.get("output").is_some_and(|v| v.is_string())
                && obj.get("isError").is_some_and(|v| v.is_boolean())
        }
        Some("error") => {
            obj.get("message").is_some_and(|v| v.is_string())
                && (!obj.contains_key("code") || obj.get("code").is_some_and(is_finite_number))
        }
        Some("servedModel") => validate_served_model_fields(obj),
        _ => false,
    }
}

pub fn validate_thread_shape(thread: &Value, require_idle: bool, expected_seat: Option<&str>) -> bool {
    let Some(obj) = thread.as_object() else {
        return false;
    };
    let Some(id) = obj.get("id").and_then(|v| v.as_str()) else {
        return false;
    };
    let Some(seat_id) = obj.get("seatId").and_then(|v| v.as_str()) else {
        return false;
    };
    if !is_valid_id(id) || !is_valid_id(seat_id) {
        return false;
    }
    if let Some(expected) = expected_seat {
        if seat_id != expected {
            return false;
        }
    }
    let Some(status) = obj.get("status").and_then(|v| v.as_str()) else {
        return false;
    };
    let status_ok = if require_idle {
        status == "idle"
    } else {
        matches!(status, "idle" | "active" | "closed")
    };
    if !status_ok {
        return false;
    }
    if !obj.get("cwd").is_some_and(|v| v.is_null() || v.is_string()) {
        return false;
    }
    obj.get("createdAt").is_some_and(is_finite_number)
        && obj.get("updatedAt").is_some_and(is_finite_number)
        && obj.get("preview").is_some_and(|v| v.is_string())
}

pub fn validate_turn_started_shape(turn: &Value, expected_thread_id: Option<&str>) -> bool {
    let Some(obj) = turn.as_object() else {
        return false;
    };
    let Some(id) = obj.get("id").and_then(|v| v.as_str()) else {
        return false;
    };
    let Some(tid) = obj.get("threadId").and_then(|v| v.as_str()) else {
        return false;
    };
    if !is_valid_id(id) || !is_valid_id(tid) {
        return false;
    }
    if let Some(expected) = expected_thread_id {
        if tid != expected {
            return false;
        }
    }
    if obj.get("status").and_then(|v| v.as_str()) != Some("inProgress") {
        return false;
    }
    if obj.get("error") != Some(&Value::Null) || obj.get("completedAt") != Some(&Value::Null) {
        return false;
    }
    if !obj.get("startedAt").is_some_and(is_finite_number) {
        return false;
    }
    obj.get("items")
        .and_then(|v| v.as_array())
        .is_some_and(|items| items.iter().all(|it| validate_item(it, true)))
}

pub fn validate_turn_completed_shape(turn: &Value) -> bool {
    let Some(obj) = turn.as_object() else {
        return false;
    };
    if !obj
        .get("id")
        .and_then(|v| v.as_str())
        .is_some_and(is_valid_id)
        || !obj
            .get("threadId")
            .and_then(|v| v.as_str())
            .is_some_and(is_valid_id)
    {
        return false;
    }
    let Some(status) = obj.get("status").and_then(|v| v.as_str()) else {
        return false;
    };
    let err_ok = match status {
        "failed" => obj.get("error").is_some_and(validate_rpc_error_body),
        "completed" | "interrupted" => obj.get("error") == Some(&Value::Null),
        _ => return false,
    };
    if !err_ok {
        return false;
    }
    if !obj.get("startedAt").is_some_and(is_finite_number)
        || !obj.get("completedAt").is_some_and(is_finite_number)
    {
        return false;
    }
    obj.get("items")
        .and_then(|v| v.as_array())
        .is_some_and(|items| items.iter().all(|it| validate_item(it, true)))
}

/// Closed shape check for `initialize` result (`AM2 §3.2.1 (i)`, §13 (7o)).
pub fn validate_initialize_result(result: &Value) -> Result<(String, String, String), String> {
    let Some(obj) = result.as_object() else {
        return Err("invalid initialize response: result must be an object".to_string());
    };
    let Some(protocol_version) = obj.get("protocolVersion").and_then(|v| v.as_str()) else {
        return Err("invalid initialize response: protocolVersion must be a string".to_string());
    };
    if protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "protocol version mismatch: expected {PROTOCOL_VERSION}, got {protocol_version}"
        ));
    }
    let Some(server_info) = obj.get("serverInfo").and_then(|v| v.as_object()) else {
        return Err("invalid initialize response: serverInfo must be an object".to_string());
    };
    let Some(server_name) = server_info.get("name").and_then(|v| v.as_str()) else {
        return Err("invalid initialize response: serverInfo.name must be a string".to_string());
    };
    if server_name != "madc-engine" {
        return Err(format!(
            "invalid initialize response: unexpected serverInfo.name: {server_name}"
        ));
    }
    let Some(server_version) = server_info.get("version").and_then(|v| v.as_str()) else {
        return Err("invalid initialize response: serverInfo.version must be a string".to_string());
    };
    Ok((
        protocol_version.to_string(),
        server_name.to_string(),
        server_version.to_string(),
    ))
}

pub fn validate_seat_list_result(result: &Value) -> bool {
    let Some(data) = result
        .as_object()
        .and_then(|o| o.get("data"))
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    data.iter().all(|entry| {
        let Some(obj) = entry.as_object() else {
            return false;
        };
        if !obj
            .get("id")
            .and_then(|v| v.as_str())
            .is_some_and(is_valid_id)
            || !obj.get("path").is_some_and(|v| v.is_string())
        {
            return false;
        }
        match obj.get("ok").and_then(|v| v.as_bool()) {
            Some(true) => {
                let ver_ok = obj
                    .get("version")
                    .and_then(|v| v.as_u64())
                    .is_some_and(|n| n == 1 || n == 2);
                let dn_ok = obj
                    .get("displayName")
                    .is_some_and(|v| v.is_null() || v.is_string());
                let mem_ok = obj
                    .get("memory")
                    .and_then(|v| v.as_object())
                    .is_some_and(|m| match m.get("mode").and_then(|v| v.as_str()) {
                        Some("in-session") => true,
                        Some("file") => m.get("path").is_some_and(|v| v.is_string()),
                        _ => false,
                    });
                let tools_ok = obj
                    .get("tools")
                    .and_then(|v| v.as_object())
                    .and_then(|t| t.get("deny"))
                    .and_then(|v| v.as_array())
                    .is_some_and(|a| a.iter().all(|s| s.is_string()));
                let policy_ok = obj
                    .get("policy")
                    .and_then(|v| v.as_object())
                    .and_then(|p| p.get("headlessOk"))
                    .is_some_and(|v| v.is_boolean());
                ver_ok
                    && dn_ok
                    && obj.get("role").is_some_and(|v| v.is_string())
                    && obj.get("pinnedModel").is_some_and(|v| v.is_string())
                    && obj.get("preferredBacking").is_some_and(|v| v.is_string())
                    && obj
                        .get("fallbacks")
                        .and_then(|v| v.as_array())
                        .is_some_and(|a| a.iter().all(|s| s.is_string()))
                    && mem_ok
                    && tools_ok
                    && policy_ok
                    && obj
                        .get("warnings")
                        .and_then(|v| v.as_array())
                        .is_some_and(|a| a.iter().all(|s| s.is_string()))
            }
            Some(false) => {
                obj.get("code")
                    .is_some_and(|v| v.is_i64() || v.is_u64())
                    && obj
                        .get("issues")
                        .and_then(|v| v.as_array())
                        .is_some_and(|a| a.iter().all(|s| s.is_string()))
            }
            None => false,
        }
    })
}

pub fn validate_session_search_result(result: &Value) -> bool {
    let Some(matches) = result
        .as_object()
        .and_then(|o| o.get("matches"))
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    if matches.len() > MAX_SEARCH_MATCHES {
        return false;
    }
    matches.iter().all(|m| {
        let Some(obj) = m.as_object() else {
            return false;
        };
        obj.get("threadId")
            .and_then(|v| v.as_str())
            .is_some_and(is_valid_id)
            && obj
                .get("seatId")
                .and_then(|v| v.as_str())
                .is_some_and(is_valid_id)
            && obj.get("seq").is_some_and(is_uint)
            && obj
                .get("hash")
                .and_then(|v| v.as_str())
                .is_some_and(is_hex64)
            && obj.get("ts").is_some_and(is_finite_number)
            && obj
                .get("type")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty())
            && obj.get("snippet").is_some_and(|v| v.is_string())
    })
}

pub fn validate_turn_interrupt_result(result: &Value) -> bool {
    result.as_object().is_some_and(|o| o.is_empty())
}

fn validate_lane_status_obj(v: &Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    obj.get("status")
        .and_then(|s| s.as_str())
        .is_some_and(is_lane)
        && obj.get("credentialClass").is_some_and(|c| c.is_string())
}

pub fn validate_session_read_result(result: &Value, expected_thread_id: &str) -> bool {
    let Some(obj) = result.as_object() else {
        return false;
    };
    let Some(tid) = obj.get("threadId").and_then(|v| v.as_str()) else {
        return false;
    };
    if !is_valid_id(tid) || (!expected_thread_id.is_empty() && tid != expected_thread_id) {
        return false;
    }
    let Some(chain_ok) = obj.get("chainOk").and_then(|v| v.as_bool()) else {
        return false;
    };
    let Some(events) = obj.get("events").and_then(|v| v.as_array()) else {
        return false;
    };
    if !chain_ok {
        return events.is_empty();
    }
    if events.is_empty() {
        return false;
    }

    let mut seat_0: Option<&str> = None;
    let mut prev_hash: &str = GENESIS_HASH_ZEROS;
    let mut open_worktree_present = false;
    let mut open_top_level: Option<String> = None;

    for (idx, ev) in events.iter().enumerate() {
        let Some(ev_obj) = ev.as_object() else {
            return false;
        };
        // Closed 9-key envelope
        if ev_obj.len() != 9 {
            return false;
        }
        if ev_obj.get("v").and_then(|v| v.as_u64()) != Some(1) {
            return false;
        }
        if ev_obj.get("seq").and_then(|v| v.as_u64()) != Some(idx as u64) {
            return false;
        }
        if !ev_obj.get("ts").is_some_and(is_finite_number) {
            return false;
        }
        let Some(ev_tid) = ev_obj.get("threadId").and_then(|v| v.as_str()) else {
            return false;
        };
        if ev_tid != tid {
            return false;
        }
        let Some(ev_seat) = ev_obj.get("seatId").and_then(|v| v.as_str()) else {
            return false;
        };
        if !is_valid_id(ev_seat) {
            return false;
        }
        match seat_0 {
            None => seat_0 = Some(ev_seat),
            Some(first) if first != ev_seat => return false,
            _ => {}
        }
        let Some(ev_prev) = ev_obj.get("prevHash").and_then(|v| v.as_str()) else {
            return false;
        };
        let Some(ev_hash) = ev_obj.get("hash").and_then(|v| v.as_str()) else {
            return false;
        };
        if !is_hex64(ev_prev) || !is_hex64(ev_hash) || ev_prev != prev_hash {
            return false;
        }
        prev_hash = ev_hash;

        let Some(ev_type) = ev_obj.get("type").and_then(|v| v.as_str()) else {
            return false;
        };
        if idx == 0 && ev_type != "session.open" {
            return false;
        }
        if idx >= 1 && ev_type == "session.open" {
            return false;
        }
        let Some(payload) = ev_obj.get("payload").and_then(|v| v.as_object()) else {
            return false;
        };

        let payload_ok = match ev_type {
            "session.open" => {
                let base_ok = payload
                    .get("cwd")
                    .is_some_and(|v| v.is_null() || v.is_string())
                    && payload.get("backing").is_some_and(|v| v.is_string())
                    && payload.get("providerId").is_some_and(|v| v.is_string())
                    && payload.get("pinnedModel").is_some_and(|v| v.is_string());
                if !base_ok {
                    return false;
                }
                let has_handoff = payload.contains_key("handoff");
                let has_worktree = payload.contains_key("worktree");
                if has_handoff != has_worktree {
                    return false;
                }
                if has_handoff {
                    let h = &payload["handoff"];
                    let w = &payload["worktree"];
                    if !(h.is_null() || validate_handoff_link(h)) {
                        return false;
                    }
                    if !(w.is_null() || validate_worktree_identity(w)) {
                        return false;
                    }
                    open_worktree_present = true;
                    open_top_level = w
                        .as_object()
                        .and_then(|wo| wo.get("topLevel"))
                        .and_then(|tl| tl.as_str())
                        .map(|s| s.to_string());
                }
                true
            }
            "turn.start" => {
                let base_ok = payload
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload.get("inputText").is_some_and(|v| v.is_string());
                if !base_ok {
                    return false;
                }
                let has_mode = payload.contains_key("mode");
                let has_presence = payload.contains_key("presence");
                let has_tty = payload.contains_key("tty");
                if has_mode || has_presence || has_tty {
                    let Some(mode) = payload.get("mode").and_then(|v| v.as_str()) else {
                        return false;
                    };
                    let Some(presence) = payload.get("presence").and_then(|v| v.as_str()) else {
                        return false;
                    };
                    if !is_turn_mode(mode) {
                        return false;
                    }
                    match presence {
                        "verified" => {
                            let Some(tty) = payload.get("tty").and_then(|v| v.as_object()) else {
                                return false;
                            };
                            let tty_ok = tty.get("device").is_some_and(|v| v.is_string())
                                && tty
                                    .get("session")
                                    .is_some_and(|v| v.is_null() || v.is_string())
                                && tty
                                    .get("confirmation")
                                    .and_then(|v| v.as_str())
                                    .is_some_and(|c| c == "keypress" || c == "carried");
                            if !tty_ok {
                                return false;
                            }
                        }
                        "absent" => {
                            if has_tty {
                                return false;
                            }
                        }
                        _ => return false,
                    }
                }
                if let Some(bs) = payload.get("briefServed") {
                    let Some(bs_obj) = bs.as_object() else {
                        return false;
                    };
                    if bs_obj.len() != 3
                        || !bs_obj
                            .get("handoffId")
                            .and_then(|v| v.as_str())
                            .is_some_and(is_valid_id)
                        || !bs_obj.get("sourceSeq").is_some_and(is_uint)
                        || !bs_obj
                            .get("sourceHash")
                            .and_then(|v| v.as_str())
                            .is_some_and(is_hex64)
                    {
                        return false;
                    }
                }
                true
            }
            "item" => {
                payload
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload
                        .get("item")
                        .is_some_and(|it| validate_item(it, true))
            }
            "servedModel" => {
                payload
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && validate_served_model_fields(payload)
            }
            "fallback.rejected" => {
                payload
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload.get("candidate").is_some_and(|v| v.is_string())
                    && payload
                        .get("assignedLane")
                        .is_some_and(validate_lane_status_obj)
                    && payload
                        .get("candidateLane")
                        .is_some_and(validate_lane_status_obj)
                    && payload.get("reason").and_then(|v| v.as_str())
                        == Some("fallback-lane-mismatch")
            }
            "repo.decision" => {
                let dec = payload.get("decision").and_then(|v| v.as_str());
                let reason = payload.get("reason").and_then(|v| v.as_str());
                let dec_ok = match (dec, reason) {
                    (Some("allow"), Some("repo-allowed" | "not-repo-gated")) => true,
                    (Some("deny"), Some("repo-not-allowed" | "repo-identity-ambiguous")) => true,
                    _ => false,
                };
                payload
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload.get("providerId").is_some_and(|v| v.is_string())
                    && payload
                        .get("remote")
                        .is_some_and(|v| v.is_null() || v.is_string())
                    && payload
                        .get("topLevel")
                        .is_some_and(|v| v.is_null() || v.is_string())
                    && dec_ok
            }
            "turn.end" => {
                payload
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload
                        .get("status")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| matches!(s, "completed" | "interrupted" | "failed"))
                    && payload
                        .get("error")
                        .is_some_and(|e| e.is_null() || validate_rpc_error_body(e))
            }
            "session.close" => {
                if !payload.get("reason").is_some_and(|v| v.is_string()) {
                    return false;
                }
                if open_worktree_present && !payload.contains_key("worktree") {
                    return false;
                }
                if let Some(w) = payload.get("worktree") {
                    if !w.is_null() {
                        if !validate_worktree_identity(w) {
                            return false;
                        }
                        let close_tl = w
                            .as_object()
                            .and_then(|wo| wo.get("topLevel"))
                            .and_then(|v| v.as_str());
                        if open_top_level.as_deref() != close_tl {
                            return false;
                        }
                    }
                }
                true
            }
            "handoff.out" => {
                payload
                    .get("handoffId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload.get("turnId").is_some_and(|t| {
                        t.is_null() || t.as_str().is_some_and(is_valid_id)
                    })
                    && payload
                        .get("targetSeatId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && payload.get("brief").is_some_and(is_non_empty_trimmed)
            }
            "handoff.link" => {
                payload
                    .get("handoffId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload
                        .get("targetThreadId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && payload
                        .get("targetSeatId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && payload
                        .get("targetGenesisHash")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_hex64)
            }
            "handoff.aborted" => {
                payload
                    .get("handoffId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && payload
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .is_some_and(|r| {
                            matches!(
                                r,
                                "target-open-failed"
                                    | "target-genesis-unavailable"
                                    | "interrupted"
                            )
                        })
                    && payload
                        .get("error")
                        .is_some_and(|e| e.is_null() || validate_rpc_error_body(e))
            }
            "founderDecision" => {
                payload.len() == 5
                    && payload
                        .get("decisionId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && payload
                        .get("turnId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && payload.get("question").is_some_and(is_non_empty_trimmed)
                    && payload
                        .get("recommendedDefault")
                        .is_some_and(is_non_empty_trimmed)
                    && payload
                        .get("evidenceRefs")
                        .and_then(|v| v.as_array())
                        .is_some_and(|refs| !refs.is_empty() && refs.iter().all(validate_evidence_ref))
            }
            "founderDecision.resolved" => {
                payload.len() == 5
                    && payload
                        .get("decisionId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && payload.get("decisionSeq").is_some_and(is_uint)
                    && payload
                        .get("decisionHash")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_hex64)
                    && payload
                        .get("outcome")
                        .and_then(|v| v.as_str())
                        .is_some_and(|o| o == "accepted-default" || o == "decided")
                    && payload.get("resolution").is_some_and(is_non_empty_trimmed)
            }
            _ => false,
        };
        if !payload_ok {
            return false;
        }
    }
    true
}

fn is_valid_finding_code(code: &str) -> bool {
    matches!(
        code,
        "integrity"
            | "brief-unserved"
            | "handoff-mismatch"
            | "handoff-terminal-conflict"
            | "evidence-ref-mismatch"
            | "decision-resolution-mismatch"
            | "duplicate-id"
            | "handoff-incomplete"
            | "handoff-unverifiable"
            | "evidence-ref-unresolved"
            | "worktree-head-unreadable"
            | "not-cleanly-closed"
    )
}

pub fn validate_room_inspect_result(result: &Value) -> bool {
    let Some(room) = result.as_object().and_then(|o| o.get("room")).and_then(|v| v.as_object()) else {
        return false;
    };
    if !room.get("home").is_some_and(|v| v.is_string()) {
        return false;
    }
    let Some(threads) = room.get("threads").and_then(|v| v.as_array()) else {
        return false;
    };
    let Some(counts) = room.get("counts").and_then(|v| v.as_object()) else {
        return false;
    };
    let Some(c_threads) = counts.get("threads").and_then(|v| v.as_u64()) else {
        return false;
    };
    let Some(c_pass) = counts.get("pass").and_then(|v| v.as_u64()) else {
        return false;
    };
    let Some(c_warn) = counts.get("warn").and_then(|v| v.as_u64()) else {
        return false;
    };
    let Some(c_fail) = counts.get("fail").and_then(|v| v.as_u64()) else {
        return false;
    };
    let Some(c_open_dec) = counts.get("openDecisions").and_then(|v| v.as_u64()) else {
        return false;
    };

    let mut pass_tally: u64 = 0;
    let mut warn_tally: u64 = 0;
    let mut fail_tally: u64 = 0;
    let mut open_dec_tally: u64 = 0;
    let mut prev_tid: Option<&str> = None;

    for row in threads {
        let Some(r) = row.as_object() else {
            return false;
        };
        let Some(tid) = r.get("threadId").and_then(|v| v.as_str()) else {
            return false;
        };
        if !is_valid_id(tid) {
            return false;
        }
        if let Some(prev) = prev_tid {
            if prev >= tid {
                return false;
            }
        }
        prev_tid = Some(tid);

        if !r.get("path").is_some_and(|v| v.is_string()) {
            return false;
        }
        let Some(level) = r.get("level").and_then(|v| v.as_str()) else {
            return false;
        };
        match level {
            "pass" => pass_tally += 1,
            "warn" => warn_tally += 1,
            "fail" => fail_tally += 1,
            _ => return false,
        }

        let Some(chain) = r.get("chain").and_then(|v| v.as_object()) else {
            return false;
        };
        let Some(chain_ok) = chain.get("ok").and_then(|v| v.as_bool()) else {
            return false;
        };
        if chain_ok {
            if !r
                .get("seatId")
                .and_then(|v| v.as_str())
                .is_some_and(is_valid_id)
            {
                return false;
            }
        } else {
            if r.get("seatId") != Some(&Value::Null)
                || level != "fail"
                || !chain
                    .get("line")
                    .and_then(|v| v.as_u64())
                    .is_some_and(|n| n >= 1)
                || !chain.get("reason").is_some_and(|v| v.is_string())
                || !chain
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .is_some_and(|k| k == "torn-tail" || k == "integrity")
            {
                return false;
            }
        }

        let Some(handoff) = r.get("handoff").and_then(|v| v.as_object()) else {
            return false;
        };
        if !handoff
            .get("inbound")
            .is_some_and(|v| v.is_null() || validate_handoff_link(v))
            || !handoff.get("outboundCount").is_some_and(is_uint)
            || !handoff.get("oneWay").is_some_and(|v| v.is_boolean())
        {
            return false;
        }

        let Some(worktree) = r.get("worktree").and_then(|v| v.as_object()) else {
            return false;
        };
        let Some(wt_open) = worktree.get("open") else {
            return false;
        };
        let Some(wt_close) = worktree.get("close") else {
            return false;
        };
        let Some(wt_missing) = worktree.get("missing").and_then(|v| v.as_bool()) else {
            return false;
        };
        if !(wt_open.is_null() || validate_worktree_identity(wt_open))
            || !(wt_close.is_null() || validate_worktree_identity(wt_close))
        {
            return false;
        }
        if !chain_ok && (!wt_open.is_null() || !wt_close.is_null() || wt_missing) {
            return false;
        }
        if !wt_close.is_null() {
            if wt_open.is_null() {
                return false;
            }
            let open_tl = wt_open.as_object().and_then(|o| o.get("topLevel")).and_then(|v| v.as_str());
            let close_tl = wt_close.as_object().and_then(|o| o.get("topLevel")).and_then(|v| v.as_str());
            if open_tl != close_tl {
                return false;
            }
        }

        let Some(open_decisions) = r.get("openDecisions").and_then(|v| v.as_array()) else {
            return false;
        };
        if !chain_ok && !open_decisions.is_empty() {
            return false;
        }
        for dec in open_decisions {
            let Some(d) = dec.as_object() else {
                return false;
            };
            let ok_dec = d.get("threadId").and_then(|v| v.as_str()) == Some(tid)
                && d.get("seatId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                && d.get("seq").is_some_and(is_uint)
                && d.get("hash")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_hex64)
                && d.get("ts").is_some_and(is_finite_number)
                && d.get("decisionId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                && d.get("turnId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                && d.get("question").is_some_and(is_non_empty_trimmed)
                && d.get("recommendedDefault").is_some_and(is_non_empty_trimmed)
                && d.get("evidenceRefs")
                    .and_then(|v| v.as_array())
                    .is_some_and(|refs| !refs.is_empty() && refs.iter().all(validate_evidence_ref));
            if !ok_dec {
                return false;
            }
        }
        open_dec_tally += open_decisions.len() as u64;

        let Some(findings) = r.get("findings").and_then(|v| v.as_array()) else {
            return false;
        };
        let mut saw_fail = false;
        let mut saw_warn = false;
        for f in findings {
            let Some(fo) = f.as_object() else {
                return false;
            };
            let Some(f_lvl) = fo.get("level").and_then(|v| v.as_str()) else {
                return false;
            };
            match f_lvl {
                "fail" => saw_fail = true,
                "warn" => saw_warn = true,
                _ => return false,
            }
            if !fo
                .get("code")
                .and_then(|v| v.as_str())
                .is_some_and(is_valid_finding_code)
                || !fo.get("detail").is_some_and(|v| v.is_string())
            {
                return false;
            }
        }
        if !chain_ok {
            if findings.len() != 1 {
                return false;
            }
            let fo = findings[0].as_object().unwrap();
            if fo.get("level").and_then(|v| v.as_str()) != Some("fail")
                || fo.get("code").and_then(|v| v.as_str()) != Some("integrity")
            {
                return false;
            }
        } else {
            let expected_level = if saw_fail {
                "fail"
            } else if saw_warn {
                "warn"
            } else {
                "pass"
            };
            if level != expected_level {
                return false;
            }
        }
    }

    c_threads == threads.len() as u64
        && c_pass == pass_tally
        && c_warn == warn_tally
        && c_fail == fail_tally
        && c_open_dec == open_dec_tally
}

pub fn validate_rpc_result(method: &str, params: &Value, result: &Value) -> bool {
    match method {
        "initialize" => validate_initialize_result(result).is_ok(),
        "room/inspect" => validate_room_inspect_result(result),
        "session/search" => validate_session_search_result(result),
        "session/read" => {
            let expected_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            validate_session_read_result(result, expected_tid)
        }
        "seat/list" => validate_seat_list_result(result),
        "thread/start" => {
            let expected_seat = params
                .get("seatId")
                .and_then(|v| v.as_str())
                .unwrap_or("madc-default");
            result
                .as_object()
                .and_then(|o| o.get("thread"))
                .is_some_and(|t| validate_thread_shape(t, true, Some(expected_seat)))
        }
        "turn/start" => {
            let expected_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            result
                .as_object()
                .and_then(|o| o.get("turn"))
                .is_some_and(|t| validate_turn_started_shape(t, Some(expected_tid)))
        }
        "turn/interrupt" => validate_turn_interrupt_result(result),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum NotificationVerdict {
    Forwardable { method: String, params: Value },
    Discard,
    UnknownNotification,
    InvalidNotification { terminal: bool },
}

pub fn validate_notification(method: &str, params: &Value) -> NotificationVerdict {
    // AM2 §2.2 / §5 F10: check madc/ prefix FIRST before forwarding/discard lookups.
    if method.starts_with("madc/") {
        return NotificationVerdict::UnknownNotification;
    }
    match method {
        "item/started" | "item/agentMessage/delta" => NotificationVerdict::Discard,
        "room/updated" => {
            let ok = params.as_object().is_some_and(|p| {
                p.get("reason")
                    .and_then(|v| v.as_str())
                    .is_some_and(|r| matches!(r, "thread" | "turn" | "handoff" | "decision"))
                    && p.get("threadId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
            });
            if ok {
                NotificationVerdict::Forwardable {
                    method: method.to_string(),
                    params: params.clone(),
                }
            } else {
                NotificationVerdict::InvalidNotification { terminal: false }
            }
        }
        "thread/started" => {
            let ok = params
                .as_object()
                .and_then(|p| p.get("thread"))
                .is_some_and(|t| validate_thread_shape(t, false, None));
            if ok {
                NotificationVerdict::Forwardable {
                    method: method.to_string(),
                    params: params.clone(),
                }
            } else {
                NotificationVerdict::InvalidNotification { terminal: false }
            }
        }
        "turn/started" => {
            let ok = params
                .as_object()
                .and_then(|p| p.get("turn"))
                .is_some_and(|t| validate_turn_started_shape(t, None));
            if ok {
                NotificationVerdict::Forwardable {
                    method: method.to_string(),
                    params: params.clone(),
                }
            } else {
                NotificationVerdict::InvalidNotification { terminal: false }
            }
        }
        "turn/completed" => {
            let ok = params
                .as_object()
                .and_then(|p| p.get("turn"))
                .is_some_and(validate_turn_completed_shape);
            if ok {
                NotificationVerdict::Forwardable {
                    method: method.to_string(),
                    params: params.clone(),
                }
            } else {
                // AM2 §3.2.1: invalid turn/completed is terminal F2 invalid-frame!
                NotificationVerdict::InvalidNotification { terminal: true }
            }
        }
        "item/completed" => {
            let ok = params.as_object().is_some_and(|p| {
                p.get("threadId")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_valid_id)
                    && p.get("turnId")
                        .and_then(|v| v.as_str())
                        .is_some_and(is_valid_id)
                    && p.get("item")
                        .is_some_and(|it| validate_item(it, false))
            });
            if ok {
                NotificationVerdict::Forwardable {
                    method: method.to_string(),
                    params: params.clone(),
                }
            } else {
                NotificationVerdict::InvalidNotification { terminal: false }
            }
        }
        _ => NotificationVerdict::UnknownNotification,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FrameClass {
    ResponseError { id: u64, error: Value },
    ResponseOk { id: u64, result: Value },
    Notification(NotificationVerdict),
    InvalidFrame(String),
}

pub fn classify_incoming_frame(line: &str) -> FrameClass {
    let val: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return FrameClass::InvalidFrame(format!("invalid JSON from engine: {e}")),
    };
    let Some(obj) = val.as_object() else {
        return FrameClass::InvalidFrame("invalid-frame: JSON message must be an object".to_string());
    };
    let has_id = obj.contains_key("id");
    let has_method = obj.contains_key("method");
    if has_id && has_method {
        return FrameClass::InvalidFrame(
            "invalid-frame: frame carries both id and method".to_string(),
        );
    }
    if !has_id && !has_method {
        return FrameClass::InvalidFrame(
            "invalid-frame: frame carries neither id nor method".to_string(),
        );
    }
    if has_id {
        let Some(id) = obj.get("id").and_then(|v| v.as_u64()) else {
            return FrameClass::InvalidFrame("invalid-frame: response id must be uint".to_string());
        };
        if let Some(err) = obj.get("error") {
            return FrameClass::ResponseError {
                id,
                error: err.clone(),
            };
        }
        if let Some(res) = obj.get("result") {
            return FrameClass::ResponseOk {
                id,
                result: res.clone(),
            };
        }
        return FrameClass::InvalidFrame(
            "invalid-frame: response missing result and error".to_string(),
        );
    }
    let Some(method) = obj.get("method").and_then(|v| v.as_str()) else {
        return FrameClass::InvalidFrame(
            "invalid-frame: notification method must be string".to_string(),
        );
    };
    if method.is_empty() {
        return FrameClass::InvalidFrame(
            "invalid-frame: notification method must be non-empty".to_string(),
        );
    }
    let params = obj.get("params").unwrap_or(&Value::Null);
    FrameClass::Notification(validate_notification(method, params))
}

#[derive(Debug, Default)]
struct DropBucket {
    pending: u64,
    last_emit: Option<Instant>,
}

/// 1-second rate limiter per drop reason (`AM2 §3.3`, §13 (7g)). No background timer; emits
/// accumulated counts when a subsequent frame runs at least 1 s after the last emission.
#[derive(Debug, Default)]
pub struct DropRateLimiter {
    unknown: DropBucket,
    invalid: DropBucket,
}

impl DropRateLimiter {
    pub fn record_drop(&mut self, reason: &str, now: Instant) -> Option<(&'static str, u64)> {
        let (canonical, bucket) = match reason {
            "unknown-notification" => ("unknown-notification", &mut self.unknown),
            "invalid-notification" => ("invalid-notification", &mut self.invalid),
            _ => return None,
        };
        bucket.pending += 1;
        Self::maybe_flush_bucket(canonical, bucket, now)
    }

    pub fn flush_due(&mut self, now: Instant) -> Vec<(&'static str, u64)> {
        let mut out = Vec::new();
        if let Some(ev) = Self::maybe_flush_bucket("unknown-notification", &mut self.unknown, now) {
            out.push(ev);
        }
        if let Some(ev) = Self::maybe_flush_bucket("invalid-notification", &mut self.invalid, now) {
            out.push(ev);
        }
        out
    }

    fn maybe_flush_bucket(
        reason: &'static str,
        bucket: &mut DropBucket,
        now: Instant,
    ) -> Option<(&'static str, u64)> {
        if bucket.pending == 0 {
            return None;
        }
        let due = match bucket.last_emit {
            None => true,
            Some(prev) => now.saturating_duration_since(prev) >= Duration::from_secs(1),
        };
        if due {
            let count = bucket.pending;
            bucket.pending = 0;
            bucket.last_emit = Some(now);
            Some((reason, count))
        } else {
            None
        }
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
    pub connection_epoch: u64,
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

struct SharedChildInner {
    child: Child,
    reaped: bool,
    exit_status: Option<ExitStatus>,
    kill_issued: bool,
    #[cfg(test)]
    kill_count: u64,
}

/// Lock-guarded `Child` handle shared between the L7 stop worker and the deadline expiry path
/// (`AM2 §6`, C6/C8). The worker acquires the lock only per `try_wait` poll and NEVER holds it
/// across sleep; `kill_once()` goes through `Child::kill()` strictly once and never after reap.
#[derive(Clone)]
struct SharedChild(Arc<Mutex<SharedChildInner>>);

impl SharedChild {
    fn new(child: Child) -> Self {
        Self(Arc::new(Mutex::new(SharedChildInner {
            child,
            reaped: false,
            exit_status: None,
            kill_issued: false,
            #[cfg(test)]
            kill_count: 0,
        })))
    }

    fn try_wait(&self) -> Option<ExitStatus> {
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if g.reaped {
            return g.exit_status;
        }
        if let Ok(Some(status)) = g.child.try_wait() {
            g.reaped = true;
            g.exit_status = Some(status);
            return Some(status);
        }
        None
    }

    #[cfg(unix)]
    fn send_sigterm_if_alive(&self) {
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if g.reaped {
            return;
        }
        if let Ok(Some(status)) = g.child.try_wait() {
            g.reaped = true;
            g.exit_status = Some(status);
            return;
        }
        let pid = g.child.id();
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }

    /// Kill through the lock-guarded `Child` handle at most once, never after reap.
    fn kill_once(&self) -> bool {
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if g.reaped || g.kill_issued {
            return false;
        }
        if let Ok(Some(status)) = g.child.try_wait() {
            g.reaped = true;
            g.exit_status = Some(status);
            return false;
        }
        g.kill_issued = true;
        #[cfg(test)]
        {
            g.kill_count += 1;
        }
        let _ = g.child.kill();
        true
    }

    /// Poll `try_wait` briefly (releasing the lock across sleeps) to reap a killed child.
    fn reap_bounded(&self, max_wait: Duration) -> Option<ExitStatus> {
        let end = Instant::now() + max_wait;
        loop {
            if let Some(status) = self.try_wait() {
                return Some(status);
            }
            if Instant::now() >= end {
                return None;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(test)]
    fn kill_count(&self) -> u64 {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .kill_count
    }

    #[cfg(test)]
    fn is_reaped(&self) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).reaped
    }
}

struct SpawnedServe {
    child: SharedChild,
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
        self.child.try_wait()
    }

    /// Stop `serve` per amendment 1 §5 and return its exit status once reaped:
    /// - Initialized child: close stdin (EOF) first; wait up to 7 s before SIGKILL.
    /// - Never-initialized child: on Unix, SIGTERM first (keeping stdin open so the signal wins
    ///   as first trigger), then SIGKILL after 2 s; on Windows, close stdin first.
    fn stop(&mut self) -> Option<ExitStatus> {
        self.stop_with_grace(INITIALIZED_KILL_GRACE, UNINITIALIZED_KILL_GRACE)
    }

    fn stop_with_grace(
        &mut self,
        initialized_grace: Duration,
        uninitialized_grace: Duration,
    ) -> Option<ExitStatus> {
        let grace = if self.initialized {
            initialized_grace
        } else {
            uninitialized_grace
        };
        self.stop_with_deadline(Instant::now() + grace)
    }

    fn stop_with_deadline(&mut self, deadline: Instant) -> Option<ExitStatus> {
        let grace = if self.initialized {
            INITIALIZED_KILL_GRACE
        } else {
            UNINITIALIZED_KILL_GRACE
        };
        let effective_deadline = deadline.min(Instant::now() + grace);
        if self.initialized {
            // Close stdin (EOF) first (§5 & §4 Windows).
            drop(self.stdin.take());
            while Instant::now() < effective_deadline {
                if let Some(status) = self.child.try_wait() {
                    return Some(status);
                }
                thread::sleep(Duration::from_millis(20));
            }
            self.child.kill_once();
            self.child.reap_bounded(Duration::from_secs(2))
        } else {
            #[cfg(not(unix))]
            drop(self.stdin.take());
            #[cfg(unix)]
            self.child.send_sigterm_if_alive();
            while Instant::now() < effective_deadline {
                if let Some(status) = self.child.try_wait() {
                    drop(self.stdin.take());
                    return Some(status);
                }
                thread::sleep(Duration::from_millis(20));
            }
            self.child.kill_once();
            let status = self.child.reap_bounded(Duration::from_secs(2));
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

pub trait EventSink: Send + Sync + 'static {
    fn emit_engine_event(&self, payload: Value) -> Result<(), String>;
    fn emit_quit_requested(&self, payload: Value) -> Result<(), String>;
}

#[cfg(test)]
#[derive(Default)]
pub struct NullEventSink;

#[cfg(test)]
impl EventSink for NullEventSink {
    fn emit_engine_event(&self, _payload: Value) -> Result<(), String> {
        Ok(())
    }

    fn emit_quit_requested(&self, _payload: Value) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Handshake,
    Open,
    Terminated { reason: &'static str, seq: u64 },
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPhase {
    Outstanding,
    Shown,
    Settled,
}

#[derive(Debug, Clone)]
pub struct QuitRecord {
    pub request_id: u64,
    pub phase: QuitPhase,
    pub expires_at: Instant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueuedEngineEvent {
    pub epoch: u64,
    pub seq: u64,
    pub method: String,
    pub params: Value,
}

struct PendingRpc {
    method: String,
    params: Value,
    thread_id: Option<String>,
    reply_tx: mpsc::SyncSender<Result<Value, String>>,
}

pub struct ClientOwner {
    pub phase: LifecyclePhase,
    pub epoch: u64,
    pub next_seq: u64,
    pub fifo: VecDeque<QueuedEngineEvent>,
    pending: HashMap<u64, PendingRpc>,
    pub late_reply_count: u64,
    pub discarded_notification_count: u64,
    pub emitted_event_count: u64,
    drop_limiter: DropRateLimiter,
    // AM2 §6.1 / L9 close guard (counts only turns admitted on this connection)
    pub pending_starts: HashMap<String, usize>,
    pub pending_starts_total: usize,
    pub in_flight_turn_ids: HashMap<String, String>,
    pub admitted_turn_ids: HashSet<String>,
    pub buffered_turn_events: HashMap<String, Vec<(String, &'static str)>>,
    pub dropped_buffered_turn_events: u64,
    // AM2 §6.1 / L10 quit request & fallback mark
    pub quit_record: Option<QuitRecord>,
    pub quit_fallback_set_at: Option<Instant>,
}

impl ClientOwner {
    pub fn new(epoch: u64) -> Self {
        Self {
            phase: LifecyclePhase::Handshake,
            epoch,
            next_seq: 1,
            fifo: VecDeque::new(),
            pending: HashMap::new(),
            late_reply_count: 0,
            discarded_notification_count: 0,
            emitted_event_count: 0,
            drop_limiter: DropRateLimiter::default(),
            pending_starts: HashMap::new(),
            pending_starts_total: 0,
            in_flight_turn_ids: HashMap::new(),
            admitted_turn_ids: HashSet::new(),
            buffered_turn_events: HashMap::new(),
            dropped_buffered_turn_events: 0,
            quit_record: None,
            quit_fallback_set_at: None,
        }
    }

    pub fn guard_count(&self) -> usize {
        self.pending_starts_total + self.in_flight_turn_ids.len()
    }

    fn fail_pending_and_reset_guard(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        for (_, entry) in pending {
            let _ = entry
                .reply_tx
                .send(Err("engine socket closed before response".to_string()));
        }
        self.pending_starts.clear();
        self.pending_starts_total = 0;
        self.in_flight_turn_ids.clear();
        self.admitted_turn_ids.clear();
        self.buffered_turn_events.clear();
        self.quit_record = None;
        self.quit_fallback_set_at = None;
    }

    /// Enqueue a validated §3.2 forwardable notification (`Handshake` or `Open`, `L2`/`L4`).
    /// Returns `Ok(true)` if `Open -> Terminated(overflow)` occurred, `Err` if `Handshake` overflowed.
    pub fn enqueue_forwardable(&mut self, method: String, params: Value) -> Result<bool, String> {
        match self.phase {
            LifecyclePhase::Handshake => {
                if self.fifo.len() >= FORWARD_QUEUE_CAPACITY {
                    self.fifo.clear();
                    self.fail_pending_and_reset_guard();
                    self.phase = LifecyclePhase::Closed;
                    return Err("overflow: handshake notification queue full".to_string());
                }
                let seq = self.next_seq;
                self.next_seq += 1;
                self.fifo.push_back(QueuedEngineEvent {
                    epoch: self.epoch,
                    seq,
                    method,
                    params,
                });
                Ok(false)
            }
            LifecyclePhase::Open => {
                let seq = self.next_seq;
                self.next_seq += 1;
                if self.fifo.len() >= FORWARD_QUEUE_CAPACITY {
                    // Consumed seq leaves a visible gap before the terminal event (L4).
                    self.enter_terminated("overflow");
                    return Ok(true);
                }
                self.fifo.push_back(QueuedEngineEvent {
                    epoch: self.epoch,
                    seq,
                    method,
                    params,
                });
                Ok(false)
            }
            LifecyclePhase::Terminated { .. } | LifecyclePhase::Closed => Ok(false),
        }
    }

    pub fn record_drop_and_maybe_enqueue(&mut self, reason: &str, now: Instant) -> Result<bool, String> {
        if let Some((r, count)) = self.drop_limiter.record_drop(reason, now) {
            return self.enqueue_forwardable(
                "madc/events-dropped".to_string(),
                json!({ "count": count, "reason": r }),
            );
        }
        Ok(false)
    }

    pub fn flush_due_drops(&mut self, now: Instant) -> Result<bool, String> {
        let due = self.drop_limiter.flush_due(now);
        for (r, count) in due {
            if self.enqueue_forwardable(
                "madc/events-dropped".to_string(),
                json!({ "count": count, "reason": r }),
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn enter_terminated(&mut self, reason: &'static str) -> bool {
        if !matches!(self.phase, LifecyclePhase::Open) {
            return false;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.phase = LifecyclePhase::Terminated { reason, seq };
        self.fail_pending_and_reset_guard();
        true
    }

    /// Execute one drain step INSIDE the owner lock (`L1`, `L3`, `L4`, `L5`).
    /// Returns `Some(true)` if work remains, `Some(false)` if idle-wait in Open, `None` if Closed.
    pub fn drain_step(&mut self, sink: &dyn EventSink) -> Option<bool> {
        match self.phase {
            LifecyclePhase::Handshake => Some(false),
            LifecyclePhase::Open => {
                if let Some(ev) = self.fifo.pop_front() {
                    let payload = json!({
                        "epoch": ev.epoch,
                        "seq": ev.seq,
                        "method": ev.method,
                        "params": ev.params,
                    });
                    let _ = sink.emit_engine_event(payload);
                    self.emitted_event_count += 1;
                    Some(!self.fifo.is_empty())
                } else {
                    Some(false)
                }
            }
            LifecyclePhase::Terminated { reason, seq } => {
                if let Some(ev) = self.fifo.pop_front() {
                    let payload = json!({
                        "epoch": ev.epoch,
                        "seq": ev.seq,
                        "method": ev.method,
                        "params": ev.params,
                    });
                    let _ = sink.emit_engine_event(payload);
                    self.emitted_event_count += 1;
                    Some(true)
                } else {
                    // Emit reserved terminal BEFORE setting Closed so no emit starts in Closed (L3, L5).
                    let payload = json!({
                        "epoch": self.epoch,
                        "seq": seq,
                        "method": "madc/transport-closed",
                        "params": { "reason": reason },
                    });
                    let _ = sink.emit_engine_event(payload);
                    self.emitted_event_count += 1;
                    self.phase = LifecyclePhase::Closed;
                    None
                }
            }
            LifecyclePhase::Closed => None,
        }
    }

    /// Transition from `Handshake`, `Open`, or `Terminated` into `Closed` (`L2`, `L3`, `L4`, `L5`, `L6`).
    /// Emits INSIDE this lock iff the epoch was published (`Open` or `Terminated`). Returns true if published.
    pub fn close_to_closed(&mut self, desktop_reason: &'static str, sink: &dyn EventSink) -> bool {
        match self.phase {
            LifecyclePhase::Handshake => {
                self.fifo.clear();
                self.fail_pending_and_reset_guard();
                self.phase = LifecyclePhase::Closed;
                false
            }
            LifecyclePhase::Open => {
                // Discard remaining ordinary frames; they keep their seq so UI sees a gap (L4).
                self.fifo.clear();
                let seq = self.next_seq;
                self.next_seq += 1;
                self.fail_pending_and_reset_guard();
                let payload = json!({
                    "epoch": self.epoch,
                    "seq": seq,
                    "method": "madc/transport-closed",
                    "params": { "reason": desktop_reason },
                });
                let _ = sink.emit_engine_event(payload);
                self.emitted_event_count += 1;
                self.phase = LifecyclePhase::Closed;
                true
            }
            LifecyclePhase::Terminated { reason, seq } => {
                // Desktop close mid-drain discards remaining ordinary frames and emits reserved terminal (L3, L4).
                self.fifo.clear();
                self.fail_pending_and_reset_guard();
                let payload = json!({
                    "epoch": self.epoch,
                    "seq": seq,
                    "method": "madc/transport-closed",
                    "params": { "reason": reason },
                });
                let _ = sink.emit_engine_event(payload);
                self.emitted_event_count += 1;
                self.phase = LifecyclePhase::Closed;
                true
            }
            LifecyclePhase::Closed => false,
        }
    }

    /// Track `turn/started` or `turn/completed` notifications in close guard (`L9`, §6.1 item 1, C2).
    pub fn observe_turn_notification(&mut self, method: &str, params: &Value) {
        if !matches!(self.phase, LifecyclePhase::Open) {
            return;
        }
        let Some(turn) = params.get("turn").and_then(|v| v.as_object()) else {
            return;
        };
        let Some(turn_id) = turn.get("id").and_then(|v| v.as_str()) else {
            return;
        };
        let Some(thread_id) = turn.get("threadId").and_then(|v| v.as_str()) else {
            return;
        };
        match method {
            "turn/started" => {
                if self.in_flight_turn_ids.contains_key(turn_id) {
                    return;
                }
                if self.pending_starts.get(thread_id).copied().unwrap_or(0) == 1 {
                    let buf = self
                        .buffered_turn_events
                        .entry(thread_id.to_string())
                        .or_default();
                    let entry = (turn_id.to_string(), "started");
                    if !buf.contains(&entry) {
                        if buf.len() >= MAX_BUFFERED_TURN_EVENTS_PER_START {
                            self.dropped_buffered_turn_events += 1;
                        } else {
                            buf.push(entry);
                        }
                    }
                }
            }
            "turn/completed" => {
                if self.in_flight_turn_ids.remove(turn_id).is_some() {
                    return;
                }
                if self.pending_starts.get(thread_id).copied().unwrap_or(0) == 1 {
                    let buf = self
                        .buffered_turn_events
                        .entry(thread_id.to_string())
                        .or_default();
                    let entry = (turn_id.to_string(), "completed");
                    if !buf.contains(&entry) {
                        if buf.len() >= MAX_BUFFERED_TURN_EVENTS_PER_START {
                            self.dropped_buffered_turn_events += 1;
                        } else {
                            buf.push(entry);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// Complete admitting or rejecting a `turn/start` RPC response inside the owner (`L9`, C2).
    /// Returns `Err` (F2 `invalid-frame`) if `admitted_turn_id` was already admitted on this connection.
    pub fn finish_pending_turn_start(
        &mut self,
        thread_id: &str,
        admitted_turn_id: Option<&str>,
    ) -> Result<(), String> {
        if let Some(cnt) = self.pending_starts.get_mut(thread_id) {
            *cnt = cnt.saturating_sub(1);
            if *cnt == 0 {
                self.pending_starts.remove(thread_id);
            }
            self.pending_starts_total = self.pending_starts_total.saturating_sub(1);
        }
        let buffered = self
            .buffered_turn_events
            .remove(thread_id)
            .unwrap_or_default();
        if let Some(tid) = admitted_turn_id {
            if self.in_flight_turn_ids.contains_key(tid) || self.admitted_turn_ids.contains(tid) {
                return Err(format!("invalid-frame: duplicate turn/start turn id {tid}"));
            }
            self.admitted_turn_ids.insert(tid.to_string());
            self.in_flight_turn_ids
                .insert(tid.to_string(), thread_id.to_string());
            for (ev_turn_id, kind) in buffered {
                if ev_turn_id == tid && kind == "completed" {
                    self.in_flight_turn_ids.remove(tid);
                }
            }
        }
        Ok(())
    }

    fn expire_outstanding_if_due(&mut self, now: Instant) {
        if let Some(ref mut rec) = self.quit_record {
            if rec.phase == QuitPhase::Outstanding && now >= rec.expires_at {
                rec.phase = QuitPhase::Settled;
                self.quit_fallback_set_at = Some(rec.expires_at);
            }
        }
    }

    /// Close/exit guard + quit lifecycle decision inside the owner (`L1`, `L9`, `L10`, `L13`).
    pub fn evaluate_close_request_at(
        &mut self,
        exit_started_flag: bool,
        sink: &dyn EventSink,
        now: Instant,
    ) -> CloseDecision {
        // Check exit_started FIRST before guard (T-L13 invariant).
        if exit_started_flag {
            return CloseDecision::Coalesce;
        }
        if !matches!(self.phase, LifecyclePhase::Open) {
            return CloseDecision::AllowExit;
        }
        self.expire_outstanding_if_due(now);
        let fallback_live = self
            .quit_fallback_set_at
            .is_some_and(|t| now.saturating_duration_since(t) < QUIT_FALLBACK_TTL);
        if self.guard_count() == 0 || fallback_live {
            self.close_to_closed("exit", sink);
            return CloseDecision::AllowExit;
        }
        match self.quit_record {
            Some(ref rec) if rec.phase == QuitPhase::Outstanding => {
                CloseDecision::PreventAlreadyPending
            }
            Some(ref rec) if rec.phase == QuitPhase::Shown => {
                let req_id = rec.request_id;
                let payload = json!({ "epoch": self.epoch, "requestId": req_id });
                if sink.emit_quit_requested(payload).is_err() {
                    if let Some(ref mut r) = self.quit_record {
                        r.phase = QuitPhase::Settled;
                    }
                    self.quit_fallback_set_at = Some(now);
                }
                CloseDecision::PreventQuitRequested {
                    epoch: self.epoch,
                    request_id: req_id,
                }
            }
            _ => {
                let req_id = NEXT_QUIT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
                self.quit_record = Some(QuitRecord {
                    request_id: req_id,
                    phase: QuitPhase::Outstanding,
                    expires_at: now + QUIT_SHOWN_ACK_BOUND,
                });
                let payload = json!({ "epoch": self.epoch, "requestId": req_id });
                if sink.emit_quit_requested(payload).is_err() {
                    if let Some(ref mut r) = self.quit_record {
                        r.phase = QuitPhase::Settled;
                    }
                    self.quit_fallback_set_at = Some(now);
                }
                CloseDecision::PreventQuitRequested {
                    epoch: self.epoch,
                    request_id: req_id,
                }
            }
        }
    }

    pub fn quit_dialog_shown_at(&mut self, epoch: u64, request_id: u64, now: Instant) -> bool {
        if !matches!(self.phase, LifecyclePhase::Open) || self.epoch != epoch {
            return false;
        }
        self.expire_outstanding_if_due(now);
        match self.quit_record {
            Some(ref mut rec) if rec.request_id == request_id && rec.phase == QuitPhase::Outstanding => {
                rec.phase = QuitPhase::Shown;
                true
            }
            Some(ref rec) if rec.request_id == request_id && rec.phase == QuitPhase::Shown => true,
            _ => false,
        }
    }

    pub fn ack_quit_at(&mut self, epoch: u64, request_id: u64, now: Instant) -> bool {
        if !matches!(self.phase, LifecyclePhase::Open) || self.epoch != epoch {
            return false;
        }
        self.expire_outstanding_if_due(now);
        match self.quit_record {
            Some(ref mut rec)
                if rec.request_id == request_id
                    && matches!(rec.phase, QuitPhase::Outstanding | QuitPhase::Shown) =>
            {
                rec.phase = QuitPhase::Settled;
                true
            }
            _ => false,
        }
    }

    pub fn confirm_quit_at(
        &mut self,
        epoch: u64,
        request_id: u64,
        sink: &dyn EventSink,
        now: Instant,
    ) -> bool {
        if !matches!(self.phase, LifecyclePhase::Open) || self.epoch != epoch {
            return false;
        }
        self.expire_outstanding_if_due(now);
        let ok = matches!(
            self.quit_record,
            Some(ref rec)
                if rec.request_id == request_id
                    && matches!(rec.phase, QuitPhase::Outstanding | QuitPhase::Shown)
        );
        if !ok {
            return false;
        }
        if let Some(ref mut rec) = self.quit_record {
            rec.phase = QuitPhase::Settled;
        }
        self.close_to_closed("exit", sink);
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuitCommandResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    AllowExit,
    PreventQuitRequested { epoch: u64, request_id: u64 },
    PreventAlreadyPending,
    Coalesce,
}

pub type StopWorkerSpawner = Arc<
    dyn Fn(Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<thread::JoinHandle<()>>
        + Send
        + Sync,
>;

#[derive(Clone, Default)]
pub struct TestStopHooks {
    pub delay_l7: Option<Duration>,
    pub spawner: Option<StopWorkerSpawner>,
    pub on_l7_thread: Option<Arc<dyn Fn(thread::ThreadId) + Send + Sync>>,
    pub on_inline_fallback: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_before_response_relock: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[cfg(unix)]
struct StopInFlight {
    done: Arc<(Mutex<bool>, Condvar)>,
    shared_child: Option<SharedChild>,
}

#[cfg(unix)]
pub(crate) struct StopState {
    cancel_stream: Option<UnixStream>,
    spawned: Option<SpawnedServe>,
    in_flight: Option<Arc<StopInFlight>>,
    #[allow(dead_code)]
    reader_done: Arc<AtomicBool>,
    hooks: Option<Arc<TestStopHooks>>,
}

/// Start (or join) bounded L7 stop work and wait up to `deadline`, issuing a single lock-guarded
/// `Child::kill()` on expiry (`AM2 §6` Expiry / C6 / C8). Used by waiting callers (`RunEvent::Exit`,
/// `disconnect_engine`, `confirm_quit`, R4 cleanup, `Drop`).
#[cfg(unix)]
pub(crate) fn stop_child(stop_arc: &Arc<Mutex<StopState>>, deadline: Instant) {
    stop_child_inner(stop_arc, deadline, true);
}

/// Hand off L7 stop work to the worker thread and return immediately without blocking the Tauri
/// event loop (`AM2 §6`, C1/M-1). The only exception is worker thread spawn failure, which runs the
/// bounded inline fallback on the caller's thread outside `stop_state` and `owner`.
#[cfg(unix)]
pub(crate) fn stop_child_async(stop_arc: &Arc<Mutex<StopState>>, deadline: Instant) {
    stop_child_inner(stop_arc, deadline, false);
}

#[cfg(unix)]
fn stop_child_inner(
    stop_arc: &Arc<Mutex<StopState>>,
    deadline: Instant,
    wait_for_done: bool,
) {
    let existing_or_start = {
        let mut g = match stop_arc.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(existing) = g.in_flight.clone() {
            Err(existing)
        } else {
            let cancel = g.cancel_stream.take();
            let spawned = g.spawned.take();
            let shared_child = spawned.as_ref().map(|s| s.child.clone());
            let done = Arc::new((Mutex::new(false), Condvar::new()));
            let hooks = g.hooks.clone();
            let record = Arc::new(StopInFlight {
                done: Arc::clone(&done),
                shared_child,
            });
            g.in_flight = Some(Arc::clone(&record));
            Ok((record, cancel, spawned, done, hooks))
        }
    };
    // `stop_state` guard is dropped before thread spawn or inline fallback.

    let in_flight = match existing_or_start {
        Err(existing) => existing,
        Ok((record, cancel, spawned, done, hooks)) => {
            // Keep `(cancel, spawned)` in a shared slot so if thread spawn fails (`Err`),
            // ownership is returned to the caller for the real inline fallback (`AM2 §6` Spawn failure).
            let work_slot: Arc<Mutex<Option<(Option<UnixStream>, Option<SpawnedServe>)>>> =
                Arc::new(Mutex::new(Some((cancel, spawned))));
            let slot_for_worker = Arc::clone(&work_slot);
            let done_for_worker = Arc::clone(&done);
            let hooks_for_worker = hooks.clone();

            let worker_fn: Box<dyn FnOnce() + Send + 'static> = Box::new(move || {
                let work = slot_for_worker
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                if let Some((c, s)) = work {
                    run_l7_work(c, s, deadline, &done_for_worker, hooks_for_worker.as_deref());
                }
            });

            let spawn_res = if let Some(spawner) = hooks.as_ref().and_then(|h| h.spawner.as_ref()) {
                spawner(worker_fn)
            } else {
                thread::Builder::new()
                    .name("madc-l7-stop".to_string())
                    .spawn(worker_fn)
            };

            match spawn_res {
                Ok(_jh) => record,
                Err(_) => {
                    // Real spawn-failure path (`AM2 §6` Spawn failure, H-2): runs inline on the
                    // caller's thread with `stop_state` unlocked and never inside `owner`.
                    if let Some(cb) = hooks.as_ref().and_then(|h| h.on_inline_fallback.as_ref()) {
                        cb();
                    }
                    let work = work_slot.lock().unwrap_or_else(|p| p.into_inner()).take();
                    if let Some((c, s)) = work {
                        run_l7_work(c, s, deadline, &done, hooks.as_deref());
                    } else {
                        let (lk, cv) = &*done;
                        if let Ok(mut d) = lk.lock() {
                            *d = true;
                            cv.notify_all();
                        }
                    }
                    return;
                }
            }
        }
    };

    if !wait_for_done {
        return;
    }

    let (lk, cv) = &*in_flight.done;
    let mut finished = match lk.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    while !*finished {
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() {
            if let Some(ref shared_child) = in_flight.shared_child {
                shared_child.kill_once();
                let _ = shared_child.reap_bounded(Duration::from_millis(100));
            }
            return;
        }
        let (next, _) = match cv.wait_timeout(finished, rem) {
            Ok(v) => v,
            Err(p) => p.into_inner(),
        };
        finished = next;
    }
}

#[cfg(unix)]
fn run_l7_work(
    cancel: Option<UnixStream>,
    mut spawned: Option<SpawnedServe>,
    deadline: Instant,
    done: &(Mutex<bool>, Condvar),
    hooks: Option<&TestStopHooks>,
) {
    if let Some(h) = hooks {
        if let Some(cb) = &h.on_l7_thread {
            cb(thread::current().id());
        }
    }
    if let Some(stream) = cancel {
        let _ = stream.shutdown(Shutdown::Both);
        drop(stream);
    }
    if let Some(h) = hooks {
        if let Some(d) = h.delay_l7 {
            thread::sleep(d);
        }
    }
    if let Some(ref mut child) = spawned {
        let _ = child.stop_with_deadline(deadline);
    }
    let (lk, cv) = done;
    if let Ok(mut g) = lk.lock() {
        *g = true;
        cv.notify_all();
    }
}

#[cfg(unix)]
struct HandshakeClient {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
    line_buf: Vec<u8>,
    owner: Arc<Mutex<ClientOwner>>,
    sink: Arc<dyn EventSink>,
    info: ConnectionInfo,
}

#[cfg(unix)]
impl Drop for HandshakeClient {
    fn drop(&mut self) {
        if let Ok(mut o) = self.owner.lock() {
            if matches!(o.phase, LifecyclePhase::Handshake) {
                o.close_to_closed("handshake-drop", &*self.sink);
            }
        }
    }
}

#[cfg(unix)]
struct SocketClientInner {
    owner: Arc<Mutex<ClientOwner>>,
    drain_cv: Arc<Condvar>,
    write_half: Mutex<Option<UnixStream>>,
    next_id: AtomicU64,
    stop_state: Arc<Mutex<StopState>>,
    sink: Arc<dyn EventSink>,
}

#[cfg(unix)]
impl Drop for SocketClientInner {
    fn drop(&mut self) {
        if let Ok(mut o) = self.owner.lock() {
            o.close_to_closed("disconnect", &*self.sink);
        }
        self.drain_cv.notify_all();
        stop_child(&self.stop_state, Instant::now() + DISCONNECT_STOP_BOUND);
    }
}

#[cfg(unix)]
#[derive(Clone)]
pub struct SocketClient {
    inner: Arc<SocketClientInner>,
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
impl HandshakeClient {
    fn handshake_request_with_deadline(
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

            match read_bounded_line(&mut self.reader, &mut self.line_buf) {
                BoundedLine::Line(resp_line) => {
                    if resp_line.trim().is_empty() {
                        continue;
                    }
                    match classify_incoming_frame(&resp_line) {
                        FrameClass::ResponseError { id: resp_id, error } => {
                            if resp_id != id {
                                if let Ok(mut o) = self.owner.lock() {
                                    o.late_reply_count += 1;
                                }
                                continue;
                            }
                            return Err(format!("engine RPC error: {error}"));
                        }
                        FrameClass::ResponseOk { id: resp_id, result } => {
                            if resp_id != id {
                                if let Ok(mut o) = self.owner.lock() {
                                    o.late_reply_count += 1;
                                }
                                continue;
                            }
                            return Ok(result);
                        }
                        FrameClass::Notification(verdict) => {
                            let mut o = self
                                .owner
                                .lock()
                                .map_err(|_| "owner lock poisoned".to_string())?;
                            match verdict {
                                NotificationVerdict::Forwardable { method: m, params: p } => {
                                    o.enqueue_forwardable(m, p)?;
                                }
                                NotificationVerdict::Discard => {
                                    o.discarded_notification_count += 1;
                                }
                                NotificationVerdict::UnknownNotification => {
                                    o.record_drop_and_maybe_enqueue(
                                        "unknown-notification",
                                        Instant::now(),
                                    )?;
                                }
                                NotificationVerdict::InvalidNotification { terminal } => {
                                    if terminal {
                                        return Err(
                                            "invalid-frame: malformed turn/completed notification"
                                                .to_string(),
                                        );
                                    }
                                    o.record_drop_and_maybe_enqueue(
                                        "invalid-notification",
                                        Instant::now(),
                                    )?;
                                }
                            }
                        }
                        FrameClass::InvalidFrame(msg) => return Err(msg),
                    }
                }
                BoundedLine::Eof => {
                    return Err("engine socket closed before response".to_string());
                }
                BoundedLine::Oversize => {
                    return Err("oversize-frame: line exceeded 8388608 bytes".to_string());
                }
                BoundedLine::InvalidUtf8 => {
                    return Err("invalid-frame: non-UTF-8 byte sequence".to_string());
                }
                BoundedLine::ReadError(_, msg) => {
                    return Err(format!("socket read failed: {msg}"));
                }
            }
        }
    }

    fn publish_open(
        mut self,
        spawned: Option<SpawnedServe>,
        hooks: Option<Arc<TestStopHooks>>,
    ) -> Result<SocketClient, String> {
        // AM2 §2.2 (iii): clear read timeout once before reader starts; never re-arm SO_RCVTIMEO.
        // Note: on macOS, if peer closed right after initialize, setsockopt returns EINVAL; reader immediately observes EOF.
        let _ = self.reader.get_ref().set_read_timeout(None);
        let _ = self.writer.set_write_timeout(Some(INTERACTIVE_RPC_TIMEOUT));
        let cancel_stream = self
            .reader
            .get_ref()
            .try_clone()
            .map_err(|e| format!("socket clone for cancel handle failed: {e}"))?;

        let reader = std::mem::replace(&mut self.reader, {
            // dummy replaced below; move stream out cleanly using ManuallyDrop or take pattern?
            // Wait: simpler cleanly via cloning/taking? Actually HandshakeClient doesn't need Drop once transferred!
            BufReader::new(
                cancel_stream
                    .try_clone()
                    .map_err(|e| format!("socket clone failed: {e}"))?,
            )
        });
        let writer = self
            .writer
            .try_clone()
            .map_err(|e| format!("writer clone failed: {e}"))?;
        let line_buf = std::mem::take(&mut self.line_buf);
        let owner = Arc::clone(&self.owner);
        let sink = Arc::clone(&self.sink);
        let info = self.info.clone();
        let next_id = self.next_id;

        {
            let mut o = owner
                .lock()
                .map_err(|_| "owner lock poisoned".to_string())?;
            if !matches!(o.phase, LifecyclePhase::Handshake) {
                return Err("handshake already ended before Open".to_string());
            }
            o.phase = LifecyclePhase::Open;
        }
        // Defuse HandshakeClient Drop cleanly because phase is now Open.
        std::mem::forget(self);

        let before_relock = hooks
            .as_ref()
            .and_then(|h| h.on_before_response_relock.clone());
        let drain_cv = Arc::new(Condvar::new());
        let reader_done = Arc::new(AtomicBool::new(false));
        let stop_state = Arc::new(Mutex::new(StopState {
            cancel_stream: Some(cancel_stream),
            spawned,
            in_flight: None,
            reader_done: Arc::clone(&reader_done),
            hooks,
        }));

        let inner = Arc::new(SocketClientInner {
            owner: Arc::clone(&owner),
            drain_cv: Arc::clone(&drain_cv),
            write_half: Mutex::new(Some(writer)),
            next_id: AtomicU64::new(next_id),
            stop_state: Arc::clone(&stop_state),
            sink: Arc::clone(&sink),
        });

        // Spawn single emitter/drain thread (waits cleanly via Condvar on owner mutex).
        thread::Builder::new()
            .name("madc-drain".to_string())
            .spawn({
                let owner_d = Arc::clone(&owner);
                let cv_d = Arc::clone(&drain_cv);
                let sink_d = Arc::clone(&sink);
                move || {
                    drain_thread_loop(owner_d, cv_d, sink_d);
                }
            })
            .map_err(|e| format!("failed to spawn drain thread: {e}"))?;

        // Wake drain immediately if handshake staged any notifications (L2 / T-L2).
        drain_cv.notify_all();

        // Spawn dedicated reader thread (sole owner of read half).
        thread::Builder::new()
            .name("madc-reader".to_string())
            .spawn({
                let owner_r = Arc::clone(&owner);
                let cv_r = Arc::clone(&drain_cv);
                let done_r = Arc::clone(&reader_done);
                move || {
                    reader_thread_loop(reader, line_buf, owner_r, cv_r, done_r, before_relock);
                }
            })
            .map_err(|e| format!("failed to spawn reader thread: {e}"))?;

        Ok(SocketClient { inner, info })
    }
}

#[cfg(unix)]
fn drain_thread_loop(
    owner: Arc<Mutex<ClientOwner>>,
    cv: Arc<Condvar>,
    sink: Arc<dyn EventSink>,
) {
    let mut guard = match owner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    loop {
        match guard.drain_step(&*sink) {
            None => return,
            Some(true) => {
                // Release lock briefly between items so desktop close / reader can interleave (L5).
                drop(guard);
                thread::yield_now();
                guard = match owner.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
            }
            Some(false) => {
                guard = match cv.wait(guard) {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
            }
        }
    }
}

#[cfg(unix)]
fn reader_thread_loop(
    mut reader: BufReader<UnixStream>,
    mut line_buf: Vec<u8>,
    owner: Arc<Mutex<ClientOwner>>,
    cv: Arc<Condvar>,
    reader_done: Arc<AtomicBool>,
    before_response_relock: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    loop {
        let terminal_reason: Option<&'static str> = match read_bounded_line(&mut reader, &mut line_buf)
        {
            BoundedLine::Line(line) => {
                if line.trim().is_empty() {
                    let mut o = owner.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = o.flush_due_drops(Instant::now());
                    cv.notify_all();
                    continue;
                }
                match classify_incoming_frame(&line) {
                    FrameClass::ResponseOk { id, result } => {
                        let entry_opt = {
                            let mut o = owner.lock().unwrap_or_else(|p| p.into_inner());
                            let _ = o.flush_due_drops(Instant::now());
                            if !matches!(o.phase, LifecyclePhase::Open) {
                                break;
                            }
                            let popped = o.pending.remove(&id);
                            if popped.is_none() {
                                o.late_reply_count += 1;
                                cv.notify_all();
                            }
                            popped
                        };
                        if let Some(entry) = entry_opt {
                            // Closed shape validation OUTSIDE owner lock (L1).
                            let valid = validate_rpc_result(&entry.method, &entry.params, &result);
                            if let Some(ref hook) = before_response_relock {
                                hook();
                            }
                            let mut o = owner.lock().unwrap_or_else(|p| p.into_inner());
                            // L-4: Re-check phase after relocking; if no longer Open, fail waiter
                            // with the exact L6 string and do not admit any turn or deliver success.
                            if !matches!(o.phase, LifecyclePhase::Open) {
                                let _ = entry.reply_tx.send(Err(
                                    "engine socket closed before response".to_string(),
                                ));
                                cv.notify_all();
                                break;
                            }
                            if !valid {
                                if let Some(ref tid) = entry.thread_id {
                                    if entry.method == "turn/start" {
                                        let _ = o.finish_pending_turn_start(tid, None);
                                    }
                                }
                                o.enter_terminated("invalid-frame");
                                let _ = entry.reply_tx.send(Err(format!(
                                    "invalid-frame: {} result failed closed shape check",
                                    entry.method
                                )));
                                cv.notify_all();
                                break;
                            }
                            if entry.method == "turn/start" {
                                if let Some(ref tid) = entry.thread_id {
                                    let turn_id = result["turn"]["id"].as_str();
                                    if let Err(dup_err) = o.finish_pending_turn_start(tid, turn_id)
                                    {
                                        // M-2 (C2): Duplicate admitted turn.id -> F2 invalid-frame.
                                        o.enter_terminated("invalid-frame");
                                        let _ = entry.reply_tx.send(Err(dup_err));
                                        cv.notify_all();
                                        break;
                                    }
                                }
                            }
                            let _ = entry.reply_tx.send(Ok(result));
                            cv.notify_all();
                        }
                        None
                    }
                    FrameClass::ResponseError { id, error } => {
                        let mut o = owner.lock().unwrap_or_else(|p| p.into_inner());
                        let _ = o.flush_due_drops(Instant::now());
                        if !matches!(o.phase, LifecyclePhase::Open) {
                            break;
                        }
                        if let Some(entry) = o.pending.remove(&id) {
                            if entry.method == "turn/start" {
                                if let Some(ref tid) = entry.thread_id {
                                    let _ = o.finish_pending_turn_start(tid, None);
                                }
                            }
                            let _ = entry.reply_tx.send(Err(format!("engine RPC error: {error}")));
                        } else {
                            o.late_reply_count += 1;
                        }
                        cv.notify_all();
                        None
                    }
                    FrameClass::Notification(verdict) => {
                        let mut o = owner.lock().unwrap_or_else(|p| p.into_inner());
                        if matches!(o.flush_due_drops(Instant::now()), Ok(true)) {
                            cv.notify_all();
                            break;
                        }
                        let mut overflowed = false;
                        let mut term: Option<&'static str> = None;
                        match verdict {
                            NotificationVerdict::Forwardable { method, params } => {
                                if method == "turn/started" || method == "turn/completed" {
                                    o.observe_turn_notification(&method, &params);
                                }
                                if matches!(o.enqueue_forwardable(method, params), Ok(true)) {
                                    overflowed = true;
                                }
                            }
                            NotificationVerdict::Discard => {
                                o.discarded_notification_count += 1;
                            }
                            NotificationVerdict::UnknownNotification => {
                                if matches!(
                                    o.record_drop_and_maybe_enqueue(
                                        "unknown-notification",
                                        Instant::now()
                                    ),
                                    Ok(true)
                                ) {
                                    overflowed = true;
                                }
                            }
                            NotificationVerdict::InvalidNotification { terminal } => {
                                if terminal {
                                    term = Some("invalid-frame");
                                } else if matches!(
                                    o.record_drop_and_maybe_enqueue(
                                        "invalid-notification",
                                        Instant::now()
                                    ),
                                    Ok(true)
                                ) {
                                    overflowed = true;
                                }
                            }
                        }
                        if overflowed {
                            cv.notify_all();
                            break;
                        }
                        term
                    }
                    FrameClass::InvalidFrame(_) => Some("invalid-frame"),
                }
            }
            BoundedLine::Eof => Some("eof"),
            BoundedLine::Oversize => Some("oversize-frame"),
            BoundedLine::InvalidUtf8 => Some("invalid-frame"),
            BoundedLine::ReadError(_, _) => Some("read-error"),
        };

        if let Some(reason) = terminal_reason {
            let mut o = owner.lock().unwrap_or_else(|p| p.into_inner());
            o.enter_terminated(reason);
            cv.notify_all();
            break;
        }
    }
    let _ = reader.get_ref().shutdown(Shutdown::Both);
    reader_done.store(true, Ordering::Release);
}

#[cfg(unix)]
impl SocketClient {
    #[cfg(test)]
    pub fn connect_existing_for_test(socket_path: &str) -> Result<Self, String> {
        Self::connect_existing_with_sink(socket_path, Arc::new(NullEventSink))
    }

    #[cfg(test)]
    pub fn connect_existing_with_sink(
        socket_path: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<Self, String> {
        Self::connect_existing_with_sink_and_hooks(socket_path, sink, None, None)
    }

    #[cfg(test)]
    fn connect_existing_with_sink_and_hooks(
        socket_path: &str,
        sink: Arc<dyn EventSink>,
        spawned: Option<SpawnedServe>,
        hooks: Option<Arc<TestStopHooks>>,
    ) -> Result<Self, String> {
        let started_at = Instant::now();
        let hs = Self::handshake_with_connector(
            socket_path,
            Duration::from_secs(2),
            spawned.is_none(),
            started_at,
            sink,
            |p| UnixStream::connect(p),
        )?;
        hs.publish_open(spawned, hooks)
    }

    #[cfg(test)]
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

    #[cfg(test)]
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
        Self::handshake_with_connector(
            socket_path,
            timeout,
            reused_existing,
            started_at,
            Arc::new(NullEventSink),
            connector,
        )?
        .publish_open(None, None)
    }

    fn handshake_and_initialize(
        socket_path: &str,
        timeout: Duration,
        reused_existing: bool,
        started_at: Instant,
        sink: Arc<dyn EventSink>,
    ) -> Result<HandshakeClient, String> {
        Self::handshake_with_connector(
            socket_path,
            timeout,
            reused_existing,
            started_at,
            sink,
            |p| UnixStream::connect(p),
        )
    }

    fn handshake_with_connector<F>(
        socket_path: &str,
        timeout: Duration,
        reused_existing: bool,
        started_at: Instant,
        sink: Arc<dyn EventSink>,
        connector: F,
    ) -> Result<HandshakeClient, String>
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
        let epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed);
        let mut hs = HandshakeClient {
            reader: BufReader::new(stream),
            writer,
            next_id: 1,
            line_buf: Vec::new(),
            owner: Arc::new(Mutex::new(ClientOwner::new(epoch))),
            sink,
            info: ConnectionInfo {
                socket_path: socket_path.to_string(),
                reused_existing,
                protocol_version: String::new(),
                server_name: String::new(),
                server_version: String::new(),
                cold_start_ms: 0,
                connection_epoch: epoch,
            },
        };

        let init_result = hs.handshake_request_with_deadline(
            "initialize",
            json!({
                "clientInfo": { "name": "madc-desktop", "version": "0.0.0" },
                "capabilities": { "subscribeRoom": true }
            }),
            deadline,
        )?;

        let (protocol_version, server_name, server_version) =
            validate_initialize_result(&init_result)?;

        hs.info = ConnectionInfo {
            socket_path: socket_path.to_string(),
            reused_existing,
            protocol_version,
            server_name,
            server_version,
            cold_start_ms: started_at.elapsed().as_millis() as u64,
            connection_epoch: epoch,
        };
        Ok(hs)
    }

    pub fn is_open(&self) -> bool {
        self.inner
            .owner
            .lock()
            .map(|o| matches!(o.phase, LifecyclePhase::Open))
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub fn reader_done(&self) -> bool {
        self.inner
            .stop_state
            .lock()
            .map(|s| s.reader_done.load(Ordering::Acquire))
            .unwrap_or(true)
    }

    #[cfg(test)]
    pub fn late_reply_count(&self) -> u64 {
        self.inner
            .owner
            .lock()
            .map(|o| o.late_reply_count)
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub fn discarded_notification_count(&self) -> u64 {
        self.inner
            .owner
            .lock()
            .map(|o| o.discarded_notification_count)
            .unwrap_or(0)
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_deadline(method, params, Instant::now() + INTERACTIVE_RPC_TIMEOUT)
    }

    fn request_with_deadline(
        &self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });
        let mut line = serde_json::to_string(&payload)
            .map_err(|e| format!("failed to serialize request: {e}"))?;
        line.push('\n');

        let (reply_tx, reply_rx) = mpsc::sync_channel::<Result<Value, String>>(1);
        let thread_id = if method == "turn/start" {
            params
                .get("threadId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        } else {
            None
        };

        {
            let mut o = self
                .inner
                .owner
                .lock()
                .map_err(|_| "owner lock poisoned".to_string())?;
            if !matches!(o.phase, LifecyclePhase::Open) {
                return Err("engine socket closed before response".to_string());
            }
            if method == "turn/start" {
                if let Some(ref tid) = thread_id {
                    *o.pending_starts.entry(tid.clone()).or_insert(0) += 1;
                    o.pending_starts_total += 1;
                }
            }
            o.pending.insert(
                id,
                PendingRpc {
                    method: method.to_string(),
                    params,
                    thread_id: thread_id.clone(),
                    reply_tx,
                },
            );
        }

        let write_res = {
            match lock_with_deadline(&self.inner.write_half, deadline) {
                None => Err(format!("RPC {method} timed out before write")),
                Some(mut w_guard) => {
                    // H-1: compute remaining write timeout AFTER acquiring write_half so a queued
                    // writer never exceeds the request deadline.
                    let write_rem = deadline.saturating_duration_since(Instant::now());
                    if write_rem.is_zero() {
                        Err(format!("RPC {method} timed out before write"))
                    } else {
                        match w_guard.as_mut() {
                            None => Err("engine socket closed before response".to_string()),
                            Some(stream) => {
                                let _ = stream.set_write_timeout(Some(write_rem));
                                stream
                                    .write_all(line.as_bytes())
                                    .map_err(|e| format!("socket write failed: {e}"))
                                    .and_then(|_| {
                                        stream
                                            .flush()
                                            .map_err(|e| format!("socket flush failed: {e}"))
                                    })
                            }
                        }
                    }
                }
            }
        };

        if let Err(err_msg) = write_res {
            let mut o = self.inner.owner.lock().unwrap_or_else(|p| p.into_inner());
            if o.pending.remove(&id).is_some() && method == "turn/start" {
                if let Some(ref tid) = thread_id {
                    let _ = o.finish_pending_turn_start(tid, None);
                }
            }
            return Err(err_msg);
        }

        let wait_rem = deadline.saturating_duration_since(Instant::now());
        match reply_rx.recv_timeout(wait_rem) {
            Ok(res) => res,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut o = self.inner.owner.lock().unwrap_or_else(|p| p.into_inner());
                if o.pending.remove(&id).is_some() && method == "turn/start" {
                    if let Some(ref tid) = thread_id {
                        let _ = o.finish_pending_turn_start(tid, None);
                    }
                }
                Err(format!("RPC {method} timed out waiting for reply"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("engine socket closed before response".to_string())
            }
        }
    }

    pub fn close_and_stop(&self, desktop_reason: &'static str, deadline: Instant) {
        let _published = {
            let mut o = self.inner.owner.lock().unwrap_or_else(|p| p.into_inner());
            o.close_to_closed(desktop_reason, &*self.inner.sink)
        };
        self.inner.drain_cv.notify_all();
        // H-1: never wait on write_half without a deadline; on expiry proceed to stop_child.
        let write_lock_deadline = deadline.min(Instant::now() + EXIT_LOCK_WAIT);
        if let Some(mut wg) = lock_with_deadline(&self.inner.write_half, write_lock_deadline) {
            let _ = wg.take();
        }
        stop_child(&self.inner.stop_state, deadline);
    }

    #[cfg(test)]
    pub fn disconnect(self) {
        self.close_and_stop("disconnect", Instant::now() + DISCONNECT_STOP_BOUND);
    }
}

#[cfg(all(unix, test))]
pub fn connect_or_spawn(config: &LaunchConfig) -> Result<SocketClient, String> {
    connect_or_spawn_with_sink(config, Arc::new(NullEventSink))
}

#[cfg(unix)]
pub fn connect_or_spawn_with_sink(
    config: &LaunchConfig,
    sink: Arc<dyn EventSink>,
) -> Result<SocketClient, String> {
    connect_or_spawn_with_timeouts(config, PROBE_TIMEOUT, START_WINDOW, sink)
}

#[cfg(all(unix, test))]
fn connect_or_spawn_with_window(
    config: &LaunchConfig,
    start_window: Duration,
) -> Result<SocketClient, String> {
    connect_or_spawn_with_timeouts(
        config,
        PROBE_TIMEOUT,
        start_window,
        Arc::new(NullEventSink),
    )
}

#[cfg(unix)]
fn connect_or_spawn_with_timeouts(
    config: &LaunchConfig,
    probe_timeout: Duration,
    start_window: Duration,
    sink: Arc<dyn EventSink>,
) -> Result<SocketClient, String> {
    let started_at = Instant::now();

    if let Some(socket_path) = try_engine_socket_path(&config.home)? {
        if let Ok(hs) = SocketClient::handshake_and_initialize(
            &socket_path,
            probe_timeout,
            true,
            started_at,
            Arc::clone(&sink),
        ) {
            return hs.publish_open(None, None);
        }
    }

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
        child: SharedChild::new(child),
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

    let deadline = Instant::now() + start_window;
    while Instant::now() < deadline {
        if let Some(status) = spawned.try_wait_status() {
            let code = status.code();
            let signal = status.signal();
            let class = classify_exit(code, signal, false);
            if code == Some(20) {
                while Instant::now() < deadline {
                    if let Ok(Some(socket_path)) = try_engine_socket_path(&config.home) {
                        let rem = deadline
                            .saturating_duration_since(Instant::now())
                            .min(PROBE_TIMEOUT);
                        if !rem.is_zero() {
                            if let Ok(hs) = SocketClient::handshake_and_initialize(
                                &socket_path,
                                rem,
                                true,
                                started_at,
                                Arc::clone(&sink),
                            ) {
                                return hs.publish_open(None, None);
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
                if let Ok(hs) = SocketClient::handshake_and_initialize(
                    &socket_path,
                    rem,
                    false,
                    started_at,
                    Arc::clone(&sink),
                ) {
                    spawned.initialized = true;
                    return hs.publish_open(Some(spawned), None);
                }
            }
        }
        thread::sleep(Duration::from_millis(20));
    }

    let status = spawned.stop();
    let code = status.and_then(|s| s.code());
    let signal = status.and_then(|s| s.signal());
    let stderr_text = spawned.drain_stderr(STDERR_DRAIN_TIMEOUT);
    Err(format!(
        "madc-engine serve did not complete initialize within {} ms (exit code={code:?}, signal={signal:?}).\nstderr:\n{stderr_text}",
        start_window.as_millis()
    ))
}

#[cfg(unix)]
fn lock_with_deadline<'a, T>(
    m: &'a Mutex<T>,
    deadline: Instant,
) -> Option<std::sync::MutexGuard<'a, T>> {
    loop {
        match m.try_lock() {
            Ok(g) => return Some(g),
            Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return None;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[cfg(unix)]
pub struct DesktopController {
    pub exit_started: AtomicBool,
    pub shutting_down: AtomicBool,
    pub connect_mutex: Mutex<()>,
    pub client: Mutex<Option<SocketClient>>,
    pub(crate) stop_fallback: Mutex<Option<Arc<Mutex<StopState>>>>,
    pub first_starter_at: Mutex<Option<Instant>>,
}

#[cfg(unix)]
impl Default for DesktopController {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(unix)]
impl DesktopController {
    pub fn new() -> Self {
        Self {
            exit_started: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            connect_mutex: Mutex::new(()),
            client: Mutex::new(None),
            stop_fallback: Mutex::new(None),
            first_starter_at: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub fn set_client_for_test(&self, client: SocketClient) {
        *self.stop_fallback.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::clone(&client.inner.stop_state));
        *self.client.lock().unwrap_or_else(|p| p.into_inner()) = Some(client);
    }

    fn peek_first_starter(&self) -> Option<Instant> {
        *self
            .first_starter_at
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn record_or_get_first_starter(&self, now: Instant) -> Instant {
        let mut g = self
            .first_starter_at
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match *g {
            Some(t) => t,
            None => {
                *g = Some(now);
                now
            }
        }
    }

    pub fn connect_engine_blocking(
        &self,
        config: &LaunchConfig,
        sink: Arc<dyn EventSink>,
    ) -> Result<ConnectionInfo, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("desktop shutting down".to_string());
        }
        let _connect_guard = self
            .connect_mutex
            .lock()
            .map_err(|_| "connect lock poisoned".to_string())?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("desktop shutting down".to_string());
        }

        let stale = {
            let mut guard = self
                .client
                .lock()
                .map_err(|_| "engine state lock poisoned".to_string())?;
            if let Some(existing) = guard.as_ref() {
                if existing.is_open() {
                    return Ok(existing.info.clone());
                }
            }
            guard.take()
        };

        if let Some(stale_client) = stale {
            stale_client.close_and_stop("disconnect", Instant::now() + DISCONNECT_STOP_BOUND);
        }

        if self.shutting_down.load(Ordering::Acquire) {
            return Err("desktop shutting down".to_string());
        }

        let new_client = connect_or_spawn_with_sink(config, sink)?;
        if self.shutting_down.load(Ordering::Acquire) {
            new_client.close_and_stop("exit", Instant::now() + DISCONNECT_STOP_BOUND);
            return Err("desktop shutting down".to_string());
        }
        if !new_client.is_open() {
            new_client.close_and_stop("disconnect", Instant::now() + DISCONNECT_STOP_BOUND);
            return Err("engine socket closed during connect".to_string());
        }
        let info = new_client.info.clone();
        *self.stop_fallback.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::clone(&new_client.inner.stop_state));
        *self
            .client
            .lock()
            .map_err(|_| "engine state lock poisoned".to_string())? = Some(new_client);
        Ok(info)
    }

    pub fn rpc_request_blocking(&self, method: &str, params: Value) -> Result<Value, String> {
        validate_rpc_method(method)?;
        validate_rpc_params(method, &params)?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("desktop shutting down".to_string());
        }
        let client_opt = {
            let guard = self
                .client
                .lock()
                .map_err(|_| "engine state lock poisoned".to_string())?;
            guard.clone()
        };
        let Some(client) = client_opt else {
            return Err("not connected to @madc/engine".to_string());
        };
        if !client.is_open() {
            return Err("engine socket closed before response".to_string());
        }
        client.request(method, params)
    }

    pub fn disconnect_engine_blocking(&self) -> Result<(), String> {
        let taken = {
            let mut guard = self
                .client
                .lock()
                .map_err(|_| "engine state lock poisoned".to_string())?;
            guard.take()
        };
        if let Some(client) = taken {
            client.close_and_stop("disconnect", Instant::now() + DISCONNECT_STOP_BOUND);
        }
        Ok(())
    }

    /// Close/exit request decision (`CloseRequested` or `ExitRequested` on the Tauri event loop).
    /// Hands L7 stop work to the worker thread and returns without waiting on `AllowExit` (`M-1`/C1);
    /// shares one `EXIT_LOCK_WAIT` deadline across `client`, `owner`, and `write_half` (`H-1`).
    pub fn handle_close_or_exit_at(&self, sink: &dyn EventSink, now: Instant) -> CloseDecision {
        if self.exit_started.load(Ordering::Acquire) {
            return CloseDecision::Coalesce;
        }
        let lock_deadline = self.peek_first_starter().unwrap_or(now) + EXIT_LOCK_WAIT;
        let client_opt = match lock_with_deadline(&self.client, lock_deadline) {
            Some(g) => g.clone(),
            None => {
                // Wedged past EXIT_LOCK_WAIT: allow close & hand off fallback stop within EXIT_BOUND.
                let first_seen = self.record_or_get_first_starter(now);
                self.shutting_down.store(true, Ordering::Release);
                self.exit_started.store(true, Ordering::Release);
                if let Some(fb) = self
                    .stop_fallback
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                {
                    stop_child_async(&fb, first_seen + EXIT_BOUND);
                }
                return CloseDecision::AllowExit;
            }
        };

        let Some(client) = client_opt else {
            let first_seen = self.record_or_get_first_starter(now);
            self.shutting_down.store(true, Ordering::Release);
            self.exit_started.store(true, Ordering::Release);
            if let Some(fb) = self
                .stop_fallback
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
            {
                stop_child_async(&fb, first_seen + EXIT_BOUND);
            }
            return CloseDecision::AllowExit;
        };

        let decision = {
            let Some(mut owner_g) = lock_with_deadline(&client.inner.owner, lock_deadline) else {
                let first_seen = self.record_or_get_first_starter(now);
                self.shutting_down.store(true, Ordering::Release);
                self.exit_started.store(true, Ordering::Release);
                let stop_arc = Arc::clone(&client.inner.stop_state);
                drop(client);
                stop_child_async(&stop_arc, first_seen + EXIT_BOUND);
                return CloseDecision::AllowExit;
            };
            let already_exiting = self.exit_started.load(Ordering::Acquire);
            let dec = owner_g.evaluate_close_request_at(already_exiting, sink, now);
            if dec == CloseDecision::AllowExit {
                self.record_or_get_first_starter(now);
                self.shutting_down.store(true, Ordering::Release);
                self.exit_started.store(true, Ordering::Release);
            }
            dec
        };

        if decision == CloseDecision::AllowExit {
            client.inner.drain_cv.notify_all();
            let first_seen = self.record_or_get_first_starter(now);
            let shared_lock_deadline = first_seen + EXIT_LOCK_WAIT;
            if let Some(mut wg) =
                lock_with_deadline(&client.inner.write_half, shared_lock_deadline)
            {
                let _ = wg.take();
            }
            stop_child_async(&client.inner.stop_state, first_seen + EXIT_BOUND);
        }
        decision
    }

    pub fn quit_dialog_shown_at(
        &self,
        epoch: u64,
        request_id: u64,
        now: Instant,
    ) -> QuitCommandResult {
        if self.exit_started.load(Ordering::Acquire) {
            return QuitCommandResult { accepted: false };
        }
        let client_opt = self
            .client
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let Some(client) = client_opt else {
            return QuitCommandResult { accepted: false };
        };
        let mut o = client.inner.owner.lock().unwrap_or_else(|p| p.into_inner());
        QuitCommandResult {
            accepted: o.quit_dialog_shown_at(epoch, request_id, now),
        }
    }

    pub fn ack_quit_at(&self, epoch: u64, request_id: u64, now: Instant) -> QuitCommandResult {
        if self.exit_started.load(Ordering::Acquire) {
            return QuitCommandResult { accepted: false };
        }
        let client_opt = self
            .client
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let Some(client) = client_opt else {
            return QuitCommandResult { accepted: false };
        };
        let mut o = client.inner.owner.lock().unwrap_or_else(|p| p.into_inner());
        QuitCommandResult {
            accepted: o.ack_quit_at(epoch, request_id, now),
        }
    }

    pub fn confirm_quit_at(
        &self,
        epoch: u64,
        request_id: u64,
        sink: &dyn EventSink,
        now: Instant,
    ) -> QuitCommandResult {
        if self.exit_started.load(Ordering::Acquire) {
            return QuitCommandResult { accepted: false };
        }
        let lock_deadline = self.peek_first_starter().unwrap_or(now) + EXIT_LOCK_WAIT;
        let Some(client) = lock_with_deadline(&self.client, lock_deadline).and_then(|g| g.clone())
        else {
            return QuitCommandResult { accepted: false };
        };
        let accepted = {
            let Some(mut o) = lock_with_deadline(&client.inner.owner, lock_deadline) else {
                return QuitCommandResult { accepted: false };
            };
            if self.exit_started.load(Ordering::Acquire) {
                return QuitCommandResult { accepted: false };
            }
            let ok = o.confirm_quit_at(epoch, request_id, sink, now);
            if ok {
                self.record_or_get_first_starter(now);
                self.shutting_down.store(true, Ordering::Release);
                self.exit_started.store(true, Ordering::Release);
            }
            ok
        };
        if accepted {
            client.inner.drain_cv.notify_all();
            let first_seen = self.record_or_get_first_starter(now);
            let shared_lock_deadline = first_seen + EXIT_LOCK_WAIT;
            if let Some(mut wg) =
                lock_with_deadline(&client.inner.write_half, shared_lock_deadline)
            {
                let _ = wg.take();
            }
            stop_child(&client.inner.stop_state, first_seen + EXIT_BOUND);
        }
        QuitCommandResult { accepted }
    }

    /// `RunEvent::Exit`: NEVER dropped (`AM2 §6`, `L13`). Shares one `EXIT_LOCK_WAIT` (2 s) across
    /// `client`, `owner`, and `write_half` (`H-1`); falls back to `stop_fallback` if wedged; never
    /// extends `EXIT_BOUND` (9 s).
    pub fn handle_run_event_exit(&self, sink: &dyn EventSink, now: Instant) {
        let first_seen = self.record_or_get_first_starter(now);
        let lock_deadline = first_seen + EXIT_LOCK_WAIT;
        let bound_deadline = first_seen + EXIT_BOUND;

        self.shutting_down.store(true, Ordering::Release);

        let client_opt = lock_with_deadline(&self.client, lock_deadline).and_then(|mut g| g.take());
        let mut stop_target = self
            .stop_fallback
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();

        if let Some(ref client) = client_opt {
            stop_target = Some(Arc::clone(&client.inner.stop_state));
            if !self.exit_started.load(Ordering::Acquire) {
                if let Some(mut owner_g) = lock_with_deadline(&client.inner.owner, lock_deadline) {
                    if !self.exit_started.swap(true, Ordering::AcqRel) {
                        owner_g.close_to_closed("exit", sink);
                    }
                } else {
                    self.exit_started.store(true, Ordering::Release);
                }
            }
            client.inner.drain_cv.notify_all();
            if let Some(mut wg) = lock_with_deadline(&client.inner.write_half, lock_deadline) {
                let _ = wg.take();
            }
        } else {
            self.exit_started.store(true, Ordering::Release);
        }

        if let Some(stop_arc) = stop_target {
            stop_child(&stop_arc, bound_deadline);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

    #[test]
    fn rpc_allowlist_permits_only_m3_a4_methods() {
        for allowed in [
            "initialize",
            "room/inspect",
            "session/search",
            "session/read",
            "seat/list",
            "thread/start",
            "turn/start",
            "turn/interrupt",
        ] {
            assert!(
                validate_rpc_method(allowed).is_ok(),
                "expected allowed method {allowed}"
            );
        }
        for denied in [
            "thread/resume",
            "thread/list",
            "thread/handoff",
            "provider/list",
            "auth/status",
            "auth/remove",
            "auth/set",
            "decision/raise",
            "decision/list",
            "decision/resolve",
            "room/inspect ",
            "turn/start ",
            "TURN/START",
            "",
        ] {
            let err = validate_rpc_method(denied).expect_err("expected disallowed method");
            assert!(
                err.starts_with("RPC method not allowed by M3-A2 desktop shell: "),
                "unexpected err prefix: {err}"
            );
        }
    }

    #[test]
    fn validate_rpc_params_enforces_r5_without_echoing_keys() {
        assert!(validate_rpc_params("seat/list", &json!({})).is_ok());
        assert!(validate_rpc_params("room/inspect", &json!({})).is_ok());
        let seat_extra = validate_rpc_params("seat/list", &json!({ "secretExtraKey": 1 }))
            .expect_err("seat/list rejects unknown keys");
        assert!(seat_extra.starts_with("RPC params refused by desktop shell for seat/list: "));
        assert!(!seat_extra.contains("secretExtraKey"));

        assert!(validate_rpc_params("thread/start", &json!({})).is_ok());
        assert!(
            validate_rpc_params(
                "thread/start",
                &json!({ "seatId": "seat-1", "cwd": "/tmp/work" })
            )
            .is_ok()
        );
        let rel_cwd = validate_rpc_params("thread/start", &json!({ "cwd": "relative/dir" }))
            .expect_err("relative cwd must be rejected");
        assert!(rel_cwd.starts_with("RPC params refused by desktop shell for thread/start: "));
        assert!(validate_rpc_params("thread/start", &json!({ "cwd": "" })).is_err());
        assert!(validate_rpc_params("thread/start", &json!({ "cwd": "/tmp/\0bad" })).is_err());
        assert!(
            validate_rpc_params("thread/start", &json!({ "cwd": format!("/{}", "a".repeat(4096)) }))
                .is_err()
        );
        assert!(validate_rpc_params("thread/start", &json!({ "seatId": "../bad" })).is_err());
        let ts_extra =
            validate_rpc_params("thread/start", &json!({ "unknownFieldProbe": true }))
                .expect_err("unknown key must be rejected");
        assert!(!ts_extra.contains("unknownFieldProbe"));

        assert!(
            validate_rpc_params(
                "turn/start",
                &json!({
                    "threadId": "thr_1",
                    "input": [{ "type": "text", "text": "hello" }]
                })
            )
            .is_ok()
        );
        assert!(
            validate_rpc_params(
                "turn/start",
                &json!({
                    "threadId": "thr_1",
                    "input": [{ "type": "text", "text": "hello" }],
                    "mode": "headless"
                })
            )
            .is_ok()
        );
        let mode_int = validate_rpc_params(
            "turn/start",
            &json!({
                "threadId": "thr_1",
                "input": [{ "type": "text", "text": "hello" }],
                "mode": "interactive"
            }),
        )
        .expect_err("interactive mode must be refused");
        assert_eq!(
            mode_int,
            "RPC params refused by desktop shell for turn/start: mode must be absent or \"headless\""
        );
        assert!(
            validate_rpc_params(
                "turn/start",
                &json!({
                    "threadId": "thr_1",
                    "input": [{ "type": "text", "text": "   " }]
                })
            )
            .is_err()
        );
        assert!(
            validate_rpc_params(
                "turn/start",
                &json!({
                    "threadId": "thr_1",
                    "input": [
                        { "type": "text", "text": "a" },
                        { "type": "text", "text": "b" }
                    ]
                })
            )
            .is_err()
        );
        assert!(
            validate_rpc_params(
                "turn/start",
                &json!({
                    "threadId": "thr_1",
                    "input": [{ "type": "text", "text": "a", "extra": 1 }]
                })
            )
            .is_err()
        );
        assert!(
            validate_rpc_params(
                "turn/start",
                &json!({
                    "threadId": "thr_1",
                    "input": [{ "type": "text", "text": "x".repeat(65_537) }]
                })
            )
            .is_err()
        );

        assert!(
            validate_rpc_params(
                "turn/interrupt",
                &json!({ "threadId": "thr_1", "turnId": "turn_1" })
            )
            .is_ok()
        );
        assert!(
            validate_rpc_params(
                "turn/interrupt",
                &json!({ "threadId": "thr_1", "turnId": "turn_1", "extra": 1 })
            )
            .is_err()
        );
        assert!(validate_rpc_params("turn/interrupt", &json!({ "threadId": "thr_1" })).is_err());

        // Static source check: R5 params validator must never reference disconnect.
        let src = include_str!("launcher.rs");
        let start = src.find("pub fn validate_rpc_params").unwrap();
        let end = src[start..].find("\n/// Append a chunk").unwrap() + start;
        assert!(
            !src[start..end].contains("disconnect"),
            "validate_rpc_params must not contain disconnect"
        );
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
            child: SharedChild::new(child),
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
        let c1 = connect_or_spawn(&cfg).expect("cold-start connect_or_spawn");
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
        let c2 = connect_or_spawn(&cfg).expect("second launcher reuse");
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

    #[cfg(unix)]
    #[test]
    fn probe_timeout_is_pinned_at_1s_and_enforced_by_connect_or_spawn_a3_r4() {
        // Pin amendment 1 §2 line 47: "within 1 s (connect plus reply)".
        assert_eq!(PROBE_TIMEOUT, Duration::from_secs(1));

        let home = PathBuf::from(format!("/tmp/madc-dt-a3-r4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");
        let sock_path = home.join("engine.sock");
        // Helper: bind a stalled listener at `engine.sock` that accepts ONE probe connection,
        // keeps that connection open without replying (forcing the probe to hit its timeout), and
        // immediately drops the listener + removes `engine.sock` so the post-spawn loop does not
        // re-probe the stale test listener after `connect_or_spawn` falls through to spawning.
        let spawn_one_shot_stalled_listener = |sock: PathBuf| {
            let listener = UnixListener::bind(&sock).expect("bind stalled listener");
            let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);
            let handle = thread::spawn(move || {
                let _ = listener.set_nonblocking(true);
                let mut held: Option<UnixStream> = None;
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                    if held.is_none() {
                        if let Ok((conn, _)) = listener.accept() {
                            held = Some(conn);
                            // Remove the socket path now that the initial probe holds `conn` open;
                            // `listener` is not accepted again, so post-spawn probing sees ENOENT.
                            let _ = std::fs::remove_file(&sock);
                            break;
                        }
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                // Drop `listener` while keeping `held` open until the test stops us or deadline.
                drop(listener);
                let _ = stop_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
                drop(held);
            });
            (stop_tx, handle)
        };

        let fake_serve = home.join("exit2-serve.sh");
        std::fs::write(&fake_serve, "#!/bin/sh\necho 'fallback-spawn-marker' >&2\nexit 2\n")
            .expect("write fake serve");
        std::fs::set_permissions(&fake_serve, std::fs::Permissions::from_mode(0o700))
            .expect("chmod fake serve");
        let cfg = LaunchConfig {
            home: home.clone(),
            runtime_bin: "/bin/sh".to_string(),
            engine_entry: fake_serve,
        };

        // 1. Production `connect_or_spawn` cuts off a stalled listener at PROBE_TIMEOUT (1 s)
        //    and falls through to spawning `serve` (guards N14a production wiring at :566).
        let (stop1, handle1) = spawn_one_shot_stalled_listener(sock_path.clone());
        let t0 = Instant::now();
        let err = match connect_or_spawn(&cfg) {
            Ok(_) => panic!("expected fake serve exit 2 after stalled 1 s probe"),
            Err(e) => e,
        };
        let elapsed_prod = t0.elapsed();
        let _ = stop1.send(());
        let _ = handle1.join();
        assert!(err.contains("fallback-spawn-marker"), "got: {err}");
        assert!(
            elapsed_prod >= Duration::from_millis(850) && elapsed_prod <= Duration::from_millis(1500),
            "production PROBE_TIMEOUT (1 s) not honored by connect_or_spawn: elapsed={elapsed_prod:?}"
        );

        // 2. Injectable shorter probe timeout (200 ms) cuts off stalled listener at ~200 ms,
        //    proving connect_or_spawn_with_timeouts honors its timeout parameter.
        let (stop2, handle2) = spawn_one_shot_stalled_listener(sock_path);
        let t1 = Instant::now();
        let err2 = match connect_or_spawn_with_timeouts(
            &cfg,
            Duration::from_millis(200),
            Duration::from_millis(200),
            Arc::new(NullEventSink),
        ) {
            Ok(_) => panic!("expected fake serve exit 2 after stalled 200 ms probe"),
            Err(e) => e,
        };
        let elapsed_short = t1.elapsed();
        let _ = stop2.send(());
        let _ = handle2.join();
        assert!(err2.contains("fallback-spawn-marker"), "got: {err2}");
        assert!(
            elapsed_short >= Duration::from_millis(170) && elapsed_short < Duration::from_millis(750),
            "injectable probe timeout (200 ms) not honored: elapsed={elapsed_short:?}"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn initialized_kill_grace_is_pinned_at_7s_and_enforced_by_stop_a3_r5() {
        // Pin amendment 1 §5 line 131: wait 7 s before SIGKILL for an initialized child.
        assert_eq!(INITIALIZED_KILL_GRACE, Duration::from_secs(7));
        assert_eq!(UNINITIALIZED_KILL_GRACE, Duration::from_secs(2));

        // 1. Production `stop()` waits through a ~3 s post-EOF shutdown (strictly between
        //    UNINITIALIZED_KILL_GRACE = 2 s and INITIALIZED_KILL_GRACE = 7 s) without killing
        //    early (guards N14b production wiring at :282).
        {
            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; sleep 3; exit 0")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn clean-after-eof child");
            let stdin = child.stdin.take();
            let mut spawned = SpawnedServe {
                child: SharedChild::new(child),
                stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            };
            let t0 = Instant::now();
            let status = spawned.stop().expect("child exit status");
            let elapsed = t0.elapsed();
            assert_eq!(
                status.code(),
                Some(0),
                "expected clean exit 0 within 7 s grace, got {status:?}"
            );
            assert!(
                elapsed >= Duration::from_millis(2700) && elapsed < Duration::from_secs(6),
                "unexpected clean stop duration: {elapsed:?}"
            );
        }

        // 2. An initialized child that ignores stdin EOF is cut off with SIGKILL at the grace bound.
        {
            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; exec sleep 10")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn stuck-after-eof child");
            let stdin = child.stdin.take();
            let mut spawned = SpawnedServe {
                child: SharedChild::new(child),
                stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            };
            let t0 = Instant::now();
            let status = spawned
                .stop_with_grace(Duration::from_millis(200), UNINITIALIZED_KILL_GRACE)
                .expect("killed child exit status");
            let elapsed = t0.elapsed();
            assert_eq!(
                status.signal(),
                Some(libc::SIGKILL),
                "expected SIGKILL after grace elapsed, got {status:?}"
            );
            assert!(
                elapsed >= Duration::from_millis(180) && elapsed < Duration::from_millis(1000),
                "stop_with_grace(200 ms) did not enforce bound: elapsed={elapsed:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn start_window_is_pinned_at_5s_and_enforced_by_connect_or_spawn_b1a() {
        // Pin amendment 1 §5 line 128: wait up to 5 s for `initialize` after spawning.
        assert_eq!(START_WINDOW, Duration::from_secs(5));

        let home = PathBuf::from(format!("/tmp/madc-dt-b1a-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir home");

        let fake_serve = home.join("never-binds-serve.sh");
        std::fs::write(
            &fake_serve,
            "#!/bin/sh\necho 'never-binds-b1a' >&2\nexec sleep 40\n",
        )
        .expect("write fake serve");
        std::fs::set_permissions(&fake_serve, std::fs::Permissions::from_mode(0o700))
            .expect("chmod fake serve");

        let cfg = LaunchConfig {
            home: home.clone(),
            runtime_bin: "/bin/sh".to_string(),
            engine_entry: fake_serve,
        };

        let t0 = Instant::now();
        let err = match connect_or_spawn(&cfg) {
            Ok(_) => panic!("expected START_WINDOW timeout when spawned serve never binds socket"),
            Err(e) => e,
        };
        let elapsed = t0.elapsed();

        assert!(
            err.contains("did not complete initialize within 5000 ms"),
            "expected 5000 ms START_WINDOW timeout message, got: {err}"
        );
        assert!(
            err.contains("never-binds-b1a"),
            "expected drained stderr marker, got: {err}"
        );
        assert!(
            elapsed >= Duration::from_millis(4500) && elapsed <= Duration::from_millis(6500),
            "production connect_or_spawn did not enforce START_WINDOW (5 s): elapsed={elapsed:?}"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn uninitialized_child_ignoring_sigterm_and_eof_is_killed_at_2s_grace_b1b() {
        // Pin amendment 1 §5 line 130: SIGTERM, then SIGKILL 2 s later for never-initialized child.
        assert_eq!(UNINITIALIZED_KILL_GRACE, Duration::from_secs(2));

        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; echo READY; exec sleep 40")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn uninitialized sigterm-ignoring child");

        let stdin = child.stdin.take();
        {
            let stdout = child.stdout.take().expect("piped stdout");
            let mut reader = BufReader::new(stdout);
            let mut ready = String::new();
            reader.read_line(&mut ready).expect("read READY line");
            assert_eq!(ready.trim(), "READY");
        }

        let mut spawned = SpawnedServe {
            child: SharedChild::new(child),
            stdin,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stderr_done: None,
            stderr_thread: None,
            initialized: false,
        };

        let t0 = Instant::now();
        let status = spawned.stop().expect("killed child exit status");
        let elapsed = t0.elapsed();

        assert_eq!(
            status.signal(),
            Some(libc::SIGKILL),
            "expected SIGKILL after 2 s uninitialized grace, got {status:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(1800) && elapsed <= Duration::from_millis(3200),
            "production stop() did not enforce 2 s uninitialized grace: elapsed={elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn initialized_child_ignoring_eof_is_killed_at_7s_grace_b2() {
        // Pin amendment 1 §5 line 131: wait 7 s after stdin EOF before SIGKILL.
        assert_eq!(INITIALIZED_KILL_GRACE, Duration::from_secs(7));

        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("cat >/dev/null; exec sleep 40")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn initialized eof-ignoring child");

        let stdin = child.stdin.take();
        let mut spawned = SpawnedServe {
            child: SharedChild::new(child),
            stdin,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stderr_done: None,
            stderr_thread: None,
            initialized: true,
        };

        let t0 = Instant::now();
        let status = spawned.stop().expect("killed child exit status");
        let elapsed = t0.elapsed();

        assert_eq!(
            status.signal(),
            Some(libc::SIGKILL),
            "expected SIGKILL after 7 s initialized grace, got {status:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(6500) && elapsed <= Duration::from_millis(8500),
            "production stop() did not enforce 7 s initialized grace (6.5..=8.5 s): elapsed={elapsed:?}"
        );
    }

    #[test]
    fn bounded_line_reader_enforces_8_mib_cap_and_handles_64_mib_unterminated_s2_4() {
        // M-6 (R2): pin literal 8_388_608 (8 MiB) accept and 8_388_609 Oversize so raising MAX_LINE_BYTES fails.
        assert_eq!(MAX_LINE_BYTES, 8_388_608);

        // Exact 8_388_608 bytes + \n passes.
        let mut exact = vec![b'a'; 8_388_608];
        exact.push(b'\n');
        let mut r_exact = BufReader::new(std::io::Cursor::new(exact));
        let mut buf = Vec::new();
        match read_bounded_line(&mut r_exact, &mut buf) {
            BoundedLine::Line(s) => assert_eq!(s.len(), 8_388_608),
            other => panic!("expected Line for exact 8_388_608 bytes, got {other:?}"),
        }
        assert!(buf.capacity() <= 8_388_608 + 1);

        // 8_388_609 bytes + \n fails immediately as Oversize.
        let mut over = vec![b'b'; 8_388_609];
        over.push(b'\n');
        let mut r_over = BufReader::new(std::io::Cursor::new(over));
        buf.clear();
        assert_eq!(
            read_bounded_line(&mut r_over, &mut buf),
            BoundedLine::Oversize
        );
        assert!(buf.capacity() <= 8_388_608 + 1);

        // Unterminated 64 MiB stream stops near 8_388_609 without reading the rest.
        struct HugeZeroReader {
            remaining: usize,
            total_read: usize,
        }
        impl Read for HugeZeroReader {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.remaining == 0 {
                    return Ok(0);
                }
                let n = out.len().min(self.remaining);
                for b in &mut out[..n] {
                    *b = b'x';
                }
                self.remaining -= n;
                self.total_read += n;
                Ok(n)
            }
        }
        let chunk_reader = HugeZeroReader {
            remaining: 64 * 1024 * 1024,
            total_read: 0,
        };
        let mut br = BufReader::with_capacity(8192, chunk_reader);
        let mut fresh_buf = Vec::new();
        assert_eq!(
            read_bounded_line(&mut br, &mut fresh_buf),
            BoundedLine::Oversize
        );
        assert!(
            br.get_ref().total_read <= 8_388_609 + 8192,
            "reader consumed too much: {}",
            br.get_ref().total_read
        );
        assert!(
            fresh_buf.capacity() <= 8_388_609,
            "buffer capacity exceeded bound: {}",
            fresh_buf.capacity()
        );

        // Non-UTF-8 returns InvalidUtf8; unterminated followed by EOF returns Eof.
        let mut bad_utf8 = BufReader::new(std::io::Cursor::new(vec![0xff, 0xfe, b'\n']));
        assert_eq!(
            read_bounded_line(&mut bad_utf8, &mut fresh_buf),
            BoundedLine::InvalidUtf8
        );
        let mut partial_eof = BufReader::new(std::io::Cursor::new(b"{\"partial\":true".to_vec()));
        assert_eq!(
            read_bounded_line(&mut partial_eof, &mut fresh_buf),
            BoundedLine::Eof
        );

        // Killed mutation check: request_with_deadline / reader path must never use read_line.
        let src = include_str!("launcher.rs");
        let prod_end = src.find("#[cfg(test)]\nmod tests").unwrap();
        assert!(
            !src[..prod_end].contains(".read_line("),
            "production code must use read_bounded_line, never BufRead::read_line"
        );
    }

    #[cfg(unix)]
    #[test]
    fn handshake_and_request_preserve_notifications_and_ignore_late_replies_s2_3_3b() {
        let tmp = std::env::temp_dir().join(format!("madc-s2-3b-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let peer = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            let mut lbuf = Vec::new();
            // Read initialize
            let BoundedLine::Line(req1) = read_bounded_line(&mut reader, &mut lbuf) else {
                panic!("expected init req");
            };
            let v1: Value = serde_json::from_str(&req1).unwrap();
            // Send a room/updated BEFORE replying to initialize (§2.3 / L2)
            writeln!(
                writer,
                "{}",
                json!({"method":"room/updated","params":{"reason":"thread","threadId":"thr_hs"}})
            )
            .unwrap();
            writeln!(
                writer,
                "{}",
                json!({"id": v1["id"], "result": {"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})
            )
            .unwrap();
            writer.flush().unwrap();

            // Read second RPC (seat/list)
            let BoundedLine::Line(req2) = read_bounded_line(&mut reader, &mut lbuf) else {
                panic!("expected seat/list req");
            };
            let v2: Value = serde_json::from_str(&req2).unwrap();
            // Send late reply for wrong id 999 + turn/started + item/agentMessage/delta + real reply
            writeln!(writer, "{}", json!({"id": 999, "result": {}})).unwrap();
            writeln!(
                writer,
                "{}",
                json!({"method":"turn/started","params":{"turn":{"id":"turn_1","threadId":"thr_hs","status":"inProgress","items":[],"error":null,"startedAt":100,"completedAt":null}}})
            )
            .unwrap();
            writeln!(
                writer,
                "{}",
                json!({"method":"item/agentMessage/delta","params":{"threadId":"thr_hs","turnId":"turn_1","itemId":"item_1","delta":"hi"}})
            )
            .unwrap();
            writeln!(writer, "{}", json!({"id": v2["id"], "result": {"data": []}})).unwrap();
            writer.flush().unwrap();

            // Read third RPC (room/inspect) that receives only notification and times out
            let BoundedLine::Line(_) = read_bounded_line(&mut reader, &mut lbuf) else {
                panic!("expected room/inspect req");
            };
            writeln!(
                writer,
                "{}",
                json!({"method":"room/updated","params":{"reason":"turn","threadId":"thr_hs"}})
            )
            .unwrap();
            writer.flush().unwrap();
            thread::sleep(Duration::from_millis(350));
        });

        #[derive(Default)]
        struct CaptureSink {
            events: Mutex<Vec<Value>>,
        }
        impl EventSink for CaptureSink {
            fn emit_engine_event(&self, payload: Value) -> Result<(), String> {
                self.events.lock().unwrap().push(payload);
                Ok(())
            }
            fn emit_quit_requested(&self, _payload: Value) -> Result<(), String> {
                Ok(())
            }
        }
        let sink = Arc::new(CaptureSink::default());
        let client = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .expect("connect must succeed with staged notification");

        let res = client
            .request("seat/list", json!({}))
            .expect("seat/list succeeds");
        assert_eq!(res, json!({"data": []}));
        assert_eq!(client.late_reply_count(), 1);
        assert_eq!(client.discarded_notification_count(), 1);

        let timeout_err = client
            .request_with_deadline(
                "room/inspect",
                json!({}),
                Instant::now() + Duration::from_millis(120),
            )
            .expect_err("expected timeout with no matching reply");
        assert!(
            timeout_err.contains("timed out") || timeout_err.contains("failed"),
            "got: {timeout_err}"
        );
        let wait_deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < wait_deadline {
            if sink.events.lock().unwrap().len() >= 3 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let evs = sink.events.lock().unwrap();
        assert!(
            evs.len() >= 3 && evs.len() <= 4,
            "staged + in-flight + pre-timeout notifications (plus optional trailing eof) must emit, got {evs:?}"
        );
        assert_eq!(evs[0]["method"], "room/updated");
        assert_eq!(evs[0]["seq"], 1);
        assert_eq!(evs[1]["method"], "turn/started");
        assert_eq!(evs[1]["seq"], 2);
        assert_eq!(evs[2]["method"], "room/updated");
        assert_eq!(evs[2]["seq"], 3);
        if evs.len() == 4 {
            assert_eq!(evs[3]["method"], "madc/transport-closed");
            assert_eq!(evs[3]["seq"], 4);
        }
        drop(evs);
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn notifications_frames_and_drop_limiter_match_s3_2_1_f10_7g_7h_4b() {
        // F2 invalid frames
        assert!(matches!(classify_incoming_frame("not json"), FrameClass::InvalidFrame(_)));
        assert!(matches!(classify_incoming_frame("[]"), FrameClass::InvalidFrame(_)));
        assert!(matches!(classify_incoming_frame("{\"id\":1,\"method\":\"x\"}"), FrameClass::InvalidFrame(_)));
        assert!(matches!(classify_incoming_frame("{}"), FrameClass::InvalidFrame(_)));

        // F10 (7h): madc/* is UnknownNotification, never Forwardable
        for m in ["madc/transport-closed", "madc/events-dropped", "madc/anything"] {
            assert_eq!(
                validate_notification(m, &json!({"reason": "eof", "count": 1})),
                NotificationVerdict::UnknownNotification,
                "F10 failed for {m}"
            );
        }

        // Discarded notifications (§3.2)
        assert_eq!(
            validate_notification("item/started", &json!({})),
            NotificationVerdict::Discard
        );
        assert_eq!(
            validate_notification("item/agentMessage/delta", &json!({})),
            NotificationVerdict::Discard
        );

        // Shape table §3.2.1 (a)-(e)
        assert!(matches!(
            validate_notification("room/updated", &json!({"reason":"turn","threadId":"thr_1"})),
            NotificationVerdict::Forwardable { .. }
        ));
        assert_eq!(
            validate_notification("room/updated", &json!({"reason":"bogus","threadId":"thr_1"})),
            NotificationVerdict::InvalidNotification { terminal: false }
        );

        // turn/started only accepts inProgress and finite startedAt
        for bad in ["completed", "failed", "interrupted"] {
            assert_eq!(
                validate_notification("turn/started", &json!({"turn":{"id":"turn_1","threadId":"thr_1","status":bad,"items":[],"error":null,"startedAt":1,"completedAt":null}})),
                NotificationVerdict::InvalidNotification { terminal: false }
            );
        }
        assert_eq!(
            validate_notification("turn/started", &json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"inProgress","items":[],"error":null,"completedAt":null}})),
            NotificationVerdict::InvalidNotification { terminal: false }
        );

        // turn/completed invalid is TERMINAL F2 (invalid-frame)
        for bad_turn in [
            json!({"id":"turn_1","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":2}),
            json!({"id":"turn_1","threadId":"thr_1","status":"failed","items":[],"error":null,"startedAt":1,"completedAt":2}),
            json!({"id":"turn_1","threadId":"thr_1","status":"completed","items":[],"error":{"code":1,"message":"x"},"startedAt":1,"completedAt":2}),
            json!({"id":"turn_1","threadId":"thr_1","status":"completed","items":[],"error":null,"completedAt":2}),
        ] {
            assert_eq!(
                validate_notification("turn/completed", &json!({"turn": bad_turn})),
                NotificationVerdict::InvalidNotification { terminal: true }
            );
        }

        // item/completed: inProgress fails (non-terminal F4); failed passes (#finishTurn); empty servedModel strings pass; toolCall arguments:null passes; missing arguments fails
        assert_eq!(
            validate_notification("item/completed", &json!({"threadId":"thr_1","turnId":"turn_1","item":{"id":"it_1","kind":"agentMessage","status":"inProgress","text":"x"}})),
            NotificationVerdict::InvalidNotification { terminal: false }
        );
        assert!(matches!(
            validate_notification("item/completed", &json!({"threadId":"thr_1","turnId":"turn_1","item":{"id":"it_1","kind":"agentMessage","status":"failed","text":"x","extraKey":true}})),
            NotificationVerdict::Forwardable { .. }
        ));
        assert!(matches!(
            validate_notification("item/completed", &json!({"threadId":"thr_1","turnId":"turn_1","item":{"id":"it_2","kind":"toolCall","status":"completed","name":"t","arguments":null}})),
            NotificationVerdict::Forwardable { .. }
        ));
        assert_eq!(
            validate_notification("item/completed", &json!({"threadId":"thr_1","turnId":"turn_1","item":{"id":"it_2","kind":"toolCall","status":"completed","name":"t"}})),
            NotificationVerdict::InvalidNotification { terminal: false }
        );
        assert!(matches!(
            validate_notification("item/completed", &json!({"threadId":"thr_1","turnId":"turn_1","item":{"id":"it_3","kind":"servedModel","status":"completed","requestedModel":"","servedModel":"","backing":"","providerId":"","lane":"allowed-direct","mode":"headless","fallbackFrom":null,"vendorReported":false}})),
            NotificationVerdict::Forwardable { .. }
        ));
        assert_eq!(
            validate_notification("item/completed", &json!({"threadId":"thr_1","turnId":"turn_1","item":{"id":"it_3","kind":"servedModel","status":"completed","requestedModel":"","servedModel":"","backing":"","providerId":"","lane":"bogus","mode":"headless","fallbackFrom":null,"vendorReported":"yes"}})),
            NotificationVerdict::InvalidNotification { terminal: false }
        );

        // (7g) 1-second rate limiter per reason
        let t0 = Instant::now();
        let mut rl = DropRateLimiter::default();
        assert_eq!(rl.record_drop("unknown-notification", t0), Some(("unknown-notification", 1)));
        assert_eq!(rl.record_drop("unknown-notification", t0 + Duration::from_millis(200)), None);
        assert_eq!(rl.record_drop("unknown-notification", t0 + Duration::from_millis(800)), None);
        // Different reason emits independently
        assert_eq!(rl.record_drop("invalid-notification", t0 + Duration::from_millis(850)), Some(("invalid-notification", 1)));
        assert_eq!(rl.record_drop("unknown-notification", t0 + Duration::from_millis(1000)), Some(("unknown-notification", 3)));
    }

    #[test]
    fn rpc_result_validators_cover_7i_7k_7l_7m_7n_7o_7p_7q_and_7s_replay() {
        let h64_0 = GENESIS_HASH_ZEROS;
        let h64_1 = "a".repeat(64);
        let h64_2 = "b".repeat(64);
        let h64_3 = "c".repeat(64);
        let h64_4 = "d".repeat(64);
        let sha40 = "e".repeat(40);

        // (7o) initialize
        assert!(validate_initialize_result(&json!({"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}})).is_ok());
        for bad_init in [
            json!("str"),
            json!({}),
            json!({"protocolVersion":"madc-m1/2","serverInfo":{"name":"madc-engine","version":"0.0.0"}}),
            json!({"protocolVersion":1,"serverInfo":{"name":"madc-engine","version":"0.0.0"}}),
            json!({"protocolVersion":"madc-m1/1"}),
            json!({"protocolVersion":"madc-m1/1","serverInfo":"bad"}),
            json!({"protocolVersion":"madc-m1/1","serverInfo":{"version":"0.0.0"}}),
            json!({"protocolVersion":"madc-m1/1","serverInfo":{"name":"other-engine","version":"0.0.0"}}),
            json!({"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine"}}),
            json!({"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":123}}),
        ] {
            assert!(validate_initialize_result(&bad_init).is_err(), "expected err for {bad_init}");
        }

        // (7i) turn/start result
        let ts_params = json!({"threadId":"thr_1","input":[{"type":"text","text":"go"}]});
        assert!(validate_rpc_result("turn/start", &ts_params, &json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}})));
        for bad_ts in [
            json!({"turn":{"id":"turn_1","threadId":"thr_other","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}}),
            json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"completed","items":[],"error":null,"startedAt":10,"completedAt":null}}),
            json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"failed","items":[],"error":null,"startedAt":10,"completedAt":null}}),
            json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"interrupted","items":[],"error":null,"startedAt":10,"completedAt":null}}),
            json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"inProgress","items":[],"error":null,"completedAt":null}}),
            json!({"turn":{"id":"turn_1","threadId":"thr_1","status":"inProgress","items":"nope","error":null,"startedAt":10,"completedAt":null}}),
        ] {
            assert!(!validate_rpc_result("turn/start", &ts_params, &bad_ts), "expected false for {bad_ts}");
        }

        // (7k) thread/start result
        assert!(validate_rpc_result("thread/start", &json!({}), &json!({"thread":{"id":"thr_1","seatId":"madc-default","cwd":null,"createdAt":1,"updatedAt":1,"status":"idle","preview":""}})));
        for bad_thr in [
            json!({"thread":{"seatId":"madc-default","cwd":null,"createdAt":1,"updatedAt":1,"status":"idle","preview":""}}),
            json!({"thread":{"id":"thr_1","seatId":"madc-default","cwd":null,"createdAt":1,"updatedAt":1,"status":"active","preview":""}}),
            json!({"thread":{"id":"thr_1","seatId":"madc-default","cwd":null,"createdAt":1,"updatedAt":1,"status":"closed","preview":""}}),
            json!({"thread":{"id":"thr_1","seatId":"other","cwd":null,"createdAt":1,"updatedAt":1,"status":"idle","preview":""}}),
            json!({"thread":{"id":"thr_1","seatId":"madc-default","cwd":null,"createdAt":"bad","updatedAt":1,"status":"idle","preview":""}}),
        ] {
            assert!(!validate_rpc_result("thread/start", &json!({}), &bad_thr));
        }

        // (7l) seat/list result
        assert!(validate_rpc_result("seat/list", &json!({}), &json!({
            "data": [
                {"id":"v1-seat","ok":true,"path":"/s/v1.json","version":1,"displayName":null,"role":"r","pinnedModel":"m","preferredBacking":"b","fallbacks":[],"memory":{"mode":"in-session"},"tools":{"deny":[]},"policy":{"headlessOk":true},"warnings":[]},
                {"id":"bad","ok":false,"path":"/s/bad.json","code":-32006,"issues":[]}
            ]
        })));
        assert!(!validate_rpc_result("seat/list", &json!({}), &json!({"data":[{"id":"bad id","ok":false,"path":"/x","code":-1,"issues":[]}]})));
        assert!(!validate_rpc_result("seat/list", &json!({}), &json!({"data":[{"id":"a","ok":true,"path":"/x","version":2,"displayName":"A","role":"r","pinnedModel":"m","preferredBacking":"b","fallbacks":[],"memory":{"mode":"in-session"},"tools":{"deny":[]},"policy":{},"warnings":[]}]})));
        assert!(!validate_rpc_result("seat/list", &json!({}), &json!({"data":[{"id":"a","ok":false,"path":"/x","code":-1,"issues":"nope"}]})));

        // (7q) turn/interrupt
        assert!(validate_rpc_result("turn/interrupt", &json!({}), &json!({})));
        for bad_int in [json!({"ok":true}), json!(null), json!([]), json!("ok")] {
            assert!(!validate_rpc_result("turn/interrupt", &json!({}), &bad_int));
        }

        // (7p) session/search
        assert!(validate_rpc_result("session/search", &json!({}), &json!({"matches":[]})));
        assert!(validate_rpc_result("session/search", &json!({}), &json!({"matches":[
            {"threadId":"thr_1","seatId":"madc-default","seq":0,"hash":h64_1,"ts":1,"type":"item","snippet":""},
            {"threadId":"thr_2","seatId":"madc-default","seq":1,"hash":h64_2,"ts":2,"type":"future.event.kind","snippet":"hi"}
        ]})));
        let too_many: Vec<Value> = (0..201).map(|i| json!({"threadId":"thr_1","seatId":"s","seq":i,"hash":h64_1,"ts":1,"type":"item","snippet":""})).collect();
        assert!(!validate_rpc_result("session/search", &json!({}), &json!({"matches": too_many})));
        assert!(!validate_rpc_result("session/search", &json!({}), &json!({"matches":[{"threadId":"thr_1","seatId":"s","seq":-1,"hash":h64_1,"ts":1,"type":"item","snippet":""}]})));
        assert!(!validate_rpc_result("session/search", &json!({}), &json!({"matches":[{"threadId":"thr_1","seatId":"s","seq":1,"hash":h64_1,"ts":1,"type":"","snippet":""}]})));

        // (7m) session/read valid v1, chainOk:false, null open worktree, and full 13-kind v2
        assert!(validate_session_read_result(&json!({"threadId":"thr_1","chainOk":false,"events":[]}), "thr_1"));
        assert!(!validate_session_read_result(&json!({"threadId":"thr_1","chainOk":true,"events":[]}), "thr_1"));
        assert!(!validate_session_read_result(&json!({"threadId":"thr_1","chainOk":false,"events":[{"v":1}]}), "thr_1"));

        let v1_chain = json!({
            "threadId": "thr_v1",
            "chainOk": true,
            "events": [
                {"v":1,"seq":0,"ts":1,"type":"session.open","threadId":"thr_v1","seatId":"s1","prevHash":h64_0,"hash":h64_1,"payload":{"cwd":null,"backing":"b","providerId":"p","pinnedModel":"m"}},
                {"v":1,"seq":1,"ts":2,"type":"turn.start","threadId":"thr_v1","seatId":"s1","prevHash":h64_1,"hash":h64_2,"payload":{"turnId":"t1","inputText":"hi"}},
                {"v":1,"seq":2,"ts":3,"type":"session.close","threadId":"thr_v1","seatId":"s1","prevHash":h64_2,"hash":h64_3,"payload":{"reason":"shutdown"}}
            ]
        });
        assert!(validate_session_read_result(&v1_chain, "thr_v1"));

        let mk_ev = |seq: u64, typ: &str, prev: &str, h: &str, payload: Value| -> Value {
            json!({"v":1,"seq":seq,"ts":100+seq,"type":typ,"threadId":"thr_v2","seatId":"s2","prevHash":prev,"hash":h,"payload":payload})
        };
        let hashes: Vec<String> = (0..=13).map(|i| format!("{:064x}", i + 1)).collect();
        let v2_all13 = json!({
            "threadId": "thr_v2",
            "chainOk": true,
            "events": [
                mk_ev(0, "session.open", h64_0, &hashes[0], json!({"cwd":"/repo","backing":"b","providerId":"p","pinnedModel":"m","handoff":null,"worktree":{"topLevel":"/repo","remote":null,"head":sha40}})),
                mk_ev(1, "turn.start", &hashes[0], &hashes[1], json!({"turnId":"t1","inputText":"go","mode":"headless","presence":"absent","briefServed":{"handoffId":"ho_1","sourceSeq":0,"sourceHash":h64_1}})),
                mk_ev(2, "item", &hashes[1], &hashes[2], json!({"turnId":"t1","item":{"id":"it1","kind":"userMessage","status":"completed","content":[{"type":"text","text":"go"}]}})),
                mk_ev(3, "servedModel", &hashes[2], &hashes[3], json!({"turnId":"t1","requestedModel":"","servedModel":"","backing":"","providerId":"","lane":"allowed-direct","mode":"headless","fallbackFrom":null,"vendorReported":false})),
                mk_ev(4, "fallback.rejected", &hashes[3], &hashes[4], json!({"turnId":"t1","candidate":"c","assignedLane":{"status":"allowed-direct","credentialClass":"api"},"candidateLane":{"status":"forbidden","credentialClass":"none"},"reason":"fallback-lane-mismatch"})),
                mk_ev(5, "repo.decision", &hashes[4], &hashes[5], json!({"turnId":"t1","providerId":"p","remote":null,"topLevel":"/repo","decision":"allow","reason":"repo-allowed"})),
                mk_ev(6, "turn.end", &hashes[5], &hashes[6], json!({"turnId":"t1","status":"failed","error":{"code":-32007,"message":"denied"}})),
                mk_ev(7, "handoff.out", &hashes[6], &hashes[7], json!({"handoffId":"ho_1","turnId":null,"targetSeatId":"s3","brief":"take over"})),
                mk_ev(8, "handoff.link", &hashes[7], &hashes[8], json!({"handoffId":"ho_1","targetThreadId":"thr_t","targetSeatId":"s3","targetGenesisHash":h64_4})),
                mk_ev(9, "handoff.aborted", &hashes[8], &hashes[9], json!({"handoffId":"ho_2","reason":"interrupted","error":null})),
                mk_ev(10, "founderDecision", &hashes[9], &hashes[10], json!({"decisionId":"dec_1","turnId":"t1","question":"Q?","recommendedDefault":"A","evidenceRefs":[{"kind":"git","sha":sha40,"remote":null},{"kind":"session","path":"sessions/thr_v2.jsonl","seq":0,"hash":&hashes[0]}]})),
                mk_ev(11, "founderDecision.resolved", &hashes[10], &hashes[11], json!({"decisionId":"dec_1","decisionSeq":10,"decisionHash":&hashes[10],"outcome":"accepted-default","resolution":"A"})),
                mk_ev(12, "session.close", &hashes[11], &hashes[12], json!({"reason":"done","worktree":{"topLevel":"/repo","remote":null,"head":null}})),
            ]
        });
        assert!(validate_session_read_result(&v2_all13, "thr_v2"), "full 13-kind v2 chain must pass");

        // Targeted refused mutations for (7m)
        assert!(!validate_session_read_result(&v2_all13, "thr_other"));
        for drop_key in ["v","seq","ts","type","threadId","seatId","prevHash","hash","payload"] {
            let mut m = v1_chain.clone();
            m["events"][0].as_object_mut().unwrap().remove(drop_key);
            assert!(!validate_session_read_result(&m, "thr_v1"), "missing envelope key {drop_key} must fail");
        }
        let mut extra_env = v1_chain.clone();
        extra_env["events"][0]["extra"] = json!(1);
        assert!(!validate_session_read_result(&extra_env, "thr_v1"));
        let mut bad_prev = v1_chain.clone();
        bad_prev["events"][1]["prevHash"] = json!(h64_4);
        assert!(!validate_session_read_result(&bad_prev, "thr_v1"));
        let mut reserved_kind = v1_chain.clone();
        reserved_kind["events"][1]["type"] = json!("memory.write");
        assert!(!validate_session_read_result(&reserved_kind, "thr_v1"));
        let mut close_mismatch = v2_all13.clone();
        close_mismatch["events"][12]["payload"]["worktree"]["topLevel"] = json!("/other");
        assert!(!validate_session_read_result(&close_mismatch, "thr_v2"));
        let mut bad_fd = v2_all13.clone();
        bad_fd["events"][10]["payload"]["evidenceRefs"] = json!([]);
        assert!(!validate_session_read_result(&bad_fd, "thr_v2"));

        // (7n) room/inspect valid empty + mixed room & key refused fixtures
        assert!(validate_room_inspect_result(&json!({"room":{"home":"/h","threads":[],"counts":{"threads":0,"pass":0,"warn":0,"fail":0,"openDecisions":0}}})));
        let mixed_room = json!({"room":{
            "home":"/h",
            "counts":{"threads":3,"pass":1,"warn":1,"fail":1,"openDecisions":1},
            "threads":[
                {"threadId":"thr_a","path":"/h/sessions/thr_a.jsonl","seatId":"s1","level":"pass","chain":{"ok":true},"handoff":{"inbound":null,"outboundCount":0,"oneWay":false},"worktree":{"open":{"topLevel":"/repo","remote":null,"head":sha40},"close":{"topLevel":"/repo","remote":null,"head":null},"missing":false},"openDecisions":[],"findings":[]},
                {"threadId":"thr_b","path":"/h/sessions/thr_b.jsonl","seatId":"s1","level":"warn","chain":{"ok":true},"handoff":{"inbound":{"sourceThreadId":"thr_a","sourceSeatId":"s1","handoffId":"ho_1","sourceSeq":1,"sourceHash":h64_1},"outboundCount":2,"oneWay":true},"worktree":{"open":null,"close":null,"missing":true},"openDecisions":[{"threadId":"thr_b","seatId":"s1","seq":2,"hash":h64_2,"ts":5,"decisionId":"dec_1","turnId":"t1","question":"Q","recommendedDefault":"Y","evidenceRefs":[{"kind":"git","sha":sha40,"remote":null}]}],"findings":[{"level":"warn","code":"worktree-head-unreadable","detail":"missing"}]},
                {"threadId":"thr_c","path":"/h/sessions/thr_c.jsonl","seatId":null,"level":"fail","chain":{"ok":false,"line":3,"reason":"bad","kind":"integrity"},"handoff":{"inbound":null,"outboundCount":0,"oneWay":false},"worktree":{"open":null,"close":null,"missing":false},"openDecisions":[],"findings":[{"level":"fail","code":"integrity","detail":"bad"}]}
            ]
        }});
        assert!(validate_room_inspect_result(&mixed_room));
        let mut bad_counts = mixed_room.clone();
        bad_counts["room"]["counts"]["pass"] = json!(2);
        assert!(!validate_room_inspect_result(&bad_counts));
        let mut bad_wt = mixed_room.clone();
        bad_wt["room"]["threads"][0]["worktree"]["open"]["head"] = json!("1234");
        assert!(!validate_room_inspect_result(&bad_wt));
        let mut out_of_order = mixed_room.clone();
        out_of_order["room"]["threads"].as_array_mut().unwrap().swap(0, 1);
        assert!(!validate_room_inspect_result(&out_of_order));

        // (7s) Replay captured real engine output from commit 870c1f7e
        let raw_fixtures = include_str!("../../../../docs/plan/fixtures/m3-a4-closed-checks-870c1f7e/fixtures.json");
        let fx: Value = serde_json::from_str(raw_fixtures).expect("parse captured fixtures.json");
        assert!(validate_initialize_result(&fx["rpcs"]["initialize"]).is_ok());
        assert!(validate_rpc_result("seat/list", &json!({}), &fx["rpcs"]["seatList"]));
        assert!(validate_rpc_result("thread/start", &fx["rpcs"]["threadStart"]["params"], &fx["rpcs"]["threadStart"]["result"]));
        assert!(validate_rpc_result("turn/start", &json!({"threadId": fx["rpcs"]["turnStart"]["threadId"]}), &fx["rpcs"]["turnStart"]["result"]));
        assert!(validate_rpc_result("turn/interrupt", &json!({}), &fx["rpcs"]["turnInterrupt"]));
        assert!(validate_rpc_result("session/read", &json!({"threadId": fx["rpcs"]["sessionRead"]["threadId"]}), &fx["rpcs"]["sessionRead"]["result"]));
        assert!(validate_rpc_result("session/search", &json!({}), &fx["rpcs"]["sessionSearch"]));
        assert!(validate_rpc_result("room/inspect", &json!({}), &fx["rpcs"]["roomInspect"]));

        let notifs = fx["notifications"].as_array().expect("notifications array");
        assert!(!notifs.is_empty());
        let mut saw_failed_item_completed = false;
        let mut saw_discarded = false;
        for n in notifs {
            let m = n["method"].as_str().unwrap();
            let p = &n["params"];
            match validate_notification(m, p) {
                NotificationVerdict::Forwardable { .. } => {
                    if m == "item/completed" && p["item"]["status"].as_str() == Some("failed") {
                        saw_failed_item_completed = true;
                    }
                }
                NotificationVerdict::Discard => saw_discarded = true,
                other => panic!("unexpected verdict for captured {m}: {other:?}"),
            }
        }
        assert!(saw_failed_item_completed, "fixture must include #finishTurn item/completed status=failed");
        assert!(saw_discarded, "fixture must include discarded item/started or delta");
    }

    #[derive(Default)]
    struct TestSink {
        engine_events: Mutex<Vec<(Option<LifecyclePhase>, Value)>>,
        quit_events: Mutex<Vec<Value>>,
        assert_owner_locked: Mutex<Option<Arc<Mutex<ClientOwner>>>>,
        stall_once: Mutex<Option<(mpsc::SyncSender<()>, mpsc::Receiver<()>)>>,
    }

    impl EventSink for TestSink {
        fn emit_engine_event(&self, payload: Value) -> Result<(), String> {
            let phase_snap = self.assert_owner_locked.lock().unwrap().as_ref().map(|arc| {
                // Verify owner mutex is held by caller (non-reentrant try_lock must fail).
                assert!(arc.try_lock().is_err(), "L1 violation: emit started without holding owner!");
                // Return current phase sentinel for L5 check via payload inspection fallback
                LifecyclePhase::Open
            });
            if let Some((tx, rx)) = self.stall_once.lock().unwrap().take() {
                let _ = tx.send(());
                let _ = rx.recv_timeout(Duration::from_secs(2));
            }
            self.engine_events.lock().unwrap().push((phase_snap, payload));
            Ok(())
        }
        fn emit_quit_requested(&self, payload: Value) -> Result<(), String> {
            self.quit_events.lock().unwrap().push(payload);
            Ok(())
        }
    }

    #[cfg(unix)]
    #[test]
    fn connection_info_serializes_connection_epoch_and_events_match_epoch_s3_5() {
        let info = ConnectionInfo {
            socket_path: "/tmp/s.sock".to_string(),
            reused_existing: false,
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_name: "madc-engine".to_string(),
            server_version: "0.0.0".to_string(),
            cold_start_ms: 10,
            connection_epoch: 42,
        };
        let v = serde_json::to_value(&info).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.get("connectionEpoch").and_then(|x| x.as_u64()), Some(42));
        assert!(!obj.contains_key("connection_epoch"), "must not emit snake_case key");

        let e1 = ClientOwner::new(NEXT_EPOCH.fetch_add(1, Ordering::Relaxed)).epoch;
        let e2 = ClientOwner::new(NEXT_EPOCH.fetch_add(1, Ordering::Relaxed)).epoch;
        assert!(e2 > e1, "sequential epochs must increase");
    }

    #[test]
    fn owner_randomized_10k_schedule_preserves_l1_l3_l4_l5_l6_l10_t_l1() {
        // T-L1: 10,000-seed randomized interleaving over ClientOwner operations checking L3-L6 + L1 + L10.
        struct L1CheckSink {
            owner: Arc<Mutex<ClientOwner>>,
            engine_events: Mutex<Vec<Value>>,
            quit_events: Mutex<Vec<Value>>,
        }
        impl EventSink for L1CheckSink {
            fn emit_engine_event(&self, payload: Value) -> Result<(), String> {
                assert!(
                    self.owner.try_lock().is_err(),
                    "T-L1 killed mutation: emit started outside owner!"
                );
                self.engine_events.lock().unwrap().push(payload);
                Ok(())
            }
            fn emit_quit_requested(&self, payload: Value) -> Result<(), String> {
                assert!(self.owner.try_lock().is_err());
                self.quit_events.lock().unwrap().push(payload);
                Ok(())
            }
        }

        for seed in 0u64..10_000 {
            let mut rng = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let mut next_u32 = || {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (rng >> 32) as u32
            };

            let owner = Arc::new(Mutex::new(ClientOwner::new(seed + 1)));
            let sink = L1CheckSink {
                owner: Arc::clone(&owner),
                engine_events: Mutex::new(Vec::new()),
                quit_events: Mutex::new(Vec::new()),
            };
            let mut was_published = false;
            let mut exit_started_sim = false;
            let mut turn_counter = 0u64;
            let base_clock = Instant::now();
            let mut fake_ms = 0u64;
            let mut last_quit_req_id = 0u64;

            for _step in 0..20 {
                let op = next_u32() % 11;
                fake_ms += (next_u32() % 2500) as u64;
                let now = base_clock + Duration::from_millis(fake_ms);
                let mut o = owner.lock().unwrap();
                match op {
                    0 => {
                        if matches!(o.phase, LifecyclePhase::Handshake) {
                            o.phase = LifecyclePhase::Open;
                            was_published = true;
                        }
                    }
                    1 => {
                        let _ = o.enqueue_forwardable(
                            "room/updated".to_string(),
                            json!({"reason":"thread","threadId":"thr_1"}),
                        );
                    }
                    2 => {
                        let _ = o.drain_step(&sink);
                    }
                    3 => {
                        let _ = o.enter_terminated("eof");
                    }
                    4 => {
                        let _ = o.close_to_closed("disconnect", &sink);
                    }
                    5 => {
                        if matches!(o.phase, LifecyclePhase::Open) {
                            turn_counter += 1;
                            *o.pending_starts.entry("thr_1".to_string()).or_insert(0) += 1;
                            o.pending_starts_total += 1;
                            let tid = format!("turn_{turn_counter}");
                            o.observe_turn_notification(
                                "turn/started",
                                &json!({"turn":{"id":tid,"threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":null}}),
                            );
                            let _ = o.finish_pending_turn_start("thr_1", Some(&tid));
                        }
                    }
                    6 => {
                        if matches!(o.phase, LifecyclePhase::Open) {
                            o.observe_turn_notification(
                                "turn/completed",
                                &json!({"turn":{"id":format!("turn_{turn_counter}"),"threadId":"thr_1","status":"completed","items":[],"error":null,"startedAt":1,"completedAt":2}}),
                            );
                        }
                    }
                    7 => {
                        let dec = o.evaluate_close_request_at(exit_started_sim, &sink, now);
                        if dec == CloseDecision::AllowExit {
                            exit_started_sim = true;
                        } else if let CloseDecision::PreventQuitRequested { request_id, .. } = dec {
                            assert!(request_id >= last_quit_req_id, "L10 requestId must not decrease");
                            last_quit_req_id = request_id;
                        }
                    }
                    8 => {
                        let ep = o.epoch;
                        let _ = o.quit_dialog_shown_at(ep, last_quit_req_id, now);
                    }
                    9 => {
                        let ep = o.epoch;
                        let _ = o.ack_quit_at(ep, last_quit_req_id, now);
                    }
                    _ => {
                        let ep = o.epoch;
                        if o.confirm_quit_at(ep, last_quit_req_id, &sink, now) {
                            exit_started_sim = true;
                        }
                    }
                }
                if matches!(o.phase, LifecyclePhase::Terminated { .. } | LifecyclePhase::Closed) {
                    assert_eq!(o.guard_count(), 0);
                    assert!(o.quit_record.is_none());
                    assert!(o.quit_fallback_set_at.is_none());
                    assert!(o.pending.is_empty());
                }
            }
            {
                let mut o = owner.lock().unwrap();
                o.close_to_closed("exit", &sink);
            }
            let evs = sink.engine_events.lock().unwrap();
            if !was_published {
                assert!(evs.is_empty(), "L2 violated: unpublished epoch emitted!");
                assert!(sink.quit_events.lock().unwrap().is_empty());
            } else {
                let terminals: Vec<_> = evs
                    .iter()
                    .filter(|e| e["method"] == "madc/transport-closed")
                    .collect();
                assert_eq!(terminals.len(), 1, "L3 violated on seed {seed}: {evs:?}");
                assert_eq!(evs.last().unwrap()["method"], "madc/transport-closed", "L4 terminal must be last");
                let mut last_seq = 0u64;
                for e in evs.iter() {
                    let s = e["seq"].as_u64().unwrap();
                    assert!(s > last_seq, "L4 seq must strictly increase");
                    assert_eq!(e["epoch"].as_u64().unwrap(), seed + 1);
                    last_seq = s;
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn published_epochs_and_handshake_failure_overflow_match_t_l2() {
        // 1. Handshake failure (protocol mismatch) emits zero events.
        let tmp = std::env::temp_dir().join(format!("madc-tl2-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let peer = thread::spawn(move || {
            let (s1, _) = listener.accept().unwrap();
            let mut w1 = s1.try_clone().unwrap();
            let mut r1 = BufReader::new(s1);
            let mut buf = Vec::new();
            let BoundedLine::Line(line) = read_bounded_line(&mut r1, &mut buf) else { panic!() };
            let req: Value = serde_json::from_str(&line).unwrap();
            writeln!(w1, "{}", json!({"id":req["id"],"result":{"protocolVersion":"madc-m0/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            let _ = w1.flush();

            // Connection 2: sends 4097 notifications during handshake -> overflow & Closed with zero emits!
            let (s2, _) = listener.accept().unwrap();
            let mut w2 = s2.try_clone().unwrap();
            let mut r2 = BufReader::new(s2);
            let BoundedLine::Line(_) = read_bounded_line(&mut r2, &mut buf) else { panic!() };
            for i in 0..4097 {
                if writeln!(w2, "{}", json!({"method":"room/updated","params":{"reason":"thread","threadId":format!("thr_{i}")}})).is_err() {
                    break;
                }
            }
            let _ = w2.flush();
            let _ = done_rx.recv();
        });

        let sink = Arc::new(TestSink::default());
        let err1 = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .err()
        .expect("mismatch must fail handshake");
        assert!(err1.contains("protocol version mismatch"));
        assert!(sink.engine_events.lock().unwrap().is_empty(), "F11 emits nothing");

        let err2 = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .err()
        .expect("4097 notifications during handshake must fail");
        assert!(err2.contains("overflow"), "got: {err2}");
        assert!(sink.engine_events.lock().unwrap().is_empty(), "Handshake overflow emits nothing (L2)");

        let _ = done_tx.send(());
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn terminal_once_ordering_l3_l4_l5_and_1000_rep_barrier_race() {
        // 1000-rep barrier race between reader enter_terminated("eof") and disconnect close_to_closed
        for rep in 0..1000u64 {
            let owner = Arc::new(Mutex::new(ClientOwner::new(rep + 1)));
            {
                let mut o = owner.lock().unwrap();
                o.phase = LifecyclePhase::Open;
                let _ = o.enqueue_forwardable("room/updated".into(), json!({"reason":"thread","threadId":"thr_r"}));
            }
            let sink = Arc::new(TestSink::default());
            *sink.assert_owner_locked.lock().unwrap() = Some(Arc::clone(&owner));

            let barrier = Arc::new(std::sync::Barrier::new(3));
            let o1 = Arc::clone(&owner);
            let b1 = Arc::clone(&barrier);
            let s1 = Arc::clone(&sink);
            let t1 = thread::spawn(move || {
                b1.wait();
                let mut o = o1.lock().unwrap();
                o.enter_terminated("eof");
                while o.drain_step(&*s1).is_some() {}
            });

            let o2 = Arc::clone(&owner);
            let b2 = Arc::clone(&barrier);
            let s2 = Arc::clone(&sink);
            let t2 = thread::spawn(move || {
                b2.wait();
                let mut o = o2.lock().unwrap();
                o.close_to_closed("disconnect", &*s2);
            });

            barrier.wait();
            t1.join().unwrap();
            t2.join().unwrap();

            let evs = sink.engine_events.lock().unwrap();
            let terms: Vec<_> = evs.iter().filter(|(_, p)| p["method"] == "madc/transport-closed").collect();
            assert_eq!(terms.len(), 1, "T-L3 race rep {rep}: expected exactly 1 terminal, got {evs:?}");
            assert_eq!(evs.last().unwrap().1["method"], "madc/transport-closed");
            let count_before = evs.len();
            drop(evs);
            // Second close emits nothing (L3)
            owner.lock().unwrap().close_to_closed("disconnect", &*sink);
            assert_eq!(sink.engine_events.lock().unwrap().len(), count_before);
        }

        // L4 overflow gap + reserved reason preserved on mid-drain disconnect (Copilot 4725865918)
        let owner = Arc::new(Mutex::new(ClientOwner::new(77)));
        let sink = Arc::new(TestSink::default());
        {
            let mut o = owner.lock().unwrap();
            o.phase = LifecyclePhase::Open;
            for i in 0..FORWARD_QUEUE_CAPACITY {
                assert_eq!(
                    o.enqueue_forwardable("room/updated".into(), json!({"reason":"thread","threadId":format!("thr_{i}")})).unwrap(),
                    false
                );
            }
            // 4097th -> consumes seq 4097 (gap) and reserves seq 4098 terminal overflow
            assert_eq!(
                o.enqueue_forwardable("room/updated".into(), json!({"reason":"thread","threadId":"thr_overflow"})).unwrap(),
                true
            );
            assert_eq!(o.phase, LifecyclePhase::Terminated { reason: "overflow", seq: 4098 });
            // Drain 1 ordinary event then close mid-drain with disconnect
            assert_eq!(o.drain_step(&*sink), Some(true));
            o.close_to_closed("disconnect", &*sink);
        }
        let evs = sink.engine_events.lock().unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].1["seq"], 1);
        assert_eq!(evs[1].1["method"], "madc/transport-closed");
        assert_eq!(evs[1].1["params"]["reason"], "overflow", "must emit reserved overflow reason, not disconnect");
        assert_eq!(evs[1].1["seq"], 4098);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_wakes_silent_reader_within_2s_and_kills_slow_child_t_l7() {
        let tmp = std::env::temp_dir().join(format!("madc-tl7-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let hold_tx = Arc::new(Mutex::new(None));
        let hold_c = Arc::clone(&hold_tx);
        let _peer = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v: Value = serde_json::from_str(&req).unwrap();
            writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            let _ = w.flush();
            // Keep server end open silently forever until test ends
            *hold_c.lock().unwrap() = Some((w, r));
        });

        let sink = Arc::new(TestSink::default());
        let client = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .expect("connect");

        let client_ref = client.clone();
        client.disconnect();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && !client_ref.reader_done() {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(client_ref.reader_done(), "T-L7: shutdown(Shutdown::Both) must wake blocked reader within 2 s");
        // Verify new RPC fails cleanly without touching socket
        assert_eq!(
            client_ref.request("room/inspect", json!({})).unwrap_err(),
            "engine socket closed before response"
        );
        let evs = sink.engine_events.lock().unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].1["method"], "madc/transport-closed");
        assert_eq!(evs[0].1["params"]["reason"], "disconnect");
        drop(hold_tx);
        let _ = std::fs::remove_file(&tmp);

        // Real spawn-failure fallback stops/kills child cleanly within caller's deadline
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("exec sleep 30")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child_pid = child.id();
        let shared = SharedChild::new(child);
        let spawned = SpawnedServe {
            child: shared.clone(),
            stdin: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stderr_done: None,
            stderr_thread: None,
            initialized: true,
        };
        let fail_spawner: StopWorkerSpawner = Arc::new(|_| {
            Err(std::io::Error::new(
                ErrorKind::WouldBlock,
                "injected spawn failure",
            ))
        });
        let stop_arc = Arc::new(Mutex::new(StopState {
            cancel_stream: None,
            spawned: Some(spawned),
            in_flight: None,
            reader_done: Arc::new(AtomicBool::new(true)),
            hooks: Some(Arc::new(TestStopHooks {
                spawner: Some(fail_spawner),
                ..Default::default()
            })),
        }));
        let t_sf0 = Instant::now();
        stop_child(&stop_arc, t_sf0 + Duration::from_millis(150));
        let sf_elapsed = t_sf0.elapsed();
        assert!(
            sf_elapsed < Duration::from_secs(2),
            "real spawn-failure inline fallback must honor short caller deadline, got {sf_elapsed:?}"
        );
        assert!(shared.is_reaped(), "spawn_fail inline fallback must reap child");
        assert_eq!(shared.kill_count(), 1, "must issue exactly one kill through SharedChild");
        unsafe {
            let rc = libc::kill(child_pid as libc::pid_t, 0);
            assert!(rc != 0, "spawn_fail inline fallback must kill child");
        }
    }

    #[cfg(unix)]
    #[test]
    fn idle_reader_survives_over_10s_without_timeout_and_still_answers_t_l8_7b() {
        let tmp = std::env::temp_dir().join(format!("madc-tl8-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let peer = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            let BoundedLine::Line(req1) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v1: Value = serde_json::from_str(&req1).unwrap();
            writeln!(w, "{}", json!({"id":v1["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            let _ = w.flush();

            // Wait cleanly for room/inspect (arrives after > 10.5s idle)
            let BoundedLine::Line(req2) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v2: Value = serde_json::from_str(&req2).unwrap();
            writeln!(w, "{}", json!({"id":v2["id"],"result":{"room":{"home":"/h","threads":[],"counts":{"threads":0,"pass":0,"warn":0,"fail":0,"openDecisions":0}}}})).unwrap();
            let _ = w.flush();
        });

        let sink = Arc::new(TestSink::default());
        let client = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .expect("connect");

        thread::sleep(Duration::from_millis(10_500));
        assert!(sink.engine_events.lock().unwrap().is_empty(), "idle connection must emit zero events");
        assert!(client.is_open(), "idle connection > 10s must remain Open (L8)");
        let res = client.request("room/inspect", json!({})).expect("room/inspect succeeds after 10.5s idle");
        assert_eq!(res["room"]["counts"]["threads"], 0);
        client.disconnect();
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);

        // Static source check: reader_thread_loop, stop_child, and post-handshake SocketClient methods never re-arm SO_RCVTIMEO.
        let src = include_str!("launcher.rs");
        let after_handshake = src.find("pub fn is_open(&self)").unwrap();
        let tests_start = src.find("#[cfg(test)]\nmod tests").unwrap();
        let reader_start = src.find("fn reader_thread_loop(").unwrap();
        let reader_end = src[reader_start..].find("\n#[cfg(unix)]\nimpl SocketClient").unwrap() + reader_start;
        assert!(
            !src[reader_start..reader_end].contains("set_read_timeout(Some("),
            "L8 violation: reader_thread_loop must NEVER call set_read_timeout(Some(..))"
        );
        assert!(
            !src[after_handshake..tests_start].contains("set_read_timeout(Some("),
            "L8 violation: post-handshake SocketClient/DesktopController must NEVER call set_read_timeout(Some(..))"
        );
    }

    #[cfg(unix)]
    #[test]
    fn desktop_controller_l14_never_returns_stale_or_post_shutdown_client_t_l14() {
        let ctrl = DesktopController::new();
        ctrl.shutting_down.store(true, Ordering::Release);
        let dummy_cfg = LaunchConfig {
            home: PathBuf::from("/tmp/nonexistent-madc-l14"),
            runtime_bin: "node".to_string(),
            engine_entry: PathBuf::from("none"),
        };
        assert_eq!(
            ctrl.connect_engine_blocking(&dummy_cfg, Arc::new(NullEventSink)).unwrap_err(),
            "desktop shutting down"
        );
        assert_eq!(
            ctrl.rpc_request_blocking("room/inspect", json!({})).unwrap_err(),
            "desktop shutting down"
        );

        // Stale Terminated client cached in controller is closed and replaced on next connect
        let tmp = std::env::temp_dir().join(format!("madc-tl14-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let peer = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v: Value = serde_json::from_str(&req).unwrap();
            writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            let _ = w.flush();
            // Immediately drop peer -> Terminated/Closed
        });

        let ctrl2 = DesktopController::new();
        let sink = Arc::new(TestSink::default());
        let c1 = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .unwrap();
        let ep1 = c1.info.connection_epoch;
        *ctrl2.client.lock().unwrap() = Some(c1);
        thread::sleep(Duration::from_millis(80)); // wait for first peer EOF

        // Home dir empty but we point MADC_HOME to tmp's parent? Instead put sock at $home/engine.sock:
        let home = std::env::temp_dir().join(format!("madc-tl14-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&tmp, home.join("engine.sock")).unwrap();
        // Actually engine_socket_path points to home/engine.sock (direct file): wait try_engine_socket_path checks plain join on unix
        drop(home);

        // Verify direct stale check via connect_or_spawn reusing a real socket path
        let home2 = PathBuf::from(format!("/tmp/madc-tl14h-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home2);
        std::fs::create_dir_all(&home2).unwrap();
        let sock2 = home2.join("engine.sock");
        let l2 = UnixListener::bind(&sock2).unwrap();
        let (p2_done_tx, p2_done_rx) = mpsc::sync_channel::<()>(1);
        let p2 = thread::spawn(move || {
            let (s, _) = l2.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v: Value = serde_json::from_str(&req).unwrap();
            writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            let _ = w.flush();
            let _ = p2_done_rx.recv_timeout(Duration::from_secs(5));
        });
        let cfg2 = LaunchConfig {
            home: home2.clone(),
            runtime_bin: "node".to_string(),
            engine_entry: PathBuf::from("unused"),
        };
        let info2 = ctrl2
            .connect_engine_blocking(&cfg2, Arc::clone(&sink) as Arc<dyn EventSink>)
            .expect("stale client replaced by live client");
        assert!(info2.connection_epoch > ep1);
        assert!(ctrl2.client.lock().unwrap().as_ref().unwrap().is_open());
        let _ = ctrl2.disconnect_engine_blocking();
        let _ = p2_done_tx.send(());
        p2.join().unwrap();
        peer.join().unwrap();
        let _ = std::fs::remove_dir_all(&home2);
        let _ = std::fs::remove_file(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn close_guard_t_l9_and_6_through_6e_prevent_only_for_admitted_turns() {
        // (6a)-(6e) and (T-L9) over real socket peer
        let tmp = std::env::temp_dir().join(format!("madc-tl9-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let (hold_req2_tx, hold_req2_rx) = mpsc::sync_channel::<()>(1);
        let (peer_done_tx, peer_done_rx) = mpsc::sync_channel::<()>(1);
        let peer = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            // 1. initialize
            let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v: Value = serde_json::from_str(&req).unwrap();
            writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            w.flush().unwrap();

            // 2. turn/start A (gap: NO turn/started sent yet!) -> (6a)
            let BoundedLine::Line(req1) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v1: Value = serde_json::from_str(&req1).unwrap();
            writeln!(w, "{}", json!({"id":v1["id"],"result":{"turn":{"id":"turn_A","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}}})).unwrap();
            w.flush().unwrap();

            // 3. turn/start C (6b: answered ONLY after test checks pendingStarts > 0, returns RPC error -> 6c)
            let BoundedLine::Line(req2) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v2: Value = serde_json::from_str(&req2).unwrap();
            let _ = hold_req2_rx.recv_timeout(Duration::from_secs(2));
            writeln!(w, "{}", json!({"id":v2["id"],"error":{"code":-32004,"message":"turn already active"}})).unwrap();
            w.flush().unwrap();

            // 4. turn/start D that never replies before client timeout -> late reply sent after timeout -> (6e)
            let BoundedLine::Line(req3) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v3: Value = serde_json::from_str(&req3).unwrap();
            thread::sleep(Duration::from_millis(220));
            let _ = writeln!(w, "{}", json!({"id":v3["id"],"result":{"turn":{"id":"turn_late","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":20,"completedAt":null}}}));
            let _ = writeln!(w, "{}", json!({"method":"turn/started","params":{"turn":{"id":"turn_late","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":20,"completedAt":null}}}));
            let _ = w.flush();
            // H-3: keep peer socket open until the test explicitly signals completion (no EOF race).
            let _ = peer_done_rx.recv_timeout(Duration::from_secs(10));
        });

        let sink = Arc::new(TestSink::default());
        let client = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
        )
        .unwrap();
        let ctrl = DesktopController::new();
        ctrl.set_client_for_test(client.clone());

        // (6a) turn/start A succeeds with no turn/started sent -> guard == 1
        let _ = ctrl
            .rpc_request_blocking(
                "turn/start",
                json!({"threadId":"thr_1","input":[{"type":"text","text":"a"}]}),
            )
            .unwrap();
        assert_eq!(client.inner.owner.lock().unwrap().guard_count(), 1);
        let t0 = Instant::now();
        let dec = ctrl.handle_close_or_exit_at(&*sink, t0);
        assert!(matches!(dec, CloseDecision::PreventQuitRequested { .. }));
        if let CloseDecision::PreventQuitRequested { epoch, request_id } = dec {
            assert!(ctrl.ack_quit_at(epoch, request_id, t0).accepted);
        }

        // (6d) No double count when turn/started arrives for already-admitted turn_A; un-admitted turn_B ignored!
        {
            let mut o = client.inner.owner.lock().unwrap();
            o.observe_turn_notification("turn/started", &json!({"turn":{"id":"turn_A","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}}));
            assert_eq!(o.guard_count(), 1, "6d: duplicate turn/started for admitted turn_A counts once");
            o.observe_turn_notification("turn/started", &json!({"turn":{"id":"turn_B","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}}));
            assert_eq!(o.guard_count(), 1, "T-L9: un-admitted turn_B must not enter guard");
            o.observe_turn_notification("turn/completed", &json!({"turn":{"id":"turn_B","threadId":"thr_1","status":"completed","items":[],"error":null,"startedAt":10,"completedAt":11}}));
            assert_eq!(o.guard_count(), 1, "T-L9: turn/completed for B must not remove A");
            o.observe_turn_notification("turn/completed", &json!({"turn":{"id":"turn_A","threadId":"thr_1","status":"completed","items":[],"error":null,"startedAt":10,"completedAt":11}}));
            assert_eq!(o.guard_count(), 0, "6c/6d: turn/completed for A returns guard to zero");
        }

        // (6b) turn/start C in flight while close decision runs -> guard == 1; error returns guard to 0 (6c)
        let client_bg = client.clone();
        let rpc_jh = thread::spawn(move || {
            client_bg.request("turn/start", json!({"threadId":"thr_1","input":[{"type":"text","text":"c"}]}))
        });
        while client.inner.owner.lock().unwrap().guard_count() == 0 {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(client.inner.owner.lock().unwrap().guard_count(), 1);
        let _ = hold_req2_tx.send(());
        assert!(rpc_jh.join().unwrap().is_err());
        assert_eq!(client.inner.owner.lock().unwrap().guard_count(), 0, "6c: error leaves guard at 0");

        // (6e) timed-out turn/start decrements pendingStarts; late reply + turn/started do not insert
        let to_err = client
            .request_with_deadline(
                "turn/start",
                json!({"threadId":"thr_1","input":[{"type":"text","text":"late"}]}),
                Instant::now() + Duration::from_millis(80),
            )
            .unwrap_err();
        assert!(to_err.contains("timed out"));
        assert_eq!(client.inner.owner.lock().unwrap().guard_count(), 0);
        thread::sleep(Duration::from_millis(260));
        assert_eq!(client.inner.owner.lock().unwrap().guard_count(), 0, "6e: late reply/turn/started never admitted");

        // Pre-response turn/started + turn/completed buffered for matching single pending start
        {
            let mut o = client.inner.owner.lock().unwrap();
            *o.pending_starts.entry("thr_buf".to_string()).or_insert(0) += 1;
            o.pending_starts_total += 1;
            o.observe_turn_notification("turn/completed", &json!({"turn":{"id":"turn_fast","threadId":"thr_buf","status":"completed","items":[],"error":null,"startedAt":1,"completedAt":2}}));
            assert_eq!(o.guard_count(), 1);
            o.finish_pending_turn_start("thr_buf", Some("turn_fast"))
                .expect("fresh turn_fast admitted");
            assert_eq!(o.guard_count(), 0, "buffered turn/completed must reconcile guard to 0 upon admission");
        }

        // 1,000-rep barrier race between finish_pending_turn_start (admitting reply) and close decision
        for _ in 0..1000 {
            let o_arc = Arc::new(Mutex::new(ClientOwner::new(1)));
            {
                let mut o = o_arc.lock().unwrap();
                o.phase = LifecyclePhase::Open;
                *o.pending_starts.entry("thr_r".to_string()).or_insert(0) += 1;
                o.pending_starts_total += 1;
            }
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let o1 = Arc::clone(&o_arc);
            let b1 = Arc::clone(&barrier);
            let t1 = thread::spawn(move || {
                b1.wait();
                let _ = o1.lock().unwrap().finish_pending_turn_start("thr_r", Some("turn_r"));
            });
            let o2 = Arc::clone(&o_arc);
            let b2 = Arc::clone(&barrier);
            let s2 = Arc::clone(&sink);
            let t2 = thread::spawn(move || {
                b2.wait();
                o2.lock().unwrap().evaluate_close_request_at(false, &*s2, Instant::now())
            });
            barrier.wait();
            t1.join().unwrap();
            let d = t2.join().unwrap();
            assert!(
                matches!(d, CloseDecision::PreventQuitRequested { .. }),
                "T-L9: close must NEVER see guard 0 across reply admission"
            );
        }

        let _ = ctrl.disconnect_engine_blocking();
        let _ = peer_done_tx.send(());
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn quit_lifecycle_fake_clock_t_l10() {
        #[derive(Default)]
        struct FailQuitSink {
            fail_quit: AtomicBool,
            engine: Mutex<Vec<Value>>,
            quits: Mutex<Vec<Value>>,
        }
        impl EventSink for FailQuitSink {
            fn emit_engine_event(&self, payload: Value) -> Result<(), String> {
                self.engine.lock().unwrap().push(payload);
                Ok(())
            }
            fn emit_quit_requested(&self, payload: Value) -> Result<(), String> {
                if self.fail_quit.load(Ordering::Acquire) {
                    return Err("webview missing".to_string());
                }
                self.quits.lock().unwrap().push(payload);
                Ok(())
            }
        }

        let t0 = Instant::now();
        let sink = FailQuitSink::default();
        let mut o = ClientOwner::new(10);
        o.phase = LifecyclePhase::Open;
        o.in_flight_turn_ids.insert("turn_1".into(), "thr_1".into());

        // 1. Guarded close -> { req1, Outstanding } + 1 emit
        let CloseDecision::PreventQuitRequested { epoch: e1, request_id: r1 } =
            o.evaluate_close_request_at(false, &sink, t0)
        else {
            panic!("expected PreventQuitRequested");
        };
        assert_eq!(e1, 10);
        assert_eq!(sink.quits.lock().unwrap().len(), 1);

        // 2. Second close while Outstanding emits nothing and does not exit
        assert_eq!(
            o.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(1)),
            CloseDecision::PreventAlreadyPending
        );
        assert_eq!(sink.quits.lock().unwrap().len(), 1);

        // 3. Stale/wrong epoch or wrong id rejected
        assert!(!o.quit_dialog_shown_at(9, r1, t0 + Duration::from_secs(1)));
        assert!(!o.quit_dialog_shown_at(10, r1 - 1, t0 + Duration::from_secs(1)));

        // 4. 3s expiry settles request & sets fallback; late commands return accepted=false; next close exits
        assert!(!o.quit_dialog_shown_at(10, r1, t0 + Duration::from_secs(3)));
        assert!(!o.ack_quit_at(10, r1, t0 + Duration::from_secs(4)));
        assert!(!o.confirm_quit_at(10, r1, &sink, t0 + Duration::from_secs(4)));
        assert_eq!(
            o.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(4)),
            CloseDecision::AllowExit
        );

        // 5. Reset & test TTL > 30s creates new greater requestId instead of exiting
        let mut o2 = ClientOwner::new(11);
        o2.phase = LifecyclePhase::Open;
        o2.in_flight_turn_ids.insert("turn_2".into(), "thr_1".into());
        let CloseDecision::PreventQuitRequested { request_id: r2a, .. } =
            o2.evaluate_close_request_at(false, &sink, t0)
        else { panic!() };
        // Expire at +3s -> fallback mark set at t0+3s
        assert!(!o2.quit_dialog_shown_at(11, r2a, t0 + Duration::from_secs(3)));
        // At t0 + 34s (31s after fallback set -> > QUIT_FALLBACK_TTL 30s) -> new dialog, NOT AllowExit!
        let CloseDecision::PreventQuitRequested { request_id: r2b, .. } =
            o2.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(34))
        else {
            panic!("after QUIT_FALLBACK_TTL, must show dialog again");
        };
        assert!(r2b > r2a);
        // Accepting shown cancels 3s bound; second close refocuses same id; ack_quit settles -> greater id
        assert!(o2.quit_dialog_shown_at(11, r2b, t0 + Duration::from_secs(35)));
        assert!(o2.quit_dialog_shown_at(11, r2b, t0 + Duration::from_secs(40)));
        assert_eq!(
            o2.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(40)),
            CloseDecision::PreventQuitRequested { epoch: 11, request_id: r2b }
        );
        assert!(o2.ack_quit_at(11, r2b, t0 + Duration::from_secs(41)));
        let CloseDecision::PreventQuitRequested { request_id: r2c, .. } =
            o2.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(42))
        else { panic!() };
        assert!(r2c > r2b);
        assert!(o2.ack_quit_at(11, r2c, t0 + Duration::from_secs(42)));

        // 6. Emit failure -> immediate expiry -> next close allows exit
        sink.fail_quit.store(true, Ordering::Release);
        let CloseDecision::PreventQuitRequested { request_id: r_fail, .. } =
            o2.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(43))
        else { panic!() };
        assert!(!o2.quit_dialog_shown_at(11, r_fail, t0 + Duration::from_secs(43)));
        assert_eq!(
            o2.evaluate_close_request_at(false, &sink, t0 + Duration::from_secs(44)),
            CloseDecision::AllowExit
        );

        // 7d: after transport-closed terminal, owner guard is 0 & close allows exit
        let mut o3 = ClientOwner::new(12);
        o3.phase = LifecyclePhase::Open;
        o3.in_flight_turn_ids.insert("turn_z".into(), "thr_1".into());
        assert!(o3.enter_terminated("eof"));
        assert_eq!(o3.guard_count(), 0);
        assert_eq!(o3.evaluate_close_request_at(false, &sink, t0), CloseDecision::AllowExit);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_exit_path_wedges_and_l7_thread_checks_t_l13() {
        // 1. Pure order check: exit_started=true AND forced guard>0 still Coalesces (T-L13)
        let sink = Arc::new(TestSink::default());
        let mut o_pure = ClientOwner::new(1);
        o_pure.phase = LifecyclePhase::Open;
        o_pure.in_flight_turn_ids.insert("t_force".into(), "thr".into());
        assert_eq!(
            o_pure.evaluate_close_request_at(true, &*sink, Instant::now()),
            CloseDecision::Coalesce,
            "must check exit_started before guard"
        );

        // 2. Wedge test: holding client lock > 2 s -> Exit expires EXIT_LOCK_WAIT at 2 s and stops
        //    the EOF-ignoring child via stop_fallback within EXIT_BOUND (2 s wait + 7 s grace = 9 s).
        let mut c_wedge = Command::new("/bin/sh")
            .arg("-c")
            .arg("cat; exec sleep 40")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let wedge_pid = c_wedge.id();
        let wedge_stdin = c_wedge.stdin.take();
        let ctrl_w = Arc::new(DesktopController::new());
        let stop_wedge = Arc::new(Mutex::new(StopState {
            cancel_stream: None,
            spawned: Some(SpawnedServe {
                child: SharedChild::new(c_wedge),
                stdin: wedge_stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            }),
            in_flight: None,
            reader_done: Arc::new(AtomicBool::new(true)),
            hooks: None,
        }));
        *ctrl_w.stop_fallback.lock().unwrap() = Some(Arc::clone(&stop_wedge));

        // Hold ctrl_w.client for 2.5 s while Exit starts -> Exit expires EXIT_LOCK_WAIT at 2s and stops via stop_fallback!
        let hold_g = ctrl_w.client.lock().unwrap();
        let t_exit0 = Instant::now();
        ctrl_w.handle_run_event_exit(&*sink, t_exit0);
        let elapsed_w = t_exit0.elapsed();
        drop(hold_g);
        assert!(
            elapsed_w >= Duration::from_millis(8500) && elapsed_w <= Duration::from_millis(10_500),
            "T-L13 wedge bound must finish within EXIT_BOUND (2s lock wait + 7s kill grace = 9s), got {elapsed_w:?}"
        );
        unsafe {
            let mut st: libc::c_int = 0;
            let _ = libc::waitpid(wedge_pid as libc::pid_t, &mut st, libc::WNOHANG);
            let mut alive = libc::kill(wedge_pid as libc::pid_t, 0) == 0;
            if alive {
                thread::sleep(Duration::from_millis(50));
                let _ = libc::waitpid(wedge_pid as libc::pid_t, &mut st, libc::WNOHANG);
                alive = libc::kill(wedge_pid as libc::pid_t, 0) == 0;
            }
            assert!(!alive, "wedged child must be dead");
        }
        assert!(ctrl_w.shutting_down.load(Ordering::Acquire));
        assert!(ctrl_w.exit_started.load(Ordering::Acquire));

        // 3. Stalled L7 test: L7 runs on worker thread (distinct ThreadId), owner remains unlocked during L7,
        //    and stalled L7 past EXIT_BOUND kills child via SharedChild at deadline.
        let main_tid = thread::current().id();
        let l7_tid_rec: Arc<Mutex<Option<thread::ThreadId>>> = Arc::new(Mutex::new(None));
        let l7_tid_c = Arc::clone(&l7_tid_rec);
        let owner_check = Arc::new(Mutex::new(ClientOwner::new(88)));
        owner_check.lock().unwrap().phase = LifecyclePhase::Open;

        let mut c_stall = Command::new("/bin/sh")
            .arg("-c")
            .arg("cat; exec sleep 40")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stall_pid = c_stall.id();
        let stall_stdin = c_stall.stdin.take();
        let stall_shared = SharedChild::new(c_stall);
        let stop_stall = Arc::new(Mutex::new(StopState {
            cancel_stream: None,
            spawned: Some(SpawnedServe {
                child: stall_shared.clone(),
                stdin: stall_stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            }),
            in_flight: None,
            reader_done: Arc::new(AtomicBool::new(true)),
            hooks: Some(Arc::new(TestStopHooks {
                delay_l7: Some(Duration::from_secs(12)), // exceeds EXIT_BOUND
                on_l7_thread: Some(Arc::new(move |tid| {
                    *l7_tid_c.lock().unwrap() = Some(tid);
                })),
                ..Default::default()
            })),
        }));
        let ctrl_s = DesktopController::new();
        *ctrl_s.stop_fallback.lock().unwrap() = Some(Arc::clone(&stop_stall));
        let t_s0 = Instant::now();
        assert!(owner_check.try_lock().is_ok());
        ctrl_s.handle_run_event_exit(&*sink, t_s0 - Duration::from_secs(7)); // only 2s left in 9s bound
        let elapsed_s = t_s0.elapsed();
        assert!(elapsed_s >= Duration::from_millis(1800) && elapsed_s <= Duration::from_millis(2900), "got {elapsed_s:?}");
        assert_ne!(*l7_tid_rec.lock().unwrap(), Some(main_tid), "T-L13: L7 must NOT run on CloseRequested/event-loop thread");
        assert_eq!(stall_shared.kill_count(), 1, "stalled L7 expiry must kill exactly once through SharedChild");
        unsafe {
            let mut st: libc::c_int = 0;
            let deadline_reap = Instant::now() + Duration::from_millis(250);
            let mut dead = false;
            while Instant::now() < deadline_reap {
                let w = libc::waitpid(stall_pid as libc::pid_t, &mut st, libc::WNOHANG);
                if w == stall_pid as libc::pid_t || libc::kill(stall_pid as libc::pid_t, 0) != 0 {
                    dead = true;
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            assert!(dead, "stalled L7 expiry must SIGKILL child");
        }

        // 4. Allow -> Exit and confirm_quit -> Exit coalesce and emit exactly 1 terminal
        let tmp = std::env::temp_dir().join(format!("madc-tl13-allow-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let l = UnixListener::bind(&tmp).unwrap();
        let (p_done_tx, p_done_rx) = mpsc::sync_channel::<()>(1);
        let p = thread::spawn(move || {
            let mut held = Vec::new();
            for _ in 0..2 {
                let (s, _) = l.accept().unwrap();
                let mut w = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                let mut buf = Vec::new();
                let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                let v: Value = serde_json::from_str(&req).unwrap();
                writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
                w.flush().unwrap();
                held.push((r, w));
            }
            let _ = p_done_rx.recv_timeout(Duration::from_secs(5));
        });

        // Allow -> Exit
        let sink_a = Arc::new(TestSink::default());
        let cli_a = SocketClient::connect_existing_with_sink(tmp.to_str().unwrap(), Arc::clone(&sink_a) as Arc<dyn EventSink>).unwrap();
        let ctrl_a = DesktopController::new();
        ctrl_a.set_client_for_test(cli_a);
        assert_eq!(ctrl_a.handle_close_or_exit_at(&*sink_a, Instant::now()), CloseDecision::AllowExit);
        // Subsequent close coalesces; Exit joins with zero second terminal
        assert_eq!(ctrl_a.handle_close_or_exit_at(&*sink_a, Instant::now()), CloseDecision::Coalesce);
        ctrl_a.handle_run_event_exit(&*sink_a, Instant::now());
        let evs_a = sink_a.engine_events.lock().unwrap();
        let terms_a: Vec<_> = evs_a.iter().filter(|(_, v)| v["method"] == "madc/transport-closed").collect();
        assert_eq!(terms_a.len(), 1);
        assert_eq!(terms_a[0].1["params"]["reason"], "exit");

        // confirm_quit -> Exit
        let sink_q = Arc::new(TestSink::default());
        let cli_q = SocketClient::connect_existing_with_sink(tmp.to_str().unwrap(), Arc::clone(&sink_q) as Arc<dyn EventSink>).unwrap();
        cli_q.inner.owner.lock().unwrap().in_flight_turn_ids.insert("turn_q".into(), "thr_q".into());
        let ctrl_q = DesktopController::new();
        ctrl_q.set_client_for_test(cli_q);
        let now_q = Instant::now();
        let CloseDecision::PreventQuitRequested { epoch: eq, request_id: rq } =
            ctrl_q.handle_close_or_exit_at(&*sink_q, now_q)
        else { panic!() };
        assert!(ctrl_q.confirm_quit_at(eq, rq, &*sink_q, now_q).accepted);
        ctrl_q.handle_run_event_exit(&*sink_q, now_q);
        let evs_q = sink_q.engine_events.lock().unwrap();
        let terms_q: Vec<_> = evs_q.iter().filter(|(_, v)| v["method"] == "madc/transport-closed").collect();
        assert_eq!(terms_q.len(), 1);
        assert_eq!(terms_q[0].1["params"]["reason"], "exit");

        let _ = p_done_tx.send(());
        p.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn exit_paths_bound_write_half_under_40_blocked_writers_h1() {
        // Helper: run one exit path (`exit`, `allow`, or `confirm_quit`) against a peer that
        // never reads after `initialize`, with 40 concurrent 60 KB `turn/start` writers saturating
        // the Unix socket send buffer and holding `write_half`.
        fn run_blocked_writers_scenario(mode: &'static str) {
            let tmp = std::env::temp_dir().join(format!(
                "madc-h1-{mode}-{}.sock",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&tmp);
            let listener = UnixListener::bind(&tmp).unwrap();
            let (peer_done_tx, peer_done_rx) = mpsc::sync_channel::<()>(1);
            let peer = thread::spawn(move || {
                let (s, _) = listener.accept().unwrap();
                let mut w = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                let mut buf = Vec::new();
                let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else {
                    panic!("expected initialize");
                };
                let v: Value = serde_json::from_str(&req).unwrap();
                writeln!(
                    w,
                    "{}",
                    json!({
                        "id": v["id"],
                        "result": {
                            "protocolVersion": "madc-m1/1",
                            "serverInfo": { "name": "madc-engine", "version": "0.0.0" }
                        }
                    })
                )
                .unwrap();
                w.flush().unwrap();
                // NEVER read another byte from `r` until test finishes!
                let _ = peer_done_rx.recv_timeout(Duration::from_secs(20));
                drop((r, w));
            });

            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; exit 0")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let child_stdin = child.stdin.take();
            let shared = SharedChild::new(child);
            let spawned = SpawnedServe {
                child: shared.clone(),
                stdin: child_stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            };

            let sink = Arc::new(TestSink::default());
            let client = SocketClient::connect_existing_with_sink_and_hooks(
                tmp.to_str().unwrap(),
                Arc::clone(&sink) as Arc<dyn EventSink>,
                Some(spawned),
                None,
            )
            .expect("connect");
            let ctrl = Arc::new(DesktopController::new());
            ctrl.set_client_for_test(client.clone());

            let big_text = "x".repeat(60 * 1024);
            let mut writers = Vec::with_capacity(40);
            for _ in 0..40 {
                let c = client.clone();
                let txt = big_text.clone();
                writers.push(thread::spawn(move || {
                    let _ = c.request(
                        "turn/start",
                        json!({
                            "threadId": "thr_h1",
                            "input": [{ "type": "text", "text": txt }]
                        }),
                    );
                }));
            }

            // Wait deterministically until a writer is holding `write_half` inside `write_all`.
            let wait_lock = Instant::now() + Duration::from_secs(3);
            let mut contended = false;
            while Instant::now() < wait_lock {
                if client.inner.write_half.try_lock().is_err() {
                    contended = true;
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            assert!(
                contended,
                "H-1 ({mode}): expected >= 1 of 40 60 KB writers to block holding write_half"
            );

            // Also verify a queued writer with a short deadline (250 ms) never exceeds its
            // deadline waiting for write_half or writing (H-1 post-lock write timeout).
            if mode == "exit" {
                let t_q = Instant::now();
                let q_err = client
                    .request_with_deadline(
                        "room/inspect",
                        json!({}),
                        t_q + Duration::from_millis(250),
                    )
                    .unwrap_err();
                let q_elapsed = t_q.elapsed();
                assert!(q_err.contains("timed out"), "unexpected queued err: {q_err}");
                assert!(
                    q_elapsed < Duration::from_millis(1200),
                    "H-1 queued writer exceeded its 250ms deadline: {q_elapsed:?}"
                );
            }

            let t0 = Instant::now();
            match mode {
                "exit" => {
                    ctrl.handle_run_event_exit(&*sink, t0);
                }
                "allow" => {
                    // Mark fallback live so `handle_close_or_exit_at` takes the real AllowExit
                    // branch even with 40 pending `turn/start` writers on `write_half`.
                    client.inner.owner.lock().unwrap().quit_fallback_set_at = Some(t0);
                    assert_eq!(
                        ctrl.handle_close_or_exit_at(&*sink, t0),
                        CloseDecision::AllowExit
                    );
                }
                "confirm_quit" => {
                    let CloseDecision::PreventQuitRequested { epoch, request_id } =
                        ctrl.handle_close_or_exit_at(&*sink, t0)
                    else {
                        panic!("expected PreventQuitRequested with 40 pending turn/start writers");
                    };
                    let res = ctrl.confirm_quit_at(epoch, request_id, &*sink, t0);
                    assert!(res.accepted, "confirm_quit must be accepted");
                }
                _ => unreachable!(),
            }
            let call_elapsed = t0.elapsed();
            assert!(
                call_elapsed <= EXIT_BOUND + Duration::from_millis(500),
                "H-1 ({mode}): exit path exceeded EXIT_BOUND ({EXIT_BOUND:?}): {call_elapsed:?}"
            );

            // Wait (within EXIT_BOUND + 500ms from t0) for both child reap and reader wake.
            let done_by = t0 + EXIT_BOUND + Duration::from_millis(500);
            while Instant::now() < done_by && (!shared.is_reaped() || !client.reader_done()) {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                shared.is_reaped(),
                "H-1 ({mode}): child must be stopped/reaped within EXIT_BOUND"
            );
            assert!(
                client.reader_done(),
                "H-1 ({mode}): reader/socket must be stopped within EXIT_BOUND"
            );

            let _ = peer_done_tx.send(());
            for w in writers {
                let _ = w.join();
            }
            peer.join().unwrap();
            let _ = std::fs::remove_file(&tmp);
        }

        // Run all 3 paths concurrently so wall-clock time stays ~2.3 s.
        let h_exit = thread::spawn(|| run_blocked_writers_scenario("exit"));
        let h_allow = thread::spawn(|| run_blocked_writers_scenario("allow"));
        let h_confirm = thread::spawn(|| run_blocked_writers_scenario("confirm_quit"));
        h_exit.join().unwrap();
        h_allow.join().unwrap();
        h_confirm.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn real_spawn_failure_fallback_covers_all_callers_and_respects_deadline_h2() {
        fn run_spawn_fail_caller(caller: &'static str) {
            let tmp = std::env::temp_dir().join(format!(
                "madc-h2-{caller}-{}.sock",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&tmp);
            let listener = UnixListener::bind(&tmp).unwrap();
            let (peer_done_tx, peer_done_rx) = mpsc::sync_channel::<()>(1);
            let peer = thread::spawn(move || {
                let (s, _) = listener.accept().unwrap();
                let mut w = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                let mut buf = Vec::new();
                let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else {
                    panic!();
                };
                let v: Value = serde_json::from_str(&req).unwrap();
                writeln!(
                    w,
                    "{}",
                    json!({
                        "id": v["id"],
                        "result": {
                            "protocolVersion": "madc-m1/1",
                            "serverInfo": { "name": "madc-engine", "version": "0.0.0" }
                        }
                    })
                )
                .unwrap();
                w.flush().unwrap();
                let _ = peer_done_rx.recv_timeout(Duration::from_secs(10));
            });

            // EOF-ignoring child: if fallback ignored caller's deadline and used 7 s grace, this
            // test would take >= 7 s and fail the deadline assertion.
            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; exec sleep 40")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let child_pid = child.id();
            let child_stdin = child.stdin.take();
            let shared = SharedChild::new(child);
            let spawned = SpawnedServe {
                child: shared.clone(),
                stdin: child_stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            };

            let fallback_ran = Arc::new(AtomicBool::new(false));
            let locks_free_in_fallback = Arc::new(AtomicBool::new(false));
            let stop_arc_holder: Arc<Mutex<Option<Arc<Mutex<StopState>>>>> =
                Arc::new(Mutex::new(None));
            let owner_arc_holder: Arc<Mutex<Option<Arc<Mutex<ClientOwner>>>>> =
                Arc::new(Mutex::new(None));

            let fallback_ran_c = Arc::clone(&fallback_ran);
            let locks_free_c = Arc::clone(&locks_free_in_fallback);
            let stop_h = Arc::clone(&stop_arc_holder);
            let owner_h = Arc::clone(&owner_arc_holder);
            let fail_spawner: StopWorkerSpawner = Arc::new(|_| {
                Err(std::io::Error::new(
                    ErrorKind::WouldBlock,
                    "injected OS thread spawn failure",
                ))
            });
            let caller_tid = thread::current().id();
            let ran_on_caller = Arc::new(AtomicBool::new(false));
            let ran_on_caller_c = Arc::clone(&ran_on_caller);

            let hooks = Arc::new(TestStopHooks {
                spawner: Some(fail_spawner),
                on_l7_thread: Some(Arc::new(move |tid| {
                    if tid == caller_tid {
                        ran_on_caller_c.store(true, Ordering::Release);
                    }
                })),
                on_inline_fallback: Some(Arc::new(move || {
                    fallback_ran_c.store(true, Ordering::Release);
                    let dl = Instant::now() + Duration::from_millis(50);
                    let stop_ok = stop_h
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|s| lock_with_deadline(s, dl).is_some());
                    let owner_ok = owner_h
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|o| lock_with_deadline(o, dl).is_some());
                    if stop_ok && owner_ok {
                        locks_free_c.store(true, Ordering::Release);
                    }
                })),
                ..Default::default()
            });

            let sink = Arc::new(TestSink::default());
            let client = SocketClient::connect_existing_with_sink_and_hooks(
                tmp.to_str().unwrap(),
                Arc::clone(&sink) as Arc<dyn EventSink>,
                Some(spawned),
                Some(hooks),
            )
            .expect("connect");
            *stop_arc_holder.lock().unwrap() = Some(Arc::clone(&client.inner.stop_state));
            *owner_arc_holder.lock().unwrap() = Some(Arc::clone(&client.inner.owner));

            let ctrl = DesktopController::new();
            ctrl.set_client_for_test(client.clone());

            // Use a short remaining deadline (~350 ms) so fixed 7 s grace fails immediately.
            let t0 = Instant::now();
            match caller {
                "allow_only" => {
                    let dec = ctrl
                        .handle_close_or_exit_at(&*sink, t0 - (EXIT_BOUND - Duration::from_millis(350)));
                    assert_eq!(dec, CloseDecision::AllowExit);
                }
                "confirm_quit_only" => {
                    client
                        .inner
                        .owner
                        .lock()
                        .unwrap()
                        .in_flight_turn_ids
                        .insert("turn_h2".into(), "thr_h2".into());
                    let req_now = t0 - (EXIT_BOUND - Duration::from_millis(350));
                    let CloseDecision::PreventQuitRequested { epoch, request_id } =
                        ctrl.handle_close_or_exit_at(&*sink, req_now)
                    else {
                        panic!("expected PreventQuitRequested");
                    };
                    assert!(ctrl.confirm_quit_at(epoch, request_id, &*sink, req_now).accepted);
                }
                "disconnect_engine" => {
                    client.close_and_stop("disconnect", t0 + Duration::from_millis(350));
                }
                "exit" => {
                    ctrl.handle_run_event_exit(&*sink, t0 - (EXIT_BOUND - Duration::from_millis(350)));
                }
                _ => unreachable!(),
            }
            let elapsed = t0.elapsed();

            assert!(
                fallback_ran.load(Ordering::Acquire),
                "H-2 ({caller}): real Err spawn-failure branch must execute"
            );
            assert!(
                ran_on_caller.load(Ordering::Acquire),
                "H-2 ({caller}): fallback must run inline on caller's thread"
            );
            assert!(
                locks_free_in_fallback.load(Ordering::Acquire),
                "H-2 ({caller}): stop_state and owner locks must NOT be held during inline fallback"
            );
            assert!(
                elapsed < Duration::from_secs(2),
                "H-2 ({caller}): must honor caller's 350ms deadline (not fixed 7 s grace), got {elapsed:?}"
            );
            assert!(
                shared.is_reaped(),
                "H-2 ({caller}): child must be killed and reaped"
            );
            assert_eq!(
                shared.kill_count(),
                1,
                "H-2 ({caller}): kill must be issued exactly once"
            );
            // Calling kill_once again after reap must be a no-op (no signal after reap).
            assert!(!shared.kill_once(), "H-2 ({caller}): must never signal after reap");
            assert_eq!(shared.kill_count(), 1);
            unsafe {
                assert_ne!(
                    libc::kill(child_pid as libc::pid_t, 0),
                    0,
                    "H-2 ({caller}): child pid must be dead"
                );
            }

            let wait_reader = Instant::now() + Duration::from_secs(2);
            while Instant::now() < wait_reader && !client.reader_done() {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                client.reader_done(),
                "H-2 ({caller}): shutdown(Shutdown::Both) must wake blocked reader"
            );

            let _ = peer_done_tx.send(());
            peer.join().unwrap();
            let _ = std::fs::remove_file(&tmp);
        }

        for caller in ["allow_only", "confirm_quit_only", "disconnect_engine", "exit"] {
            run_spawn_fail_caller(caller);
        }

        // Already-exited child must NOT receive SIGKILL in spawn-failure fallback.
        let mut quick = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let quick_stdin = quick.stdin.take();
        let quick_shared = SharedChild::new(quick);
        // Wait until process exits and is reaped BEFORE fallback runs.
        assert!(quick_shared.reap_bounded(Duration::from_secs(2)).is_some());
        let fail_spawner: StopWorkerSpawner = Arc::new(|_| {
            Err(std::io::Error::new(ErrorKind::WouldBlock, "spawn fail"))
        });
        let stop_arc = Arc::new(Mutex::new(StopState {
            cancel_stream: None,
            spawned: Some(SpawnedServe {
                child: quick_shared.clone(),
                stdin: quick_stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            }),
            in_flight: None,
            reader_done: Arc::new(AtomicBool::new(true)),
            hooks: Some(Arc::new(TestStopHooks {
                spawner: Some(fail_spawner),
                ..Default::default()
            })),
        }));
        stop_child(&stop_arc, Instant::now() + Duration::from_millis(100));
        assert_eq!(
            quick_shared.kill_count(),
            0,
            "H-2: already-reaped child must NEVER be signalled"
        );
    }

    #[cfg(unix)]
    #[test]
    fn allow_starter_hands_off_without_blocking_event_loop_m1() {
        let tmp = std::env::temp_dir().join(format!("madc-m1-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let (peer_done_tx, peer_done_rx) = mpsc::sync_channel::<()>(1);
        let peer = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v: Value = serde_json::from_str(&req).unwrap();
            writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            w.flush().unwrap();
            let _ = peer_done_rx.recv_timeout(Duration::from_secs(10));
        });

        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("cat >/dev/null; exit 0")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child_stdin = child.stdin.take();
        let shared = SharedChild::new(child);
        let spawned = SpawnedServe {
            child: shared.clone(),
            stdin: child_stdin,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stderr_done: None,
            stderr_thread: None,
            initialized: true,
        };
        let hooks = Arc::new(TestStopHooks {
            delay_l7: Some(Duration::from_millis(1200)),
            ..Default::default()
        });
        let sink = Arc::new(TestSink::default());
        let client = SocketClient::connect_existing_with_sink_and_hooks(
            tmp.to_str().unwrap(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
            Some(spawned),
            Some(hooks),
        )
        .unwrap();
        let ctrl = DesktopController::new();
        ctrl.set_client_for_test(client.clone());

        let t0 = Instant::now();
        let dec = ctrl.handle_close_or_exit_at(&*sink, t0);
        let elapsed = t0.elapsed();
        assert_eq!(dec, CloseDecision::AllowExit);
        assert!(
            elapsed < Duration::from_millis(350),
            "M-1: allow starter on event loop must hand off without waiting for stalled L7 worker (1200ms), got {elapsed:?}"
        );

        // Background L7 worker still finishes stopping the child and waking reader.
        let wait_by = Instant::now() + Duration::from_secs(4);
        while Instant::now() < wait_by && (!shared.is_reaped() || !client.reader_done()) {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(shared.is_reaped(), "M-1: background L7 worker must finish stopping child");
        assert!(client.reader_done(), "M-1: background L7 worker must wake reader");

        let _ = peer_done_tx.send(());
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn buffered_turn_events_bounded_cleared_and_duplicate_turn_id_f2_m2() {
        // 1. Bound: MAX_BUFFERED_TURN_EVENTS_PER_START (16) distinct (turn_id, kind) entries,
        //    deduplicated, dropping newest + counting drops on overflow.
        assert_eq!(MAX_BUFFERED_TURN_EVENTS_PER_START, 16);
        let mut o = ClientOwner::new(1);
        o.phase = LifecyclePhase::Open;
        *o.pending_starts.entry("thr_b".to_string()).or_insert(0) += 1;
        o.pending_starts_total += 1;
        for i in 0..25 {
            o.observe_turn_notification(
                "turn/started",
                &json!({"turn":{"id":format!("t_{i}"),"threadId":"thr_b","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":null}}),
            );
        }
        // Duplicate of an already-buffered entry must not count as overflow drop or duplicate.
        o.observe_turn_notification(
            "turn/started",
            &json!({"turn":{"id":"t_0","threadId":"thr_b","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":null}}),
        );
        let buf = o.buffered_turn_events.get("thr_b").unwrap();
        assert_eq!(buf.len(), MAX_BUFFERED_TURN_EVENTS_PER_START);
        assert_eq!(buf[0], ("t_0".to_string(), "started"));
        assert_eq!(buf[15], ("t_15".to_string(), "started"));
        assert_eq!(o.dropped_buffered_turn_events, 9);

        // Clear on refusal/error/admission/leaving Open.
        assert!(o.finish_pending_turn_start("thr_b", None).is_ok());
        assert!(o.buffered_turn_events.is_empty());

        *o.pending_starts.entry("thr_b".to_string()).or_insert(0) += 1;
        o.pending_starts_total += 1;
        o.observe_turn_notification(
            "turn/started",
            &json!({"turn":{"id":"t_ok","threadId":"thr_b","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":null}}),
        );
        assert!(o.finish_pending_turn_start("thr_b", Some("t_ok")).is_ok());
        assert!(o.buffered_turn_events.is_empty());

        // Clear on leaving Open (Terminated).
        *o.pending_starts.entry("thr_c".to_string()).or_insert(0) += 1;
        o.pending_starts_total += 1;
        o.observe_turn_notification(
            "turn/started",
            &json!({"turn":{"id":"t_c","threadId":"thr_c","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":null}}),
        );
        assert!(!o.buffered_turn_events.is_empty());
        assert!(o.enter_terminated("eof"));
        assert!(o.buffered_turn_events.is_empty());

        // 2. Live socket: timeout clears buffered_turn_events; duplicate admitted turn.id is
        //    refused as F2 (`invalid-frame`), not delivered as success.
        let tmp = std::env::temp_dir().join(format!("madc-m2-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let (peer_done_tx, peer_done_rx) = mpsc::sync_channel::<()>(1);
        let peer = thread::spawn(move || {
            for case in 0..2 {
                let (s, _) = listener.accept().unwrap();
                let mut w = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                let mut buf = Vec::new();
                // initialize
                let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                let v: Value = serde_json::from_str(&req).unwrap();
                writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
                w.flush().unwrap();

                if case == 0 {
                    // Req 1: send pre-reply turn/started, then do NOT reply (client times out).
                    let BoundedLine::Line(_) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                    writeln!(w, "{}", json!({"method":"turn/started","params":{"turn":{"id":"turn_to","threadId":"thr_to","status":"inProgress","items":[],"error":null,"startedAt":1,"completedAt":null}}})).unwrap();
                    w.flush().unwrap();

                    // Req 2: admit turn_dup
                    let BoundedLine::Line(req2) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                    let v2: Value = serde_json::from_str(&req2).unwrap();
                    writeln!(w, "{}", json!({"id":v2["id"],"result":{"turn":{"id":"turn_dup","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}}})).unwrap();
                    w.flush().unwrap();

                    // Req 3: second turn/start returns the SAME already-admitted turn_dup -> F2!
                    let BoundedLine::Line(req3) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                    let v3: Value = serde_json::from_str(&req3).unwrap();
                    writeln!(w, "{}", json!({"id":v3["id"],"result":{"turn":{"id":"turn_dup","threadId":"thr_2","status":"inProgress","items":[],"error":null,"startedAt":11,"completedAt":null}}})).unwrap();
                    w.flush().unwrap();
                } else {
                    // Case 1: admit turn_done, complete it, then return turn_done AGAIN -> F2!
                    let BoundedLine::Line(req1) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                    let v1: Value = serde_json::from_str(&req1).unwrap();
                    writeln!(w, "{}", json!({"id":v1["id"],"result":{"turn":{"id":"turn_done","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":10,"completedAt":null}}})).unwrap();
                    writeln!(w, "{}", json!({"method":"turn/completed","params":{"turn":{"id":"turn_done","threadId":"thr_1","status":"completed","items":[],"error":null,"startedAt":10,"completedAt":12}}})).unwrap();
                    w.flush().unwrap();

                    let BoundedLine::Line(req2) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                    let v2: Value = serde_json::from_str(&req2).unwrap();
                    writeln!(w, "{}", json!({"id":v2["id"],"result":{"turn":{"id":"turn_done","threadId":"thr_1","status":"inProgress","items":[],"error":null,"startedAt":13,"completedAt":null}}})).unwrap();
                    w.flush().unwrap();
                }
                let _ = peer_done_rx.recv_timeout(Duration::from_secs(5));
            }
        });

        let sink1 = Arc::new(TestSink::default());
        let c1 = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink1) as Arc<dyn EventSink>,
        )
        .unwrap();
        // Timeout must clear buffered_turn_events.
        let to_err = c1
            .request_with_deadline(
                "turn/start",
                json!({"threadId":"thr_to","input":[{"type":"text","text":"to"}]}),
                Instant::now() + Duration::from_millis(120),
            )
            .unwrap_err();
        assert!(to_err.contains("timed out"));
        assert!(
            c1.inner.owner.lock().unwrap().buffered_turn_events.is_empty(),
            "M-2: buffered_turn_events must be cleared on turn/start timeout"
        );

        // First admission of turn_dup succeeds.
        assert!(c1
            .request(
                "turn/start",
                json!({"threadId":"thr_1","input":[{"type":"text","text":"1"}]})
            )
            .is_ok());
        assert_eq!(c1.inner.owner.lock().unwrap().guard_count(), 1);

        // Second admission of turn_dup fails as F2 invalid-frame (NOT Ok!).
        let dup_err = c1
            .request(
                "turn/start",
                json!({"threadId":"thr_2","input":[{"type":"text","text":"2"}]})
            )
            .expect_err("M-2: duplicate admitted turn.id must be refused as F2 invalid-frame");
        assert!(
            dup_err.contains("invalid-frame"),
            "expected invalid-frame, got: {dup_err}"
        );
        let wait_term = Instant::now() + Duration::from_secs(2);
        while Instant::now() < wait_term
            && !sink1
                .engine_events
                .lock()
                .unwrap()
                .iter()
                .any(|(_, v)| v["method"] == "madc/transport-closed")
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            sink1.engine_events.lock().unwrap().iter().any(|(_, v)| {
                v["method"] == "madc/transport-closed" && v["params"]["reason"] == "invalid-frame"
            }),
            "M-2: duplicate turn.id must emit madc/transport-closed(invalid-frame)"
        );
        assert_eq!(c1.inner.owner.lock().unwrap().guard_count(), 0);
        c1.disconnect();
        let _ = peer_done_tx.send(());

        // Case 1: already-completed turn.id reused on same connection is ALSO refused as F2.
        let sink2 = Arc::new(TestSink::default());
        let c2 = SocketClient::connect_existing_with_sink(
            tmp.to_str().unwrap(),
            Arc::clone(&sink2) as Arc<dyn EventSink>,
        )
        .unwrap();
        assert!(c2
            .request(
                "turn/start",
                json!({"threadId":"thr_1","input":[{"type":"text","text":"a"}]})
            )
            .is_ok());
        let wait_zero = Instant::now() + Duration::from_secs(2);
        while Instant::now() < wait_zero && c2.inner.owner.lock().unwrap().guard_count() != 0 {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(c2.inner.owner.lock().unwrap().guard_count(), 0);
        let dup_after_done = c2
            .request(
                "turn/start",
                json!({"threadId":"thr_1","input":[{"type":"text","text":"b"}]})
            )
            .expect_err("M-2: previously admitted turn.id reused on same connection must be F2");
        assert!(dup_after_done.contains("invalid-frame"), "got: {dup_after_done}");
        c2.disconnect();
        let _ = peer_done_tx.send(());

        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn shared_child_kill_semantics_worker_deadline_and_no_later_exit_m3() {
        // 1. SharedChild: never kills after reap; never kills twice.
        let c_fast = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let sc_fast = SharedChild::new(c_fast);
        assert!(sc_fast.reap_bounded(Duration::from_secs(2)).is_some());
        assert!(!sc_fast.kill_once(), "M-3: must never kill after reap");
        assert_eq!(sc_fast.kill_count(), 0);

        let c_slow = Command::new("/bin/sh")
            .arg("-c")
            .arg("exec sleep 30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let sc_slow = SharedChild::new(c_slow);
        assert!(sc_slow.kill_once(), "first kill_once must issue kill");
        assert!(!sc_slow.kill_once(), "second kill_once must be a no-op");
        assert_eq!(sc_slow.kill_count(), 1);
        assert!(sc_slow.reap_bounded(Duration::from_secs(2)).is_some());

        // 2. Worker honors caller's short deadline (kills R11 mutation where worker used a fresh
        //    DISCONNECT_STOP_BOUND = 7 s instead of caller's deadline).
        let mut c_r11 = Command::new("/bin/sh")
            .arg("-c")
            .arg("cat >/dev/null; exec sleep 30")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let r11_stdin = c_r11.stdin.take();
        let r11_shared = SharedChild::new(c_r11);
        let r11_stop = Arc::new(Mutex::new(StopState {
            cancel_stream: None,
            spawned: Some(SpawnedServe {
                child: r11_shared.clone(),
                stdin: r11_stdin,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stderr_done: None,
                stderr_thread: None,
                initialized: true,
            }),
            in_flight: None,
            reader_done: Arc::new(AtomicBool::new(true)),
            hooks: None,
        }));
        let t_r11 = Instant::now();
        // Use stop_child_async so ONLY the worker (not caller expiry) enforces the 300 ms deadline!
        stop_child_async(&r11_stop, t_r11 + Duration::from_millis(300));
        let deadline_r11 = t_r11 + Duration::from_secs(2);
        while Instant::now() < deadline_r11 && !r11_shared.is_reaped() {
            thread::sleep(Duration::from_millis(15));
        }
        let r11_elapsed = t_r11.elapsed();
        assert!(
            r11_shared.is_reaped() && r11_elapsed < Duration::from_secs(2),
            "M-3 (R11): worker must honor caller's 300 ms deadline (not fresh 7 s DISCONNECT_STOP_BOUND), elapsed={r11_elapsed:?}"
        );
        assert_eq!(r11_shared.kill_count(), 1);

        // 3. T-L7 stall past DISCONNECT_STOP_BOUND (expiry kills once through SharedChild) AND
        //    "no later Exit" cases (allow-only and confirm_quit-only with NO handle_run_event_exit)
        //    all run concurrently to keep wall-clock time within 8 s.
        let h_tl7 = thread::spawn(|| {
            let mut c = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; exec sleep 40")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let stdin = c.stdin.take();
            let shared = SharedChild::new(c);
            let stop_arc = Arc::new(Mutex::new(StopState {
                cancel_stream: None,
                spawned: Some(SpawnedServe {
                    child: shared.clone(),
                    stdin,
                    stderr_buf: Arc::new(Mutex::new(String::new())),
                    stderr_done: None,
                    stderr_thread: None,
                    initialized: true,
                }),
                in_flight: None,
                reader_done: Arc::new(AtomicBool::new(true)),
                hooks: Some(Arc::new(TestStopHooks {
                    delay_l7: Some(Duration::from_secs(12)), // stalls past DISCONNECT_STOP_BOUND
                    ..Default::default()
                })),
            }));
            let t0 = Instant::now();
            stop_child(&stop_arc, t0 + DISCONNECT_STOP_BOUND);
            let elapsed = t0.elapsed();
            assert!(
                elapsed >= Duration::from_millis(6500) && elapsed <= Duration::from_millis(8500),
                "T-L7 stall past DISCONNECT_STOP_BOUND must expire at ~7 s, got {elapsed:?}"
            );
            assert!(shared.is_reaped(), "T-L7 expiry must kill and reap child");
            assert_eq!(shared.kill_count(), 1, "T-L7 expiry must kill strictly once");
        });

        let h_no_exit_allow = thread::spawn(|| {
            let tmp = std::env::temp_dir().join(format!(
                "madc-m3-allow-only-{}.sock",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&tmp);
            let l = UnixListener::bind(&tmp).unwrap();
            let (tx, rx) = mpsc::sync_channel::<()>(1);
            let p = thread::spawn(move || {
                let (s, _) = l.accept().unwrap();
                let mut w = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                let mut buf = Vec::new();
                let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                let v: Value = serde_json::from_str(&req).unwrap();
                writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
                w.flush().unwrap();
                let _ = rx.recv_timeout(Duration::from_secs(12));
            });
            let mut c = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; exec sleep 40")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let stdin = c.stdin.take();
            let shared = SharedChild::new(c);
            let sink = Arc::new(TestSink::default());
            let cli = SocketClient::connect_existing_with_sink_and_hooks(
                tmp.to_str().unwrap(),
                Arc::clone(&sink) as Arc<dyn EventSink>,
                Some(SpawnedServe {
                    child: shared.clone(),
                    stdin,
                    stderr_buf: Arc::new(Mutex::new(String::new())),
                    stderr_done: None,
                    stderr_thread: None,
                    initialized: true,
                }),
                None,
            )
            .unwrap();
            let ctrl = DesktopController::new();
            ctrl.set_client_for_test(cli);

            let t0 = Instant::now();
            // Allow-only: NO handle_run_event_exit call!
            assert_eq!(ctrl.handle_close_or_exit_at(&*sink, t0), CloseDecision::AllowExit);
            let wait_by = t0 + EXIT_BOUND;
            while Instant::now() < wait_by && !shared.is_reaped() {
                thread::sleep(Duration::from_millis(25));
            }
            assert!(
                shared.is_reaped(),
                "M-3: allow-only (no later Exit) must stop/kill child within EXIT_BOUND"
            );
            assert_eq!(shared.kill_count(), 1);
            let _ = tx.send(());
            p.join().unwrap();
            let _ = std::fs::remove_file(&tmp);
        });

        let h_no_exit_confirm = thread::spawn(|| {
            let tmp = std::env::temp_dir().join(format!(
                "madc-m3-confirm-only-{}.sock",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&tmp);
            let l = UnixListener::bind(&tmp).unwrap();
            let (tx, rx) = mpsc::sync_channel::<()>(1);
            let p = thread::spawn(move || {
                let (s, _) = l.accept().unwrap();
                let mut w = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                let mut buf = Vec::new();
                let BoundedLine::Line(req) = read_bounded_line(&mut r, &mut buf) else { panic!() };
                let v: Value = serde_json::from_str(&req).unwrap();
                writeln!(w, "{}", json!({"id":v["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
                w.flush().unwrap();
                let _ = rx.recv_timeout(Duration::from_secs(12));
            });
            let mut c = Command::new("/bin/sh")
                .arg("-c")
                .arg("cat >/dev/null; exec sleep 40")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let stdin = c.stdin.take();
            let shared = SharedChild::new(c);
            let sink = Arc::new(TestSink::default());
            let cli = SocketClient::connect_existing_with_sink_and_hooks(
                tmp.to_str().unwrap(),
                Arc::clone(&sink) as Arc<dyn EventSink>,
                Some(SpawnedServe {
                    child: shared.clone(),
                    stdin,
                    stderr_buf: Arc::new(Mutex::new(String::new())),
                    stderr_done: None,
                    stderr_thread: None,
                    initialized: true,
                }),
                None,
            )
            .unwrap();
            cli.inner
                .owner
                .lock()
                .unwrap()
                .in_flight_turn_ids
                .insert("turn_c_only".into(), "thr_c".into());
            let ctrl = DesktopController::new();
            ctrl.set_client_for_test(cli);

            let t0 = Instant::now();
            let CloseDecision::PreventQuitRequested { epoch, request_id } =
                ctrl.handle_close_or_exit_at(&*sink, t0)
            else {
                panic!();
            };
            // confirm_quit-only: NO handle_run_event_exit call!
            assert!(ctrl.confirm_quit_at(epoch, request_id, &*sink, t0).accepted);
            assert!(
                t0.elapsed() <= EXIT_BOUND + Duration::from_millis(500),
                "M-3: confirm_quit-only must finish within EXIT_BOUND"
            );
            assert!(
                shared.is_reaped(),
                "M-3: confirm_quit-only (no later Exit) must stop/kill child within EXIT_BOUND"
            );
            assert_eq!(shared.kill_count(), 1);
            let _ = tx.send(());
            p.join().unwrap();
            let _ = std::fs::remove_file(&tmp);
        });

        h_tl7.join().unwrap();
        h_no_exit_allow.join().unwrap();
        h_no_exit_confirm.join().unwrap();

        // Static guard (M-3): production launcher.rs must NEVER issue raw-pid SIGKILL; all kills
        // must go strictly through SharedChild::kill_once() -> Child::kill().
        let src = include_str!("launcher.rs");
        let tests_start = src.find("#[cfg(test)]\nmod tests").unwrap();
        assert!(
            !src[..tests_start].contains("libc::SIGKILL"),
            "M-3 violation: production launcher.rs must never use raw-pid libc::SIGKILL"
        );
    }

    #[cfg(unix)]
    #[test]
    fn id_length_bounds_and_l6_error_and_reader_relock_phase_l1_l2_l4() {
        // L-1: id length 128 accepted / 129 refused (direct + via validate_rpc_params).
        let id_128 = "a".repeat(128);
        let id_129 = "a".repeat(129);
        assert!(is_valid_id(&id_128), "L-1: 128-char id must be accepted");
        assert!(!is_valid_id(&id_129), "L-1: 129-char id must be refused");
        assert!(validate_rpc_params("thread/start", &json!({ "seatId": id_128 })).is_ok());
        assert!(validate_rpc_params("thread/start", &json!({ "seatId": id_129 })).is_err());

        // L-2: exact L6 string "engine socket closed before response" on leaving Open.
        let sink = TestSink::default();
        for close_kind in ["terminated", "closed"] {
            let mut o = ClientOwner::new(42);
            o.phase = LifecyclePhase::Open;
            let (tx, rx) = mpsc::sync_channel::<Result<Value, String>>(1);
            o.pending.insert(
                7,
                PendingRpc {
                    method: "room/inspect".to_string(),
                    params: json!({}),
                    thread_id: None,
                    reply_tx: tx,
                },
            );
            if close_kind == "terminated" {
                assert!(o.enter_terminated("eof"));
            } else {
                assert!(o.close_to_closed("disconnect", &sink));
            }
            let err = rx
                .recv_timeout(Duration::from_millis(200))
                .expect("waiter must be notified")
                .expect_err("waiter must fail on leaving Open");
            assert_eq!(
                err, "engine socket closed before response",
                "L-2 ({close_kind}): must use exact L6 string"
            );
        }

        // L-4: reader re-checks phase after relocking following validate_rpc_result.
        // Close the owner deterministically inside `on_before_response_relock` and assert the
        // waiter gets exact L6 string (NOT Ok) and guard_count stays 0.
        let tmp = std::env::temp_dir().join(format!("madc-l4-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();
        let (peer_done_tx, peer_done_rx) = mpsc::sync_channel::<()>(1);
        let peer = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut buf = Vec::new();
            let BoundedLine::Line(req1) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v1: Value = serde_json::from_str(&req1).unwrap();
            writeln!(w, "{}", json!({"id":v1["id"],"result":{"protocolVersion":"madc-m1/1","serverInfo":{"name":"madc-engine","version":"0.0.0"}}})).unwrap();
            w.flush().unwrap();

            let BoundedLine::Line(req2) = read_bounded_line(&mut r, &mut buf) else { panic!() };
            let v2: Value = serde_json::from_str(&req2).unwrap();
            writeln!(
                w,
                "{}",
                json!({
                    "id": v2["id"],
                    "result": {
                        "turn": {
                            "id": "turn_l4",
                            "threadId": "thr_l4",
                            "status": "inProgress",
                            "items": [],
                            "error": null,
                            "startedAt": 100,
                            "completedAt": null
                        }
                    }
                })
            )
            .unwrap();
            w.flush().unwrap();
            let _ = peer_done_rx.recv_timeout(Duration::from_secs(5));
        });

        let sink_l4 = Arc::new(TestSink::default());
        let owner_holder: Arc<Mutex<Option<Arc<Mutex<ClientOwner>>>>> = Arc::new(Mutex::new(None));
        let owner_h = Arc::clone(&owner_holder);
        let sink_h = Arc::clone(&sink_l4);
        let hooks = Arc::new(TestStopHooks {
            on_before_response_relock: Some(Arc::new(move || {
                if let Some(o_arc) = owner_h.lock().unwrap().as_ref() {
                    let mut o = o_arc.lock().unwrap();
                    o.close_to_closed("disconnect", &*sink_h);
                }
            })),
            ..Default::default()
        });
        let client = SocketClient::connect_existing_with_sink_and_hooks(
            tmp.to_str().unwrap(),
            Arc::clone(&sink_l4) as Arc<dyn EventSink>,
            None,
            Some(hooks),
        )
        .unwrap();
        *owner_holder.lock().unwrap() = Some(Arc::clone(&client.inner.owner));

        let err = client
            .request(
                "turn/start",
                json!({"threadId":"thr_l4","input":[{"type":"text","text":"hi"}]}),
            )
            .expect_err("L-4: closing between validation and relock must fail waiter, not return Ok");
        assert_eq!(
            err, "engine socket closed before response",
            "L-4: waiter must receive exact L6 error string"
        );
        assert_eq!(
            client.inner.owner.lock().unwrap().guard_count(),
            0,
            "L-4: closed owner must NOT admit turn into guard"
        );

        let _ = peer_done_tx.send(());
        client.disconnect();
        peer.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }
}
