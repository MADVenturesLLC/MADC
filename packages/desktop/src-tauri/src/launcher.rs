//! M3-A2 launcher for `madc-engine serve` (`docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`
//! §1, §2, §2a, §4, §5, §6).
//!
//! Connects over `$MADC_HOME/engine.sock` on POSIX (Windows named pipe unverified), never embeds
//! any agent loop, tools, or credentials, never auto-retries or respawns on failure, and never
//! removes `$MADC_HOME/engine.lock`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
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
pub const MAX_CWD_BYTES: usize = 4096;
pub const MAX_TURN_INPUT_BYTES: usize = 65_536;

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

#[derive(Debug, Clone, PartialEq)]
pub struct ForwardedNotification {
    pub method: String,
    pub params: Value,
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
        self.stop_with_grace(INITIALIZED_KILL_GRACE, UNINITIALIZED_KILL_GRACE)
    }

    fn stop_with_grace(
        &mut self,
        initialized_grace: Duration,
        uninitialized_grace: Duration,
    ) -> Option<ExitStatus> {
        if self.initialized {
            // Close stdin (EOF) first (§5 & §4 Windows).
            drop(self.stdin.take());
            let deadline = Instant::now() + initialized_grace;
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
            let deadline = Instant::now() + uninitialized_grace;
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
    line_buf: Vec<u8>,
    pub staged_notifications: VecDeque<ForwardedNotification>,
    pub late_reply_count: u64,
    pub discarded_notification_count: u64,
    drop_limiter: DropRateLimiter,
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
    #[cfg(test)]
    pub fn connect_existing_for_test(socket_path: &str) -> Result<Self, String> {
        Self::connect_and_initialize(socket_path, Duration::from_secs(2), true, Instant::now())
    }

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
            line_buf: Vec::new(),
            staged_notifications: VecDeque::new(),
            late_reply_count: 0,
            discarded_notification_count: 0,
            drop_limiter: DropRateLimiter::default(),
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

        let (protocol_version, server_name, server_version) =
            validate_initialize_result(&init_result)?;

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

            match read_bounded_line(&mut self.reader, &mut self.line_buf) {
                BoundedLine::Line(resp_line) => {
                    if resp_line.trim().is_empty() {
                        continue;
                    }
                    match classify_incoming_frame(&resp_line) {
                        FrameClass::ResponseError { id: resp_id, error } => {
                            if resp_id != id {
                                self.late_reply_count += 1;
                                continue;
                            }
                            return Err(format!("engine RPC error: {error}"));
                        }
                        FrameClass::ResponseOk { id: resp_id, result } => {
                            if resp_id != id {
                                self.late_reply_count += 1;
                                continue;
                            }
                            if method != "initialize" && !validate_rpc_result(method, &params, &result) {
                                return Err(format!(
                                    "invalid-frame: {method} result failed closed shape check"
                                ));
                            }
                            return Ok(result);
                        }
                        FrameClass::Notification(verdict) => match verdict {
                            NotificationVerdict::Forwardable { method: m, params: p } => {
                                if self.staged_notifications.len() >= FORWARD_QUEUE_CAPACITY {
                                    return Err("overflow: notification queue full".to_string());
                                }
                                self.staged_notifications
                                    .push_back(ForwardedNotification { method: m, params: p });
                            }
                            NotificationVerdict::Discard => {
                                self.discarded_notification_count += 1;
                            }
                            NotificationVerdict::UnknownNotification => {
                                let _ = self
                                    .drop_limiter
                                    .record_drop("unknown-notification", Instant::now());
                            }
                            NotificationVerdict::InvalidNotification { terminal } => {
                                if terminal {
                                    return Err(
                                        "invalid-frame: malformed turn/completed notification"
                                            .to_string(),
                                    );
                                }
                                let _ = self
                                    .drop_limiter
                                    .record_drop("invalid-notification", Instant::now());
                            }
                        },
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

    pub fn disconnect(mut self) {
        if let Some(mut s) = self.spawned.take() {
            let _ = s.stop();
        }
    }
}

/// Probe `$MADC_HOME/engine.sock` per amendment 1 §2, or spawn `madc-engine serve` per §1, §2, §5.
#[cfg(unix)]
pub fn connect_or_spawn(config: &LaunchConfig) -> Result<SocketClient, String> {
    connect_or_spawn_with_timeouts(config, PROBE_TIMEOUT, START_WINDOW)
}

#[cfg(all(unix, test))]
fn connect_or_spawn_with_window(
    config: &LaunchConfig,
    start_window: Duration,
) -> Result<SocketClient, String> {
    connect_or_spawn_with_timeouts(config, PROBE_TIMEOUT, start_window)
}

#[cfg(unix)]
fn connect_or_spawn_with_timeouts(
    config: &LaunchConfig,
    probe_timeout: Duration,
    start_window: Duration,
) -> Result<SocketClient, String> {
    let started_at = Instant::now();

    // §2: Probe existing listener within 1 s (connect + initialize). If home does not exist yet
    // (Windows absent home, pin line 50), `try_engine_socket_path` returns Ok(None) and we spawn.
    if let Some(socket_path) = try_engine_socket_path(&config.home)? {
        if let Ok(client) =
            SocketClient::connect_and_initialize(&socket_path, probe_timeout, true, started_at)
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
                child,
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
                child,
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
            child,
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
            child,
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
        // Exact 8_388_608 bytes + \n passes.
        let mut exact = vec![b'a'; MAX_LINE_BYTES];
        exact.push(b'\n');
        let mut r_exact = BufReader::new(std::io::Cursor::new(exact));
        let mut buf = Vec::new();
        match read_bounded_line(&mut r_exact, &mut buf) {
            BoundedLine::Line(s) => assert_eq!(s.len(), MAX_LINE_BYTES),
            other => panic!("expected Line for exact 8 MiB, got {other:?}"),
        }
        assert!(buf.capacity() <= MAX_LINE_BYTES + 1);

        // 8_388_609 bytes + \n fails immediately as Oversize.
        let mut over = vec![b'b'; MAX_LINE_BYTES + 1];
        over.push(b'\n');
        let mut r_over = BufReader::new(std::io::Cursor::new(over));
        buf.clear();
        assert_eq!(read_bounded_line(&mut r_over, &mut buf), BoundedLine::Oversize);
        assert!(buf.capacity() <= MAX_LINE_BYTES + 1);

        // Unterminated 64 MiB stream stops near MAX_LINE_BYTES + 1 without reading the rest.
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
            br.get_ref().total_read <= MAX_LINE_BYTES + 1 + 8192,
            "reader consumed too much: {}",
            br.get_ref().total_read
        );
        assert!(
            fresh_buf.capacity() <= MAX_LINE_BYTES + 1,
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

        let mut client = SocketClient::connect_existing_for_test(tmp.to_str().unwrap())
            .expect("connect must succeed with staged notification");
        assert_eq!(client.staged_notifications.len(), 1);
        assert_eq!(client.staged_notifications[0].method, "room/updated");

        let res = client
            .request("seat/list", json!({}))
            .expect("seat/list succeeds");
        assert_eq!(res, json!({"data": []}));
        assert_eq!(client.late_reply_count, 1);
        assert_eq!(client.discarded_notification_count, 1);
        assert_eq!(client.staged_notifications.len(), 2);
        assert_eq!(client.staged_notifications[1].method, "turn/started");

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
        assert_eq!(
            client.staged_notifications.len(),
            3,
            "notification before timeout must NOT be dropped"
        );
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
}
