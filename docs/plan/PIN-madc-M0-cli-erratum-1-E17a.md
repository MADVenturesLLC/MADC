# PIN: M0 CLI pin, Erratum 1, clarification E17a (`rejected` only for a well-formed `turn/start` error reply)

*Surface Architect · 2026-09-26 · Venue: `MADVenturesLLC/MADC` · Status: **build pin clarification** (additive) to `PIN-madc-M0-cli-erratum-1.md` §3e E17, for the Hephaestus A7 follow-up. Binding from Founder merge. Docs only.*

**Authority and base files** (all read at `main` @ `677332c24f832527db61d9caa5898e856e522745`, the PR #20 merge):

- `docs/plan/PIN-madc-M0-cli-erratum-1.md` (CLI pin erratum 1, merged via PR #21). `E:n` below means that file at `677332c`. This PR adds one `Amended by` pointer at E:5, so every line from E:5 on moves down by two after this PR; the `E:n` cites here are the `677332c` numbers.
  - §3e E17 (E:358-373): the three recorded states (E:360), the three-state rule and its endings (E:361-367), when the state is read (E:369), "Kept … Dropped: nothing" (E:372) and tests (1)-(5) (E:373).
  - §3b "Well-formed message" (E:123-128): a response has "no own `method` key; exactly one of own `result` and own `error`" (E:126).
  - §3b rule 4 N2 (E:136) and N4 (E:138), rules 5 and 6 (E:145-146), and the N2 and N4 tests (E:156, E:158).
- `packages/engine/src/client.ts` and `packages/cli/src/oneshot.ts`, read at `677332c`. Every file under `packages/` is byte-identical at `343da29` and `677332c` (`git diff --stat 343da29 677332c -- packages` is empty), so erratum 1's code cites (made at `343da29`) hold unchanged.
- `docs/plan/README.md` edit rule (lines 3-10 at `677332c`): an accepted or frozen file is "never edited, except for one added `Amended by <file>` pointer line directly under the status line" (lines 5-6), and "Amendments are new files that name the base file" (line 9).
- Finding: Argus pre-check of the A7 follow-up at Hephaestus's local commit `71b40f0` (`/workspace/madc-reviews/precheck-a7-followup-71b40f0.md`, **H2**, Low): E17 records `rejected` for any `EngineRpcError` (`packages/cli/src/oneshot.ts:638-645` at `71b40f0`, the test at `:643`). Argus's probes show `NOT STARTED` and `no turn was started` for an N2 and an N4 reply on the pending id, even when the N4 reply carries a started turn.
- Ruling: Surface, PR Issues room, 2026-09-26 08:21 AM Nassau (room timestamp).

## 1. What was unclear

E17 records `rejected` "only when the reason is `EngineRpcError` (`client.ts:127`), that is, a well-formed error reply" (E:360). The two are not the same. The client matches a reply to a pending request by its `id` alone, whatever else the message carries (`client.ts:123-126`), and builds an `EngineRpcError` whenever the message has an own `error` key (`client.ts:127`). So an `EngineRpcError` also comes from two messages that §3b calls malformed:

- **N2** (E:136): the message has both an `id` and a `method`, for example `{"id":<its id>,"method":"x","error":{…}}`. E:136 already notes "the client settles that request anyway, whatever `method` says (`client.ts:124-128`)".
- **N4** (E:138): the message has both `result` and `error`. E:138 already notes "the client lets `error` win, `client.ts:127`".

E17's own reason for recording nothing on `EngineProtocolError` applies here too: a malformed message "can arrive alongside a real result", so reading it as "not started" would be false evidence under CLI:16 (E:360; CLI:16 at `343da29`, line 18 at `677332c`).

## 2. Clarification (additive)

1. **`rejected` means a well-formed error reply.** E17 records `rejected` (receipt `turn     NOT STARTED`, session reason `no turn was started`, E:367) **only when the `turn/start` response message itself is a well-formed error reply** by §3b's definition (E:126): a response with an own `id`, no own `method`, an own `error` that passes `isErrorBody` (`oneshot.ts:118-122`), and no own `result`.
2. **An N2 or N4 reply records nothing.** If the message that settled `turn/start` breaks N2 (it carries both an `id` and a `method`, E:136) or N4 (it carries both `result` and `error`, E:138), nothing is recorded. The state stays **pending** (E:360, E:367):
   - JSON `turn` is `null`;
   - the receipt's `turn` line reads `turn     UNKNOWN`;
   - the session line reads `UNVERIFIED: turn unknown (turn/start sent, no answer)`;
   - the exit and the message follow the N rule: exit 3 (E:135), with the N2 message `protocol violation: engine message with both id and method` (E:136) or the N4 message `protocol violation: malformed engine message` (E:138), through the live check or the post-close re-check (E:145-146), which override the reply's classified exit (E:146; the N2 test at E:156 and the N4 test at E:158 already expect "exit 3, not 4").
   A value is never recorded from such a message either. The client rejects the request and never resolves it (`client.ts:127-128`), so a valid turn inside an N4 message's `result` stays unused.
3. **A malformed message elsewhere in the run does not change a well-formed refusal.** Only the message that settled `turn/start` is judged. A bad item, delta or notification, or an N2–N4 frame that did not settle `turn/start`, leaves a well-formed refusal recorded as `rejected`. E17 test (5) (a bad item, then a well-formed refusal in one write → `turn     NOT STARTED`, E:373) stays as written.
4. **How the CLI finds the settling message without the request id.** E17 keeps the request id private (E:360). The client pushes every object to `client.messages` before it settles anything (`client.ts:122` before `:127`), so the settling message is in the log by the time the catch reads the state (E:369). In the catch, when the recorded state is `rejected`, the CLI scans the entries added to `client.messages` since `turn/start` was sent: from the log length read directly before `c.request("turn/start", …)` (`oneshot.ts:385` at `343da29`; `:629` at `71b40f0`) to the end of the log at that moment. It treats the state as **pending** if any of those entries has all three of:
   - an own `id`;
   - an own `error` that passes `isErrorBody`, with the same `code` and `message` as the `EngineRpcError` (`client.ts:28-33` copies both from the body);
   - an N2 or N4 hit (E:136, E:138).
   Otherwise `rejected` stands. It is all read once, in the catch, like the rest of the state (E:369).

   **Residual (named, not closed).** A well-formed refusal can arrive in the same window as a *separate* N2 or N4 frame that carries an own `id` and an error with the same `code` and `message`, for example a duplicate reply. Then the receipt shows `UNKNOWN`, not `NOT STARTED`. The exit is 3 either way, from that frame (E:146). `UNKNOWN` is never false (E:370), so this is accepted.

**Kept:**
- E17's **value** path (E:367).
- The **rejected** and **pending** states and their JSON, receipt and session-line text (E:360, E:367).
- `rejected` for every well-formed error reply.
- "Nothing recorded" for `EngineProtocolError` and `EngineExitedError` (E:360).
- The single read in the catch (E:369).
- Tests (1)-(5) and their mutations (E:373).
- Every exit and message in E17 (E:362-366) and in §3b (E:135-138).

**Dropped:** nothing.

## 3. Tests (added to E17's list, Node **and** Bun)

The fake echoes the id of the request it answers (E:150).

- **(6)** While `turn/start` is pending: `{"id":<its id>,"method":"x","error":{"code":-32008,"message":"m"}}` → exit **3**, receipt `turn     UNKNOWN`. This is the same line as the N2 pending-id test (E:156 (b)), which fixes only the exit; (6) adds the receipt.
- **(7)** While `turn/start` is pending: `{"id":<its id>,"result":{"turn":<valid>},"error":{"code":-32008,"message":"m"}}`, where `<valid>` passes the result checks (`oneshot.ts:389-403` at `343da29`) → exit **3**, receipt `turn     UNKNOWN`. The N4 test at E:158 uses `"result":{}`; (7) uses a started turn, which is Argus's H2 probe case.
- **(8)** While `turn/start` is pending: an N2 frame that does not settle it, `{"id":99,"method":"server/ask"}`, then a well-formed refusal `{"id":<its id>,"error":{"code":-32008,"message":"m"}}` in one write → exit **3**, receipt `turn     NOT STARTED`. This pins rule 3 for an N2–N4 frame, which test (5) does not cover.

*Mutation:* record `rejected` for any `EngineRpcError` (E17 as built at `71b40f0`, `oneshot.ts:643`). Tests (6) and (7) kill it; they then show `NOT STARTED`. Test (5) stays green under the fix and under the mutation. *Second mutation:* treat the state as pending whenever the run saw any N2–N4 frame. Test (8) kills it (it then shows `UNKNOWN`).

*End of clarification E17a.*
