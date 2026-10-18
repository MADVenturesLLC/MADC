# PIN (proposed): M2 Founder Decision Inbox: `decision/raise`, `decision/list`, `decision/resolve`, `founderDecision.resolved`, and closed key sets (D-439)

*Builder-drafted under the Founder's M2-A6 execution commission · 2026-10-14 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Completes P-M2-3's decision-inbox slice (M2 build plan §7 M2-A6, §9 P-M2-3) and closes the key sets of `founderDecision` and each `EvidenceRef` variant (D-439). For Surface and Argus review (`docs/policy/CODE-ADVISORIES.md`).*

*Base: `main` @ `7ef9d41785844235ffe97949e57a502830166d64` (the M2-A4 merge, PR #61). Every file cited below was read at that commit.*

**What this pin does.** It fixes the protocol and session-chain surface for the M2-A6 Founder Decision Inbox:

1. **Closed key sets on `founderDecision` and `EvidenceRef` (D-439):** the write side and read verifier refuse any key outside the pinned §2.3 / §3 sets before redaction, hashing or I/O (`-32010`), never echoing the caller key.
2. **Append-only resolution record (`founderDecision.resolved`):** records the Founder's resolution of an earlier `founderDecision` in the same session file, citing `decisionId`, `decisionSeq` and `decisionHash`, with `outcome` (`"accepted-default"` or `"decided"`) and `resolution` text.
3. **Protocol methods (`decision/raise`, `decision/list`, `decision/resolve`):** typed raise on a loaded thread, read-only open-decision scan across verified session files in `$MADC_HOME/sessions`, and Founder resolution under the thread lock.
4. **CLI surface (`madc decisions ls [--json]`):** renders open decisions across threads in human table or single-line JSON envelope form.

---

## 1. Ground rules

1. **A new dated file.** No M1 or M2 pin is edited in place. `docs/plan/PIN-madc-M1-protocol-messages.md` gains one `Amended by` pointer under its status line, and `docs/plan/README.md` indexes this pin.
2. **Evidence or nothing (evidence pin §2.3).** A `founderDecision` is raised only through the typed `decision/raise` method (or `SessionWriter.append("founderDecision", ...)`), never inferred from free-text prose or `agentMessage` items.
3. **Closed key sets before redaction, hashing or I/O (D-439).** `founderDecision`, each `EvidenceRef` variant, and `founderDecision.resolved` reject any extra key (`value !== undefined`) with `-32010` before redaction, hashing or I/O. The extra key is never echoed in `issues`.
4. **Append-only resolution by the Founder alone (Constitution §1, §5).** Resolving a decision never rewrites the `founderDecision` line; it appends a `founderDecision.resolved` event under the thread lock. Agents (`TurnSink`) have no resolution capability, and `decision/resolve` refuses while a turn is active on the thread (`-32004`).
5. **No payload text in findings, errors or `detail` (plan rule 8).** Refusal issues and doctor findings name field names, seqs, ids and files — never `question`, `recommendedDefault`, `resolution` or caller-chosen keys.

## 2. Closed key sets on `founderDecision` and `EvidenceRef` (D-439)

| Shape | Allowed keys | Extra-key refusal (`-32010`) |
| --- | --- | --- |
| `founderDecision` payload | `decisionId`, `turnId`, `question`, `recommendedDefault`, `evidenceRefs` | `reason: "field-invalid"`, `issue: "founderDecision has a key outside decisionId, turnId, question, recommendedDefault and evidenceRefs"` |
| `EvidenceRef` (`kind: "session"` or `"servedModel"`) | `kind`, `path`, `seq`, `hash` | `reason: "evidence-ref-invalid"`, `issue: "<where> has a key outside kind, path, seq and hash"` |
| `EvidenceRef` (`kind: "git"`) | `kind`, `sha`, `remote` | `reason: "evidence-ref-invalid"`, `issue: "<where> has a key outside kind, sha and remote"` |

On the read side (`v2LineIssue` / `verifySessionText` / `rebuildSession` / `inspectSessionV2`), `checkV2Payload("founderDecision", payload)` enforces the same closed key sets, so a hand-crafted line with an extra key fails verification as `"malformed founderDecision payload"`.

## 3. The resolution record (`founderDecision.resolved`)

```ts
export type FounderDecisionResolutionOutcome = "accepted-default" | "decided";

export type FounderDecisionResolvedPayload = {
  decisionId: string;                     // id grammar; names an open founderDecision in this file
  decisionSeq: number;                    // non-negative integer; equals that founderDecision line's seq
  decisionHash: string;                   // 64 lowercase hex; equals that founderDecision line's hash
  outcome: FounderDecisionResolutionOutcome;
  resolution: string;                     // non-empty after trim; redacted before hashing
};
```

- **Write-time rule (evidence pin rule 1.5).** Checked before redaction, hashing or I/O (`type: "founderDecision.resolved"`, `turnId: null`):

  | Fault | `reason` | issue |
  | --- | --- | --- |
  | missing required field | `field-missing` | `<field> is required` |
  | invalid field type / id / seq / hash / outcome / empty resolution | `field-invalid` | `<field> must …` |
  | key outside the five allowed keys | `field-invalid` | `founderDecision.resolved has a key outside decisionId, decisionSeq, decisionHash, outcome and resolution` |
  | `decisionId` names no `founderDecision` in this file | `field-invalid` | `decisionId has no founderDecision in this file` |
  | `decisionId` is already resolved in this file | `field-invalid` | `decisionId already has a founderDecision.resolved in this file` |
  | `decisionSeq` differs from the `founderDecision` line's `seq` | `field-invalid` | `decisionSeq differs from the founderDecision line` |
  | `decisionHash` differs from the `founderDecision` line's `hash` | `field-invalid` | `decisionHash differs from the founderDecision line` |
  | `outcome === "accepted-default"` and `resolution` differs from the `founderDecision` line's `recommendedDefault` | `field-invalid` | `resolution differs from the founderDecision recommendedDefault` |

- **Redaction.** `decisionId`, `decisionSeq`, `decisionHash` and `outcome` are structural (rewriting any of them refuses `-32010 field-invalid` before the append). `resolution` is free text and is redacted before hashing.
- **Doctor (`inspectSessionV2`).** Gains `decision-resolution-mismatch` (`level: "fail"`): reported when a `founderDecision.resolved` in a verified chain names a `decisionId` with no prior `founderDecision`, re-resolves an already-resolved `decisionId`, or carries a `decisionSeq` or `decisionHash` that differs from the `founderDecision` line, or when `outcome === "accepted-default"` and `resolution` differs from that line's `recommendedDefault`.

## 4. Protocol methods & executing-seat raise capability (`protocolVersion` stays `madc-m1/1`, D-M2-7)

### 4.1 `decision/raise` and mid-turn `TurnSink.raiseDecision` / `ProviderTurnRequest.raiseDecision`

- **Client RPC params (`DecisionRaiseParams`):**
  ```ts
  {
    threadId: string;
    turnId: string;
    decisionId?: string;        // optional; engine mints dec_<32 hex> when omitted
    question: string;
    recommendedDefault: string;
    evidenceRefs: EvidenceRef[];
  }
  ```
- **Mid-turn executing-seat capability (`TurnSink.raiseDecision`, `ProviderTurnRequest.raiseDecision`, and direct-lane native `pi-ai` tool `founder_decision_raise`, F2):**
  - During an active turn, the engine exposes `sink.raiseDecision(input)` on `TurnSink` and forwards it onto `ProviderTurnRequest.raiseDecision` in `createProviderAgent`.
  - The shipped generic direct-lane adapter (`createDirectKeyPort` in `packages/adapters/src/direct/generic.ts`) advertises exactly one bounded native `pi-ai` tool, `founder_decision_raise` (`FOUNDER_DECISION_RAISE_TOOL`), with required fields `question`, `recommendedDefault`, and `evidenceRefs` and optional `decisionId` (never `threadId`, `turnId`, or `decision/resolve`). When the model emits a native `toolCall` (`stopReason: "toolUse"`), `createDirectKeyPort` invokes `request.raiseDecision(...)`, returns the structured outcome to the model via `pi-ai`'s native `ToolResultMessage` (`role: "toolResult"`, `isError: !outcome.ok`), and continues the turn for up to `MAX_DECISION_TOOL_ROUNDS = 4` rounds. If a model response after `MAX_DECISION_TOOL_ROUNDS` still requests tool calls, `createDirectKeyPort` executes none of them and fails the turn `-32603` with the fixed, payload-free message `"<providerId> decision tool limit reached"` (a plain failure, no quota reason, no `servedModel` receipt); if the turn's signal is already aborted, the abort wins. Decisions appended in earlier rounds remain recorded and open; exhaustion never edits or resolves them.
  - The capability is strictly **raise-only** (never grants `decision/resolve`), binds the active `threadId` and `turnId` from the engine (rejecting any caller- or model-supplied `threadId` or `turnId` with `-32010` under D-439), and preserves every caller-owned key via `Object.fromEntries` (F3) before validating through `checkV2Payload("founderDecision", candidate)` and `record.session.append("founderDecision", payload)`.
  - On a `-32010` validation refusal, the engine records a durable `error` item (`code: -32010`) on the turn, returns `{ ok: false, error }`, and permits the turn to continue. On success, it appends `"founderDecision"` and returns `{ ok: true, decision: { threadId, turnId, decisionId, seq, hash } }`.
  - **Vendor-agent ACP v1 boundary:** ACP v1 `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, etc., `docs/plan/PIN-madc-M1-acp-vendor-harness.md` §3.4) define no typed `founderDecision` update kind, and M4 engine-provided tools are deferred until M4 (`PLAN-madc-M2-build-plan.md` §3). Vendor-agent seats (`claude-code`, `codex`, `grok-build`) therefore remain unmodified and governed by the existing ACP v1 contract without inventing an unsupported ACP method or deriving decisions from free-text prose.
  - **Lane scope of the seat raise (Surface ruling H1, 2026-10-16):** In M2-A6 the seat-reachable raise is delivered on direct lanes only. Plan `PLAN-madc-M2-build-plan.md` :166 ("Seat A raises a decision through the typed raise") is met by a direct-lane seat; it names no lane. Vendor-agent (ACP) seats get no seat-reachable raise in M2: the seat raise for vendor seats is deferred to M4 (engine-provided tools, plan :64) or to an ACP extension pinned then (plan :65 excludes the ACP server from M2). Until then a vendor seat's decision reaches the inbox only through the client `decision/raise` RPC, never from agent text.
  - **Seat tool policy (Surface ruling N2-M, 2026-10-16):** `founder_decision_raise` is an engine capability, not a seat tool. Seat `tools.deny` patterns (`PIN-madc-M1-seat-format.md` §2, `SeatToolsPolicy`) and the M1 "unknown = ask in interactive, deny in headless" rule are not applied to it: MADC has no `tools.deny` pattern matcher, and per-seat tool policy beyond M1 is out of M2 (`PLAN-madc-M2-build-plan.md` :65). The headless lane rules still apply first: a turn the registry or seat refuses (`headless-not-permitted`, D-M1-3) never starts, so the tool is never offered on it. The capability's only effect is one validated `founderDecision` append to the active turn's own session file. When a tool-policy pin defines the pattern grammar (M4 or later), that pin decides whether `tools.deny` can name this capability; until then no seat file can switch it off.
- **Checks (`decision/raise`):**
  1. `params` must be an object with a valid `threadId` (`-32602` otherwise).
  2. Candidate `founderDecision` payload (constructed via `Object.fromEntries` so own `"__proto__"` keys are preserved and rejected by D-439 closed-key validation, F3) is validated by `checkV2Payload("founderDecision", candidate)` before any lock or thread lookup. Any fault refuses `-32010` (`turnId: null` at this stage, D-399).
  3. The thread must be loaded in this connection, not poisoned/broken, holding its thread lock, have no pending cold confirmation, and pass `#handoffGate`.
  4. Appends `"founderDecision"` through the thread's `SessionWriter`, which enforces `decisionId` uniqueness in the file, `turnId` naming a `turn.start` in the file, same-file `EvidenceRef` resolution against `SessionChainIndex`, and structural redaction safety.
- **Result (`DecisionRaiseResult`):**
  `{ threadId: string, decisionId: string, seq: number, hash: string }`.

### 4.2 `decision/list`

- **Params:** `{}` (any unexpected key, including an own `"__proto__"` property, refuses `-32602` with the fixed sanitized issue `"decision/list takes no params"`, never echoing caller key names or values, F4).
- **Behavior:** Read-only scan (`listOpenDecisions(home)` in `packages/engine/src/decisions.ts`) over `$MADC_HOME/sessions/<threadId>.jsonl`. Only regular files under the confined `sessions/` directory that pass both `verifySessionFile` and `rebuildSession` are read; unverified files are skipped (and logged to stderr) and never contribute a decision. Within each verified chain, a `founderDecision` is open iff no valid `founderDecision.resolved` in that chain cites `{ decisionId, decisionSeq: seq, decisionHash: hash }`.
- **Result (`DecisionListResult`):**
  `{ data: OpenDecisionSummary[] }`, sorted deterministically by `(ts, threadId, seq)`, where each `OpenDecisionSummary` carries only:
  `{ threadId, seatId, seq, hash, ts, decisionId, turnId, question, recommendedDefault, evidenceRefs }`.

### 4.3 `decision/resolve`

- **Params (`DecisionResolveParams`):**
  ```ts
  {
    threadId: string;
    decisionId: string;
    decisionSeq: number;
    decisionHash: string;
    outcome: "accepted-default" | "decided";
    resolution?: string;        // required for "decided"; defaults to recommendedDefault for "accepted-default"
  }
  ```
- **Checks:**
  1. `params` must be an object with a valid `threadId` (`-32602` otherwise).
  2. Candidate `founderDecision.resolved` payload (constructed via `Object.fromEntries` to preserve own `"__proto__"` properties, F3) is shape-checked before any lock or disk write (`-32010` on any missing/invalid field or extra key).
  3. If `threadId` is loaded on this connection, verifies lock ownership, no active/confirming turn (`-32004`), writer usability (`-32009`), and `#handoffGate`. If `threadId` is not yet loaded on this connection, acquires the thread lock (`-32004` if held by another live process) and opens/verifies the cold thread via `#openColdThread` (`-32002` if missing) **without** writing dangling-turn recovery records yet (F5).
  4. When `outcome === "accepted-default"` and `resolution` was omitted, fills `resolution` from the indexed `founderDecision`'s `recommendedDefault`. Validates the candidate resolution against the verified chain index and redactor via `SessionWriter.validateCandidate("founderDecision.resolved", resolvedPayload)` **before** any cold recovery write or terminal prompt (`-32010` if `decisionId` is unknown, already resolved, `decisionSeq` / `decisionHash` mismatches, or `resolution` mismatches `recommendedDefault`, leaving a cold session file byte-for-byte untouched on refusal, F5).
  5. **Fresh engine-owned operator terminal confirmation (F1):** Requires a fresh confirmation on the engine's own controlling terminal (`PresenceTerminal.probe()` + `confirm()`), serialized engine-wide and bound to `threadId`, `decisionId`, `outcome`, and `resolution`. Embedded engines without an explicit `terminal` and with `input !== process.stdin` default to `ABSENT_TERMINAL` (fail-closed). Refuses `-32010` with zero disk writes if the controlling terminal is unavailable, changed during the prompt, declined, or cancelled/interrupted.
  6. Only after confirmation succeeds and post-confirmation revalidation passes does a cold thread append any dangling-turn recovery records (`#recoverDanglingTurns`) and register in `#threads`, followed by appending `"founderDecision.resolved"` through the thread's `SessionWriter`.
- **Result (`DecisionResolveResult`):**
  `{ threadId: string, decisionId: string, seq: number, hash: string, outcome: FounderDecisionResolutionOutcome, resolution: string }`.

### 4.4 Amendment to `thread/handoff` step 1 (N-M1)

This pin amends `PIN-madc-M2-handoff-procedure.md` §3 (step 1) additively. Two refusals join rows 4 to 7; every existing row, code and order is unchanged, and each new refusal appends nothing (§3 preamble applies).

| # | Check | Code | `data` |
| --- | --- | --- | --- |
| 4a | the source is not loaded on this connection and this engine holds its lock for a pending cold `decision/resolve` confirmation (before row 4) | `-32004 TurnAlreadyActive` | `{ threadId, activeTurnId: null }` |
| 6a | the source is loaded and holds its lock, and a turn is active on it, or a warm `decision/resolve` confirmation is pending (after row 6, before row 7) | `-32004 TurnAlreadyActive` | `{ threadId, activeTurnId }` (`activeTurnId` is the active turn's id, or `null` while confirming) |

Reason: a handoff must not append `handoff.out` to a source whose turn is running or whose Founder resolution prompt is open.

## 5. CLI surface (`madc decisions ls` and `madc decisions ls --json`)

- `madc decisions ls` calls `decision/list` through `callEngineOnce`, validates the response with `parseDecisionList`, and prints a control-stripped human table (`DECISION`, `THREAD`, `SEAT`, `TURN`, `SEQ`, `REFS`, `DEFAULT`, `QUESTION`).
- `madc decisions ls --json` emits the single-line JSON envelope:
  `{ ok, exitCode, madcVersion, protocolVersion, home, decisions, error }`.

*End of proposed M2 Founder Decision Inbox pin.*
