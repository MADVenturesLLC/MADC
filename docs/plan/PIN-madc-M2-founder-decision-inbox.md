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

## 4. Protocol methods (`protocolVersion` stays `madc-m1/1`, D-M2-7)

### 4.1 `decision/raise`

- **Params (`DecisionRaiseParams`):**
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
- **Checks:**
  1. `params` must be an object with a valid `threadId` (`-32602` otherwise).
  2. Candidate `founderDecision` payload (all keys of `params` except `threadId`, with `decisionId` minted when omitted) is validated by `checkV2Payload("founderDecision", candidate)` before any lock or thread lookup. Any fault refuses `-32010` (`turnId: null` at this stage, D-399).
  3. The thread must be loaded in this connection, not poisoned/broken, holding its thread lock, and passing `#handoffGate`.
  4. Appends `"founderDecision"` through the thread's `SessionWriter`, which enforces `decisionId` uniqueness in the file, `turnId` naming a `turn.start` in the file, same-file `EvidenceRef` resolution against `SessionChainIndex`, and structural redaction safety.
- **Result (`DecisionRaiseResult`):**
  `{ threadId: string, decisionId: string, seq: number, hash: string }`.

### 4.2 `decision/list`

- **Params:** `{}` (any unexpected key refuses `-32602`).
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
  2. Candidate `founderDecision.resolved` payload is shape-checked before any lock or disk write (`-32010` on any missing/invalid field or extra key).
  3. If `threadId` is loaded on this connection, verifies lock ownership, no active/confirming turn (`-32004`), writer usability (`-32009`), and `#handoffGate`. If `threadId` is not yet loaded on this connection, acquires the thread lock (`-32004` if held by another live process) and loads the thread through `#loadColdThread` (`-32002` if missing).
  4. When `outcome === "accepted-default"` and `resolution` was omitted, fills `resolution` from the indexed `founderDecision`'s `recommendedDefault`. Appends `"founderDecision.resolved"` through the thread's `SessionWriter` (`-32010` if `decisionId` is unknown, already resolved, `decisionSeq` / `decisionHash` mismatches, or `resolution` mismatches `recommendedDefault`).
- **Result (`DecisionResolveResult`):**
  `{ threadId: string, decisionId: string, seq: number, hash: string, outcome: FounderDecisionResolutionOutcome, resolution: string }`.

## 5. CLI surface (`madc decisions ls` and `madc decisions ls --json`)

- `madc decisions ls` calls `decision/list` through `callEngineOnce`, validates the response with `parseDecisionList`, and prints a control-stripped human table (`DECISION`, `THREAD`, `SEAT`, `TURN`, `SEQ`, `REFS`, `DEFAULT`, `QUESTION`).
- `madc decisions ls --json` emits the single-line JSON envelope:
  `{ ok, exitCode, madcVersion, protocolVersion, home, decisions, error }`.

*End of proposed M2 Founder Decision Inbox pin.*
