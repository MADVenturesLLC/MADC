# PIN (proposed): M2 brief delivery: a handoff target's first `turn/start` serves the source's brief once, under a recorded served marker

*Builder-drafted (Hephaestus) under the Founder's M2-A4 execution commission, revision 2, issued 2026-10-06 · 2026-10-06 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. P-M2-3's brief-delivery slice only (M2 build plan §9). It changes what `turn/start` does on a handoff target that has not served its brief, and adds one field to that target's first `turn.start` line. Nothing else. For Surface and Argus review (`docs/policy/CODE-ADVISORIES.md`).*

*Base: `main` @ `97d17d76ed7f245b4ef51a8bdcc54d978f61de94` (tree `ce776d46f9c7d0f9a34dbbdc2fe441e83ce64846`, the M2-A3 merge, PR #60). Every file cited below was read at that commit. This text is the builder's. It is not Surface's wording and claims no Surface authority.*

**What this pin does.** It fixes D-M2-3's recommended default as the delivery rule: the target's next `turn/start` carries the brief as its opening context, once. The engine reads the brief from the source's `handoff.out`, where it is already hash-pinned and redacted. The target's first `turn.start` records a served marker that cites that line, so the brief is served once and a restart cannot serve it again.

**What it does not do.** The engine starts no turn. `thread/handoff`, the source file, the handoff gate's rows, the allowlist, `thread/list`, the protocol methods, params, results, notifications, item kinds and error codes are unchanged. No worktree is created (M2-A5). No decision is raised (M2-A6).

**Authority** (SHA-256 at the base):

| Path | SHA-256 | Role |
| --- | --- | --- |
| The Founder's M2-A4 execution commission, revision 2 (outside this repo) | `e50c00d043d9bc6be6880a4e039b297fed670695b40f46f4d3a657d9c9361d61` | Rulings B1–B8, scope (Part C), acceptance (Part D), stop conditions (Part F) |
| `docs/plan/PLAN-madc-M2-build-plan.md` | `42579eca40a494dfba9d7592450c72f78c31953e6ad4f0e017fad46f0601b587` | Accepted plan: §6 rules 2, 3 and 8, §7 M2-A4, §9 P-M2-3, §10 bullet 3, §12 D-M2-3 and D-M2-7 |
| `docs/plan/PIN-madc-M2-evidence-schema-v2.md` | `75d6eb47b3d441bed7f58d23806795fd8ee06821370e2401689e6fdad0e53ffa` | §2.1 ("`brief` … becomes the target's first user input"; step 4 "Only now may the target serve a turn"; (b) and (c)), rules 1.3–1.6, §5. **Frozen; not edited** |
| `docs/plan/PIN-madc-M2-handoff-procedure.md` | `8ea585084a0973ccc6b4e5243a247473c84f6faed67af1fad18caf447c39ffa7` | §4 "What a target looks like afterwards", §6 "Serving the brief" (the non-goal this pin takes up). **Frozen; not edited** |
| `docs/plan/PIN-madc-M2-handoff-procedure-amendment-1.md` | `72dd065eaf775980ff40916a5a3a178b608c57045c20030773650e0d4f010194` | Unchanged by this pin |
| `docs/plan/PIN-madc-M2-seat-handoff-allowlist.md` | `5b1d9d76cae92d525920fbb99ca3fb43c1b21e92f25666f67ae32329c869316a` | The legal link a target serves on. Unchanged by this pin |
| `docs/plan/PIN-madc-M1-protocol-messages.md` | `6c6eb179e15c9f481e1185c27565ccc5876fbe734fe982ce532673d21b75e88f` | The base protocol pin: §3.3 `turn/start`, §5 `UserMessageItem`, `preview` and `ServedModelItem`, §7 `protocolVersion`. **Frozen**; gains one `Amended by` pointer line, which changes its SHA-256 |
| `docs/plan/PIN-madc-M1-seat-format.md` | `5b802ce68fa93adf80c3cdbb1f8b668ef0965a16b13253516e26c40cd35c4660` | §4.2 `turn.start` payload and redaction. **Frozen; not edited** |

---

## 1. Ground rules

1. **A new dated file.** No M1 or M2 pin is edited in place. The base protocol pin gains one `Amended by` pointer under its status line (README edit rule).
2. **No turn starts inside a procedure** (plan rule 2, D-M2-3). The brief rides the target client's own `turn/start`. The engine never starts a turn, and `thread/handoff` still starts none.
3. **The source is read, never written** (plan rule 3). The target's turn reads the source file through the read-only, confined chain verifier and appends nothing to it. The source's chain records nothing about the target's turn.
4. **Nothing is written on refusal.** Every refusal below leaves the target file's size, SHA-256 and next seq unchanged and its writer usable, and touches no source byte.
5. **No payload text in findings, errors or `detail`** (plan rule 8). Refusal issues and findings name seqs, ids and files. They never carry the brief.

## 2. The delivery rule (D-M2-3's recommended default)

A thread is a **handoff target** when its `session.open.handoff` is not null. A target is **unserved** while its own file holds no `turn.start`. Its first `turn.start` serves the brief and carries the served marker (§3), so from that line on the target is **served**.

On `turn/start` for an unserved target, the engine:

1. runs every existing check up to and including the two-way link gate, unchanged;
2. reads the brief: it opens the source file named by `handoff.sourceThreadId` through the verifier, re-checks evidence pin §2.1 (b) and (c) **on that same read**, and takes `brief` from the `handoff.out` line at `sourceSeq` whose hash is `sourceHash` (H). It never takes the brief from the request, from the `thread/handoff` call that wrote it, or from any copy held in memory, so the text served is exactly the text H covers: the brief as redacted on disk (evidence pin rule 1.4);
3. runs the presence phase, the repo gate and preflight, unchanged, with the brief already in the turn's input (§4);
4. appends `turn.start` with the served marker, as one ordinary batch: validated, redacted, hashed, fsynced, under the one writer. The marker and the turn are one line, durable together or not at all;
5. runs the turn.

Every other `turn/start` is unchanged: a thread that is not a target, a served target, and a target whose first `turn.start` was written without a marker (§5).

**The refusal.** If step 2's re-check fails (the source cannot be read or does not verify, no `handoff.link` yet, a recorded `handoff.aborted`, or a line that differs), the request is refused exactly as the gate refuses:

| Check | Code | `data` |
| --- | --- | --- |
| §2.1 (b) and (c) do not hold on the read the brief is taken from | `-32010 EvidenceInvalid` | `{ threadId, turnId: null, type: "session.open", reason: "handoff-one-way", issues }` |

Nothing is appended and the agent is not called. The gate's cached result never serves a brief: a target whose gate passed on an earlier `turn/start` that was then refused (for example by preflight) re-checks its link when the brief is read.

Notes:

- **"Served" is the durable `turn.start`.** The turn's outcome (completed, failed, interrupted, or an engine that died before `turn.end`) does not make the target unserved again, so no later turn re-delivers, after a restart included. Re-delivery is not pinned. An act that wants it needs its own recorded cause (plan §7 M2-A4, forbidden).
- **A refused `turn/start` serves nothing.** A refusal after step 2 (presence, repo gate, preflight) appends no `turn.start`, so the target stays unserved and its next `turn/start` reads the brief again. A repo-gated lane's `repo.decision` line may be appended before preflight, as M1-A4 pins. It carries no brief.
- **Why "no `turn.start`" and not "no marker".** For every file this pin's engine writes, the two are the same: the writer accepts a marker only on a target's first `turn.start` (§3), and the engine always puts one there. Gating on the `turn.start` also keeps a file with a malformed or hand-written marker from ever being served again.

## 3. The served marker

```ts
// turn.start.payload gains, on a handoff target's FIRST turn.start only:
briefServed?: {
  handoffId: string;   // equals session.open.handoff.handoffId
  sourceSeq: number;   // equals session.open.handoff.sourceSeq: the source handoff.out line
  sourceHash: string;  // equals session.open.handoff.sourceHash: that line's hash (H), 64 lowercase hex
};
```

- **No brief text.** The marker cites the served line by seq and hash. H covers that line's `brief`, so the marker binds the text served without copying it.
- **Absent elsewhere.** It is absent on every other `turn.start`. It has no `null` form.
- **Write-time rule** (evidence pin rule 1.5). The writer refuses a `turn.start` with `-32010`, appends nothing and stays usable when its `briefServed`:

  | Fault | `reason` | issue |
  | --- | --- | --- |
  | is not an object | `field-invalid` | `briefServed must be an object` |
  | lacks a field | `field-missing` | `briefServed.<field> is required` |
  | has a field of the wrong type, an id outside the grammar, or a hash that is not 64 lowercase hex | `field-invalid` | `briefServed.<field> must …` |
  | has a key outside the three | `field-invalid` | `briefServed has a key outside handoffId, sourceSeq and sourceHash` (the key is never named) |
  | stands in a file whose `session.open` has no handoff link | `field-invalid` | `briefServed stands in a file whose session.open has no handoff link` |
  | stands after an earlier `turn.start` in the same file: **a second delivery** | `field-invalid` | `briefServed stands after an earlier turn.start (the brief is served once)` |
  | differs from `session.open.handoff` in any of the three fields | `field-invalid` | `briefServed differs from session.open.handoff` |

  `data` is the evidence pin §5 shape, `type: "turn.start"`. Issues name fields, never values.
- **Redaction.** The marker's three fields are structural: a redaction that would rewrite one refuses the line before the append (the existing structural-field rule, Copilot 4160774703 on #46). `inputText` stays free text.
- **Hash inputs.** The marker is part of the `turn.start` payload. The envelope stays `v: 1` and the hash formula is unchanged (D-M2-A0-6).
- **Read side.** The chain verifier and `rebuildSession` treat `briefServed` as an additive payload field (rule 1.3), so a v1 engine and the M1 shape check tolerate it. Doctor checks it (§5).
- **Known limitation.** The verifier does not shape-check `briefServed`, because it lives in `session-store.ts`, which is outside this act's paths. A hand-written marker that breaks the rule above is therefore a doctor FAIL `integrity`, not a `thread/resume` refusal. The engine never re-delivers on such a file, because the file already holds a `turn.start`.

## 4. The `turn/start` context field

- **No new wire field.** `turn/start` gains no param. Its result, notifications and item kinds are unchanged.
- **Where the brief arrives.** The brief is `input[0]` of the turn context the agent receives (`AgentTurnContext.input`, a `UserInput` text part), ahead of the caller's `input`, which follows unchanged and in order. A provider agent sends a turn's input as one user message, so the brief reaches the model once, first.
- **The `userMessage` item.** The turn's `userMessage` item (protocol pin §5) carries the same parts, so `content[0]` is the brief. That item line is the one place the brief's text appears in the target's file.
- **`inputText`.** `turn.start.inputText` stays what the caller sent (seat pin §4.2), so the brief is not copied into it.
- **`preview`.** A target's `preview` (protocol pin §5: "first user text") is the brief as redacted on disk, live and after a reload alike, because `rebuildSession` reads the first `userMessage` part. `thread/list` carries no handoff or served state. Whether it may is P-M2-4, which is not ruled.
- **The receipt.** The `servedModel` receipt is unchanged and belongs to the target. Its envelope `seatId` is the target's seat, and `backing`, `providerId` and `lane` are the target seat's serving lane. It carries no input text.

## 5. Doctor

`inspectSessionV2`, and through it `madc doctor`'s session row, gains one finding and one check:

| Finding | Level | When |
| --- | --- | --- |
| `brief-unserved` | WARN | A handoff target whose §2.1 (b) and (c) hold, and whose brief has not been served: either its file holds no `turn.start` yet (its next `turn/start` serves it), or its first `turn.start` carries no `briefServed` (an engine before this pin started that turn, so the brief will never be served) |
| `integrity` | FAIL | A `turn.start` whose `briefServed` breaks §3's write-time rule (rule 1.5, read side) |

- `detail` names the handoff id, the source thread and the source seq. It never carries the brief.
- `brief-unserved` is not reported when the link itself does not verify. That target already carries its handoff finding and cannot serve.
- `thread/list` does not report it (P-M2-4).

## 6. `protocolVersion`

It **stays `madc-m1/1`**, additively (D-M2-7: "prefer additive unless a method's semantics change under an existing name").

- No method, param, result, notification, item kind or error code is added or changed.
- `turn/start` behaves as before on every thread except a handoff target that has not served its brief. Such a thread exists only through `thread/handoff`, itself an addition under `madc-m1/1` (handoff pin §2).
- There, the change is one more leading text part in an existing `UserInput` list and `userMessage` item, a shape every `madc-m1/1` client already reads.
- The session-chain change is one additive payload field on the unchanged `v: 1` envelope (D-M2-A0-6).

A version string would enforce nothing a `madc-m1/1` client could act on.

## 7. What this pin does not change

- Starting turns: the engine starts none, in any procedure. The source file is never written by the target's turn.
- `thread/handoff` and its refusal rows, amendment 1, the allowlist, the evidence pin's shapes, the seat schema, the envelope and the hash formula.
- Worktrees (M2-A5, P-M2-5), the decision raise, the closed key set and the decisions read (M2-A6, the rest of P-M2-3), and `thread/list` and `madc room` (P-M2-4, M2-A8).
- The evidence pin, the handoff pin, amendment 1, the allowlist pin and the M1 pins are not edited. The M1 protocol pin gains one pointer line.

## 8. Acceptance (the commission's Part D)

`packages/engine/src/handoff-gate.test.ts`. Each test was run against the base engine (RED) and against one deliberate break of this act's code (RED). The PR body records both runs.

| Part D row | Test | Evidence |
| --- | --- | --- |
| 1. One mock turn whose opening context contains the brief exactly once | "M2-A4 D1/D2/D3/D6: …" | The target's model call is `<brief>\nfirst`, with one occurrence. The `userMessage` is `[brief, "first"]`, and the brief's text is in the target file once |
| 2. The brief in no later turn | the same test | The second call is `second`. After a restart, a new engine's call is `third`. Neither `turn.start` carries `briefServed` |
| 3. The receipt names the target's own seat and lane | the same test | The target's `servedModel` lines read `prometheus` / `kimi-code` / `allowed-direct`; the source's read `daedalus` / `claude-code` / `allowed-via-vendor-agent` |
| 4. A source turn does not deliver | "M2-A4 D4: …" | The source's later call is `carry on`. Its `turn.start` and `userMessage` carry no brief, while the target's first turn does |
| 5. Delivering twice is refused, nothing appended | "M2-A4 D5: …" | A second marker is refused `-32010 field-invalid` with size, SHA-256 and next seq unchanged and the writer usable. So are the other §3 faults |
| 6. The source byte-identical after the target's turn | "M2-A4 D1/D2/D3/D6: …" | Size and SHA-256 of the source are equal before and after the target's turns, a restarted engine's turn included |
| 7. An unverified or one-way link refuses before serving, no brief in the refusal | "M2-A4 D7/D10: …" | A dropped `handoff.link`, a deleted source, and a source rewritten after a cached gate pass each give `-32010 handoff-one-way` with nothing appended, the agent not run, and no brief in the response or the log |
| 8. Doctor reports an unserved target; `thread/list` does not | "M2-A4 D8/D10: …" | `warn brief-unserved` from `inspectSessionV2` and `inspectMadcHome`, gone once served. `thread/list` rows carry only the six summary keys |
| 9. Existing suites green; no test deleted or weakened | the full suite | typecheck, lint, `test:node`, `bun test`, `git diff --check` (PR body) |
| 10. No brief text in any finding, error or `detail` | rows 1, 7 and 8 above | Every finding `detail`, every error response and every engine log line is checked for the brief |

Also: "M2-A4 pin §3 read side: …" (doctor FAIL `integrity` for a marker that differs, moved or stands on a non-target, and no re-delivery on such a file) and "M2-A4 B1: …" (a secret-shaped brief reaches the model as `[REDACTED]`: it is read from disk, not from the caller or a cache).

## 9. Sources read for this pin

All at `main` @ `97d17d76ed7f245b4ef51a8bdcc54d978f61de94`: `docs/plan/README.md`, `PLAN-madc-M2-build-plan.md`, `PIN-madc-M2-evidence-schema-v2.md`, `PIN-madc-M2-handoff-procedure.md`, `PIN-madc-M2-handoff-procedure-amendment-1.md`, `PIN-madc-M2-seat-handoff-allowlist.md`, `PIN-madc-M1-protocol-messages.md` (§3, §4, §5, §7), `PIN-madc-M1-seat-format.md` (§4), `docs/policy/CODE-ADVISORIES.md`, `AGENTS.md`; `packages/engine/src/server.ts` (`#threadHandoff`, `#handoffGate`, `#loadColdThread`, `#turnStart`, `#beginTurn`, `#turnContext`, `#runTurn`), `handoff.ts`, `session-v2.ts`, `session-store.ts` (`SessionWriter.appendAll`, `v2LineIssue`, `checkPayload`, `rebuildSession`), `inspect.ts`, `agent.ts`, `provider-agent.ts`, and the tests `handoff-gate.test.ts` and `handoff-procedure.test.ts`. No live web source was fetched. No model, vendor or paid call was made.

*End of proposed M2 brief-delivery pin.*
