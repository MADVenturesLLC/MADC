# PIN: M1 Amendment 1: pin the subscription surface, not a model name

*Daedalus · 2026-09-30 · Venue: `MADVenturesLLC/MADC` · Status: **proposed** pin amendment (docs only). Binds the builder act from Founder merge of this file. Until that merge it binds nothing except as a record of the ruling below. No code in this commission.*

*Amends, for the items it names: `docs/plan/PIN-madc-M1-seat-format.md` (§2 schema, §3 seeds, §4.2 `session.open` / `servedModel`) and `docs/plan/PIN-madc-M1-protocol-messages.md` (§4.1 reason union, §5 `requestedModel` / `servedModel`, §3.5 `SeatSummary`). Supersedes, for new seeds only, M1 plan §6's "lock each `pinnedModel`" sentence and M1-A7's "Lock each `pinnedModel` against the pinned catalog or live list." Where this file and those sentences disagree, this file wins. Every other sentence in the base pins stands, including D-M1-3, D-M1-7, headless policy, tool-deny deferral, and the forbidden-lane catalog.*

*Edit rule: `docs/plan/README.md`. The base pins stay frozen. This file is the amendment. The base files gain only an `Amended by` pointer.*

**Read at:** `main` @ `37b28a27d1a43a1195f70bd4b8e55650279fd363` (PR #37, M1-A7). The cited engine and adapter paths are byte-identical on the checkout `hephaestus/m1-a7-seat-roster-v1` @ `9d75eaf` (`git diff 9d75eaf 37b28a2` empty for those paths and for the three base docs). Claim classes are in §9.

---

## 0. Founder ruling (verbatim, 2026-09-30)

> The repo will pin the subscription surface, not a model name. `claude-code`, `codex`, `ollama-cloud`, and `kimi-code` stay. `gpt-5.1-codex`, `claude-sonnet-4-5`, and `ollama-cloud/gpt-oss:120b` do not.
>
> - A seat pins a backing. That backing is the subscription you already have.
> - Any model that backing currently offers is legal. A model from a different subscription is not.
> - If you do not name a model, the surface uses its own default. The repo does not invent one.
> - The receipt still records the model you asked for and the model that actually served.
> - Seeds stop shipping model generations. A seed change does not rewrite a `seats/<id>.json` already on disk.

This ruling is the authority for the items below. It is not re-opened here.

---

## 1. Schema: the seat pin already decides the shape

**Decision (D-SSP-2).** "No model named" is a **version 3** seat file that **omits** the `pinnedModel` key. It is not an empty string, and it is not JSON `null`.

The pin owns this. Seat pin §2 S2 (`PIN-madc-M1-seat-format.md` lines 75 and 89) says `version: 1 | 2` and that version 2 **adds** `displayName` and `fallbacks`. A v1 file loads as v2 in memory and is **never rewritten**. The implementation follows that split: `seat.ts` lines 39–40 and 105–119 keep a version-scoped key set; `validateSeat` (lines 165–189) rejects any version other than 1 or 2 and rejects a missing or blank `pinnedModel`. `serializeSeat` (`seat-store.ts` lines 81–99) emits `displayName` and `fallbacks` only when `version === 2` (`v2DisplayName`, lines 64–65).

That is a closed per-version contract. Making `pinnedModel` optional inside version 2 would change the contract M1-A7 just shipped. S2's own rule for a new contract is a new version number, with older files left on disk.

Omission, rather than `null`, is the seat-file pattern the same pin already uses. `displayName` is absent on a v1 file (pin §2 line 78; `SeatSummary.displayName` is `null` only on the **wire**, protocol `types.ts` lines 216–217). `memory.path` is forbidden when `memory.mode` is `"in-session"` (pin §2 lines 69–71; `seat.ts` lines 220–223). Seat files do not use JSON `null` for "none". Protocol payloads do (`cwd`, `fallbackFrom`, `error`). Those two patterns stay on their own sides of the boundary (§4).

### 1.1 Version 3 contract

```ts
type Seat = {
  id: string;
  version: 1 | 2 | 3;      // 3: pinnedModel may be omitted
  role: string;
  standingInstructions: string;
  displayName?: string;    // required at version 2 and version 3
  pinnedModel?: string;    // required non-empty at 1 and 2; optional at 3
  preferredBacking: SeatBacking;
  fallbacks?: string[];    // required at version 2 and version 3
  memory: SeatMemory;
  tools: SeatToolsPolicy;
  policy: { headlessOk: boolean };
  handoffs: SeatHandoffsStub;
};
```

Rules:

1. Version 1 and version 2 are unchanged. `pinnedModel` remains a required non-empty string after trim. A missing key, `""`, whitespace-only, or JSON `null` still fails load with `-32006`.
2. Version 3 requires every version-2 field (`displayName` non-empty, `fallbacks` an array of registry ids validated like `preferredBacking`).
3. At version 3, `pinnedModel` absent means unnamed. Present, it must be a non-empty string after trim. JSON `null`, `""`, and whitespace-only fail `-32006` with `pinnedModel must be omitted or a non-empty string at version 3`.
4. Unknown keys stay rejected. Version 3's key set is the version-2 key set. It does not add a new key.
5. In memory, `pinnedModel` is `string | null`. `null` only when a version-3 file omitted the key. A version-1 or version-2 load never produces `null`. `version` on the object stays the file's own number, same as S2 keeps `1` on a v1 file.
6. The engine never rewrites a seat file to migrate it. An operator who wants unnamed sets `version` to `3`, supplies `displayName` and `fallbacks` if the file was v1, and deletes the `pinnedModel` key. Deleting the key on a v1 or v2 file still fails load.

`serializeSeat` emits version-3 files with the version-2 key order, and omits `pinnedModel` when the in-memory value is `null`. `v2DisplayName` and the `fallbacks` emission must treat version 3 the same as version 2. A version-3 seed that dropped `displayName` or `fallbacks` because those branches still say `version === 2` would be a broken seed.

---

## 2. Resolver contract

The registry stays the legality boundary. Lane class (`allowed-direct`, `allowed-via-vendor-agent`, `vendor-session`), D-M1-7, and headless permissions are unchanged. This act does not make a model from a different subscription legal. It also does not add a new classifier that inspects a model id and assigns it to a subscription. Shape checks below are the only model gate.

A **named** model is the seat's string, passed only to a lane whose shape check accepts it. A same-lane fallback that cannot resolve that string is skipped, as `provider-agent.ts` lines 320–321 and 365–371 already skip a candidate whose lane cannot resolve `pinnedModel`. An **unnamed** seat (`pinnedModel === null`) does not copy a model id onto the fallback. Each attempted lane uses that lane's unnamed behavior below. D-M1-7 still runs first.

### 2.1 `claude-code`: omit `--model`

Named: unchanged. Trim, refuse blank, pass the trimmed string as `--model` (`claude-code.ts` lines 70–74 and 128–135).

Unnamed: do not put `--model` on the argv. Do not pass `""`, and do not pass the alias `default`. The alias `default` is itself a name. Claude Code's model-config page calls it a special value that clears an override and reverts to the recommended model for the account ([model-config](https://code.claude.com/docs/en/model-config), retrieved 2026-09-30). Sending it would be the repo choosing a token. Omission leaves the binary's own precedence.

What the wire carries when the flag is absent (VERIFIED from vendor docs and the local help text, §9):

- `--model` is optional. Local `claude` 2.1.285 `--help`: `--model <model>` is "Model for the current session." The print-mode example in the CLI reference is `claude -p "query"` with no `--model` ([cli-reference](https://code.claude.com/docs/en/cli-reference), retrieved 2026-09-30).
- Precedence when the flag is present: the flag overrides the `model` setting and `ANTHROPIC_MODEL` (same pages). When the flag is absent, those lower layers stand: `ANTHROPIC_MODEL`, then the settings `model` field, and if neither is set, the account's recommended model. This repo does not record that recommended id. The receipt records whatever `modelUsage` reports (§4).

Served identity stays the first key of `modelUsage` (`claude-code.ts` lines 114–120). If `modelUsage` is missing on an unnamed turn, `servedModel` is JSON `null` and `vendorReported` is `false`. The current fallback `reportedModel(...) ?? request.modelId` (line 222) must not run for an unnamed turn, because there is no requested id to copy.

### 2.2 `codex`: omit `thread/start.model`

Named: unchanged. Trim, refuse blank, send `thread/start.params.model` (`codex.ts` lines 83–87 and 444–445).

Unnamed: omit the `model` key. Do not send `null` and do not send `""`.

What the wire carries when the key is absent:

- VERIFIED on upstream source, not yet on the installed binary's generated schema. `ThreadStartParams.model` is `Option` (`#[ts(optional = nullable)]`) in `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` on GitHub `main` and on commits `914c8eeb`, `f1affbac`, and `27c05a52` (fetched 2026-09-30). The app-server README on `main` says the `model` field is optional and, if not specified, the server uses the user's current config settings (search snippet of `codex-rs/app-server/README.md`, 2026-09-30).
- VERIFIED locally: `codex --version` on this machine is `codex-cli 0.159.1`. `codex app-server --help` lists `generate-json-schema`.
- UNPROVEN: that the installed 0.159.1 schema treats a missing `model` as "use config". Schema generation was not run. The builder confirms omission against that schema, or against a fixture child that accepts a `thread/start` without `model`, before the omit path ships. If that binary **requires** `model`, the builder stops and reports. The builder does not invent a model id to satisfy the schema.

Served identity stays `thread/start` result `model` when it is a non-empty string (`codex.ts` lines 454–455). The initializer `let servedModel = request.modelId` (line 164) must start as `null` on an unnamed turn, then take the reported value if present. No report means `servedModel: null`, `vendorReported: false`.

### 2.3 `kimi-code`: drop the frozen catalog gate; unnamed does not call

Named shape stays `kimi-coding/<id>` with a non-empty `<id>` (`kimi-code.ts` lines 50–62). The provider prefix must still match `kimi-coding`. A bare id, a different provider, or a trailing slash still fails resolve.

**Remove** the membership test at lines 63–68 (`catalogModel(modelId) === undefined` → not in the pi-ai 0.87.1 catalog). That test is the defect: a current Kimi model id that is not in the pinned catalog is rejected before any request. pi-ai stays pinned at `0.87.1` (`PI_AI_VERSION`). The pin of the library is not a pin of the model generation. `KIMI_DEFAULT_PINNED_MODEL` (`kimi-code.ts` line 29, re-exported from `adapters/src/index.ts`) is deleted. It is a shipped generation.

The frozen catalog must not be replaced by a new allowlist. Kimi's own pages, retrieved 2026-09-30, currently list four ids (`k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`) at [Kimi Code overview](https://www.kimi.com/code/docs/en/) and [model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html). Those pages are evidence of what the surface offered that day. They are not a list this repo freezes. The API accepts or rejects the id the operator named.

The generic port still looks the id up in a pi-ai catalog and throws `Unknown <provider> model` when the refresh cannot supply it (`direct/generic.ts` lines 100–143). Kimi has no `refreshProvider`. Removing the resolver gate is not enough: a named id absent from pi-ai 0.87.1 would die one layer later. The builder constructs the request `Model` for an operator-named id from the pinned provider's wire (`anthropic-messages`) and base URL, the same structural idea as `listedModel` in `ollama-cloud.ts` lines 115–128, with **this** id. That construction copies transport facts. It does not choose an id.

**Unnamed.** No documented default exists for this endpoint. State that plainly:

- Both Kimi pages tell the caller to fill in a Model ID. Neither page says what the messages API does when `model` is omitted.
- The `null / undefined → model default` block on the models page is the **reasoning-effort** map (`high` for K3, `max` for K2.8 Preview). It is not a default model id.
- The lane is direct-key HTTP (`createKimiCodePort` → `createDirectKeyPort`), not the Kimi Code CLI. The CLI's `/model` picker is a different surface. This act does not read `~/.kimi` to discover a default, and does not switch the lane onto the `kimi` binary.
- No credentialed probe was sent. The exact HTTP status of a body that omits `model` is UNPROVEN. It is also unnecessary: there is no documented default to send.

Mechanism (D-SSP-4): an unnamed `kimi-code` turn is refused **before any request** with `-32008` `reason: "model-default-undocumented"`. The message names the backing and says the operator must set `pinnedModel` to a model that backing offers. The message contains no model id. The same refusal on a **fallback candidate** is a skip, matching the existing `-32008` skip at `provider-agent.ts` lines 365–371. It is not `quota-or-unreachable`, so it does not start the fallback walk. On the primary, the turn fails with that reason.

Load of a version-3 kimi seat with the key omitted succeeds. The catalog check in `loadSeat` (`seat-store.ts` lines 587–591) runs only when `pinnedModel` is a string, and then only as the shape check. Doctor warns, non-fatally, that a turn will refuse until a model is named (§6).

### 2.4 `ollama-cloud`: already surface-truth when a model is named

Named: unchanged. Shape `ollama-cloud/<id>` (`ollama-cloud.ts` lines 100–112). Membership is still the live `GET /api/tags` list at call time, labeled `listed`, not a hard-coded list (module comment lines 7–9; `refreshProvider` lines 165–176). A named id the live list does not contain still fails at call time as an unknown model.

**Unnamed.** Ollama documents `model` as required and documents no omission default.

- Native chat and generate: "`model`: (required) the model name" ([api.md](https://github.com/ollama/ollama/blob/main/docs/api.md), fetched 2026-09-30).
- OpenAI-compatible examples always send `model` ([openai-compatibility](https://docs.ollama.com/api/openai-compatibility), fetched 2026-09-30). The "Default model names" section on that page is `ollama cp` onto a name such as `gpt-3.5-turbo` so a client that **sends that name** works. It is not a server default for a missing field.
- Cloud examples send a model id ([authentication](https://docs.ollama.com/api/authentication), fetched 2026-09-30).

Picking the first `/api/tags` entry, or any other entry, would be this repo choosing a generation. That is forbidden. Unnamed `ollama-cloud` uses the same `-32008` `model-default-undocumented` refusal as kimi, before `/api/tags` and before any chat request. Headless stays denied (D-M1-3). This act does not flip it.

### 2.5 What "any model that backing currently offers" means after this act

| Backing | Who decides the id is legal |
| --- | --- |
| `claude-code` | The `claude` binary, when a name is sent. When unnamed, the binary's own default path (§2.1). |
| `codex` | The `codex` binary, when a name is sent. When unnamed, the binary's config (§2.2), subject to the builder's schema check. |
| `kimi-code` | The Kimi Code API, when the operator names `kimi-coding/<id>`. The pi-ai 0.87.1 catalog does not decide. Unnamed does not call (§2.3). |
| `ollama-cloud` | The live `/api/tags` list, when the operator names `ollama-cloud/<id>`. Unnamed does not call (§2.4). |

A string that fails the lane's shape check is not sent. `claude-sonnet-4-5` does not match `kimi-coding/<id>` or `ollama-cloud/<id>`, so it cannot ride a direct-key hop. `kimi-coding/k3` does not become a Claude or Codex model by this act.

---

## 3. Receipts: asked and served, including when nothing was asked

Protocol version stays **`madc-m1/1`** (protocol pin P1, line 64). No new method and no new error **code**. The JSONL envelope stays `v: 1` (seat pin §4.1). Two existing fields widen, and the `-32008` reason union gains one string. That is the same kind of union extension P5 already made for `quota-or-unreachable` (protocol pin lines 149–152).

`null` on these protocol fields is the pin's existing "none" token (`cwd: string | null`, `fallbackFrom: string | null`, `error: … | null`). The key is **present**. Omitting the key would violate seat pin §4.2 ("payload fields are the enumerated ones"). Seat files omit the key (§1). Receipts use `null`. The CLI words `(none)` and `(unreported)` are display only and never enter JSONL.

| Field | Named seat | Unnamed seat |
| --- | --- | --- |
| `session.open.payload.pinnedModel` | the seat string, as today | `null` |
| `servedModel.requestedModel` (item and JSONL) | the seat string, as today (`provider-agent.ts` line 441). Still the full seat string, including a `kimi-coding/` or `ollama-cloud/` prefix | `null` |
| `servedModel.servedModel` | vendor report when one exists; otherwise the requested id, with `vendorReported: false` (protocol pin §5 honesty rule, unchanged) | the vendor-reported id when one exists. If the surface reports nothing, `null`. Never a repo-chosen id |
| `vendorReported` | unchanged honesty rule | `true` only when the vendor reported the id that is in `servedModel`. `false` when `servedModel` is `null` |

`seat/list` projection (`types.ts` lines 210–219): `version: 1 | 2 | 3`, `pinnedModel: string | null`. `null` only for a version-3 seat that omitted the key.

CLI receipt line (`oneshot.ts` line 1034), display only:

- named, served known: unchanged ` model    <requested> → <served>   (<backing>)`
- unnamed, served known: ` model    (none) → <served>   (<backing>)`
- unnamed, served unknown: ` model    (none) → (unreported)   (<backing>)`
- no receipt object at all: unchanged ` model    NO RECEIPT`

`oneshot.ts` lines 43 and 139 currently require `requestedModel` to be a string. They accept `null` as the unnamed value and still require `servedModel` to be a string or `null` under the table above.

---

## 4. Seeds

All five roster seats stop shipping a model generation. New seeds are version 3 with `pinnedModel` omitted. Seed-once is unchanged: `seedRosterSeats` writes a file only when `seats/<id>.json` is missing (`roster.ts` lines 141–154; seat pin §1 Seed row and §3). An existing file is never rewritten, including a file that still contains `claude-sonnet-4-5`, `gpt-5.1-codex`, `kimi-coding/kimi-for-coding`, or `ollama-cloud/gpt-oss:120b`. Those strings remain legal pass-through under §2. Operator edits win.

`madc-default` new seeds are version 3, not the M0 v1 document. The M0 pin's embedded JSON stays frozen and is historical. Version 3 requires `displayName` and `fallbacks`, which the v1 seed did not carry. The new `madc-default` seed sets `displayName` to `madc-default` (the id, already the public name) and `fallbacks` to `[]`. Standing instructions stay the M0 sentence. This is the mechanical consequence of §1, not a new role.

Every other seed field (role, standing instructions, backing, fallbacks, tool deny text, `headlessOk`, memory path) stays as `roster.ts` has it on `main` @ `37b28a2`. Comments in `roster.ts` lines 10–12, 32–33, 53, 72, and 91–94 that cite those generations as locks are rewritten to cite this amendment and the 2026-09-30 ruling. They must not still say M1-A7 locked a model id.

**Consequence, stated plainly.** A fresh `$MADC_HOME` will seed `prometheus`, `surface-architect`, and `madc-default` with no model. Those three backings document no default (§2.3, §2.4), so the first turn on each refuses with `model-default-undocumented` until the operator writes a `pinnedModel`. `daedalus` and `hephaestus` omit the model flag and use the vendor binary's default. Putting a generation back into the three direct-key seeds would break the ruling. This plan does not do that.

---

## 5. Doctor and load

- `loadSeat`'s kimi catalog refusal (`seat-store.ts` lines 526–527 and 587–591) becomes a shape check, and only when `pinnedModel` is a string. An unnamed version-3 file does not fail load for lack of a model.
- Doctor adds a **non-fatal** warning on an unnamed seat whose backing is `kimi-code` or `ollama-cloud`: a turn will refuse with `model-default-undocumented` until `pinnedModel` is set. Same severity class as the existing never-eligible-fallback warning (warn, doctor can still exit 0). A hard failure would fail doctor on every fresh home, because the seeds are supposed to omit the model.
- The warning does not list model ids. It may name the registry entry's existing `termsUrl`. It must not paste the four Kimi ids or a `/api/tags` snapshot into the seat as a suggestion.

---

## 6. D-table

| ID | Question | Decision | Who |
| --- | --- | --- | --- |
| D-SSP-1 | What does a seat pin? | A backing (the subscription surface). The four ids in the ruling stay. The three generation strings in the ruling leave the seeds. | Founder, 2026-09-30, §0. Recorded, not re-decided. |
| D-SSP-2 | How does a seat say "no model", and does the file version change? | Version **3**, key **omitted**. v1 and v2 stay required-string and are never rewritten. Explicit `null` is illegal in the seat file. | Seat pin §2 S2, applied here. See §1. |
| D-SSP-3 | What do `claude-code` and `codex` send when unnamed? | Omit `--model`. Omit `thread/start.model`. Do not send `default`, `""`, or `null`. | §2.1, §2.2, vendor docs. Codex installed-schema confirm is a builder gate (§9, UNPROVEN row). |
| D-SSP-4 | What do `kimi-code` and `ollama-cloud` do when unnamed? | No documented default. Refuse before any request, `-32008` `model-default-undocumented`. Do not pick from a catalog or from `/api/tags`. | §2.3, §2.4. |
| D-SSP-5 | Does kimi still require pi-ai 0.87.1 membership? | No. Shape `kimi-coding/<id>` stays. Membership gate deleted. Today's four public ids are not a replacement allowlist. pi-ai stays at 0.87.1 for transport. | Founder ruling (any model that backing offers) plus the defect named in the commission. |
| D-SSP-6 | Receipt when no model was asked? | `requestedModel: null`, `pinnedModel: null` on `session.open`. `servedModel` is the vendor report, or `null` if the vendor reported nothing. `vendorReported` honest. Protocol version stays `madc-m1/1`. | Protocol pin null-for-none, plus the ruling's receipt sentence. §3. |
| D-SSP-7 | Seeds and files already on disk? | New seeds are v3 and omit `pinnedModel`. Existing `seats/<id>.json` is never rewritten. Old generation strings remain valid operator content. | Founder ruling, last bullet, plus seat pin seed-once. |
| D-SSP-8 | Fallback, headless, forbidden lanes, tool deny? | Unchanged. `model-default-undocumented` does not start a fallback walk. | Out of scope, §8. |

---

## 7. Builder act (separate commission)

This file does not authorize implementation. The act that follows implements §1–§5 and nothing in §8.

**Files the act is expected to touch** (verify, then edit; do not treat this list as a reason to edit a frozen pin):

- `packages/engine/src/seat.ts`: version 3, optional `pinnedModel`, validation messages.
- `packages/engine/src/seat-store.ts`: `serializeSeat`, `v2DisplayName`, `loadSeat` kimi check.
- `packages/engine/src/seats/roster.ts`: five seeds, comment rewrite.
- `packages/engine/src/protocol/types.ts`: `ServedModelItem`, `SeatSummary`, session payload types.
- `packages/engine/src/protocol/errors.ts`: add `model-default-undocumented` to the `-32008` reason union. No new code number.
- `packages/engine/src/provider-agent.ts`: unnamed plan, receipt `requestedModel`, fallback skip.
- `packages/adapters/src/claude-code.ts`, `codex.ts`: omit path; resolvers accept a missing model.
- `packages/adapters/src/kimi-code.ts`: delete the catalog gate and `KIMI_DEFAULT_PINNED_MODEL`; build a `Model` for an operator-named id.
- `packages/adapters/src/providers/ollama-cloud.ts`: unnamed refusal at the engine. The named `/api/tags` path stays.
- `packages/adapters/src/index.ts`: drop the deleted export.
- `packages/cli/src/oneshot.ts`: receipt line for `null`.
- Tests and fixtures that assert the old seed bytes or the catalog refusal, including `seat.test.ts`, `testing/fixtures/madc-default.json`, `seats/roster.test.ts`, `kimi-code.test.ts`, `provider.test.ts` (the `kimi-coding/not-a-model` refusal), `cli.test.ts` line 475, `fake-engine.ts` receipt fixtures where an unnamed case is added. Pass-through fixtures may keep a model string. They must not assert that a **seed** equals that string.
- `docs/runbook/M0.md` lines 82–84 and 111–144: stop presenting `claude-sonnet-4-5` and `gpt-5.1-codex` as the way a seat is pinned. Say a v3 seat may omit `pinnedModel`, and a named value is a vendor model name the binary accepts. The frozen M0 pins (`PIN-madc-M0-*.md`) are not edited.

**Acceptance:**

1. Fresh home: five version-3 files, no `pinnedModel` key, second start byte-identical, `doctor --init` uses the same writer.
2. A pre-seeded file containing one of the old generation strings is byte-identical after seeding.
3. v1 and v2 files with a non-empty `pinnedModel` still load. v1 still has no `displayName` or `fallbacks` written back.
4. v3 with the key omitted loads. v3 with `null`, `""`, or whitespace fails `-32006`. v2 with the key missing still fails `-32006`.
5. Claude argv for an unnamed seat has no `--model`. Codex `thread/start` params for an unnamed seat have no `model` key. A named seat still passes the string through, including a string that is not in any list this repo keeps.
6. `resolveKimiPinnedModel("kimi-coding/not-in-pi-ai-0.87.1")` succeeds, and the outbound body uses that id. `anthropic/…`, a bare id, and a mismatched provider still fail. No test freezes `k3` or `kimi-for-coding` as the only legal ids.
7. Unnamed `kimi-code` and unnamed `ollama-cloud` perform zero network calls and return `-32008` `model-default-undocumented`. The message contains no model id.
8. A named ollama id is still checked against the live list at call time (mock `/api/tags` in CI).
9. Receipt fixture: unnamed claude or codex records `requestedModel: null` and the vendor-reported `servedModel` when the fixture reports one, and `servedModel: null` with `vendorReported: false` when it does not.
10. `initialize` still returns `protocolVersion: "madc-m1/1"`.
11. D-M1-7 tests still pass. A `model-default-undocumented` primary does not emit `fallback.rejected` and does not call the next candidate.
12. `rg` over seeds, `KIMI_DEFAULT_PINNED_MODEL`, and `roster.ts` comments finds none of `gpt-5.1-codex`, `claude-sonnet-4-5`, `gpt-oss:120b` as a shipped seed value. Tests may still mention them as operator-file fixtures for the "do not rewrite" case.

**Codex gate inside the act:** confirm installed `codex-cli` schema (or the fixture app-server) accepts `thread/start` without `model`. If it does not, stop. Do not substitute a model id.

**Forbidden:** editing `PIN-madc-M0-*.md`; editing this amendment's base pins beyond the pointer line already added; changing registry status of `zai-glm-coding-plan` or `gemini-antigravity-signin`; bumping pi-ai; adding a GLM or Z.ai adapter; inventing a model id; picking an ollama tag as a default; reading vendor credential files; rewriting any existing `seats/<id>.json`.

---

## 8. Out of scope

- Antigravity sign-in (`gemini-antigravity-signin`, `catalog.ts` line 287, `status: "forbidden"`) and the Z.ai GLM coding plan (`zai-glm-coding-plan`, line 276, `status: "forbidden"`). Their legality is a separate Founder challenge. This amendment does not touch those entries, their quotes, or the forbidden-surface rule.
- Tool deny grammar. `roster.ts` lines 14–19 stand: deny strings are still the §6 clause text, because no matcher consumes them.
- Headless permissions, including D-M1-3 (`ollama-cloud` `headless: "denied"`, `surface-architect` `headlessOk: false`).
- D-M1-7 same-lane fallback. Eligibility is still registry `status` plus `credentialClass`. This act does not add a model-subscription matcher on top.

---

## 9. Claim ledger

| Claim | Class | Source |
| --- | --- | --- |
| `main` is `37b28a2`, M1-A7 PR #37. Checkout `9d75eaf` matches `main` on the cited seat, adapter, provider-agent, seat-store, and the three base docs. | VERIFIED | `git rev-parse main`, `git diff 9d75eaf 37b28a2 -- <paths>` empty, 2026-09-30 |
| `pinnedModel` required non-empty; key order; version only 1 or 2 | VERIFIED | `packages/engine/src/seat.ts` lines 46, 105–119, 188–189 |
| Five seeds carry the generation strings named in the commission, plus `madc-default` at `seat.ts` line 72 | VERIFIED | `packages/engine/src/seats/roster.ts` lines 34, 54, 73, 95; `seat.ts` line 72 |
| Claude and Codex resolvers require a non-empty string and always send it (`--model`, `thread/start.model`) | VERIFIED | `claude-code.ts` lines 70–74, 133–134; `codex.ts` lines 83–87, 444–445 |
| Kimi resolver requires `kimi-coding/<id>` and pi-ai 0.87.1 membership | VERIFIED | `kimi-code.ts` lines 50–68 |
| Ollama resolver checks shape only; live `/api/tags` is membership | VERIFIED | `ollama-cloud.ts` lines 96–112, 165–176 |
| Dispatch skips a candidate that cannot resolve `pinnedModel`; receipt `requestedModel` is `seat.pinnedModel` | VERIFIED | `provider-agent.ts` lines 223, 321, 441 |
| `loadSeat` fails a kimi seat the catalog cannot resolve | VERIFIED | `seat-store.ts` lines 526–527, 587–591 |
| Golden seed bytes and deep-equals lock `kimi-coding/kimi-for-coding` | VERIFIED | `seat.test.ts` lines 59–63, 184–187; `testing/fixtures/madc-default.json` line 6 |
| CLI receipt regex and fake-engine requested/pinned strings | VERIFIED | `cli.test.ts` line 475; `fake-engine.ts` lines 99, 234; `oneshot.ts` line 1034 |
| Runbook examples `claude-sonnet-4-5` and `gpt-5.1-codex` | VERIFIED | `docs/runbook/M0.md` lines 113, 131–132. Line 84 is the kimi receipt example, not `gpt-5.1-codex`. The commission's "82–84" range is the receipt block; the codex example is 131–132. |
| Seat pin S2: new fields come with a new version; old files are not rewritten; `pinnedModel` values were deferred to M1-A7 | VERIFIED | `PIN-madc-M1-seat-format.md` lines 75–89, 112–113 |
| M1 plan §6 locks model ids in M1-A7; M1-A7 scope repeats that lock | VERIFIED | `PLAN-madc-M1-build-plan.md` lines 78 and 160 |
| Protocol `requestedModel: string`; `-32008` reason union has four strings; `protocolVersion` is `madc-m1/1` | VERIFIED | `PIN-madc-M1-protocol-messages.md` lines 64, 149, 248; `protocol/errors.ts` line 46 |
| `serializeSeat` emits `pinnedModel` always, and `displayName` / `fallbacks` only at version 2 | VERIFIED | `seat-store.ts` lines 64–65, 92–99 |
| Claude Code 2.1.285: `--model` optional; omitting it leaves settings / `ANTHROPIC_MODEL` / account default. `default` is a special alias, not "the flag was absent". | VERIFIED | Local `claude --version` and `claude --help`; [model-config](https://code.claude.com/docs/en/model-config) and [cli-reference](https://code.claude.com/docs/en/cli-reference), 2026-09-30. The exact account-default **id** is intentionally not stated. |
| Codex upstream `ThreadStartParams.model` is optional and omission uses user config | VERIFIED | GitHub `thread.rs` on `main` and commits `914c8eeb`, `f1affbac`, `27c05a52`; app-server README wording, 2026-09-30 |
| Installed Codex is `codex-cli 0.159.1` and can generate a JSON schema | VERIFIED | Local `codex --version`, `codex app-server --help`, 2026-09-30 |
| Installed 0.159.1 accepts `thread/start` without `model` | UNPROVEN | Schema was not generated. Builder gate in §7. |
| Kimi Code API has no documented default model when `model` is omitted. The four ids are a current catalog on the docs site, not an omission default. The null/undefined map is reasoning effort. | VERIFIED | [overview](https://www.kimi.com/code/docs/en/), [models](https://www.kimi.com/code/docs/en/kimi-code/models.html), fetched 2026-09-30 |
| HTTP status of a Kimi or Ollama request that omits `model` | UNPROVEN | No credentialed probe. Not required for D-SSP-4. |
| Ollama `model` is required. No omission default. `ollama cp` is not that default. | VERIFIED | [api.md](https://github.com/ollama/ollama/blob/main/docs/api.md), [openai-compatibility](https://docs.ollama.com/api/openai-compatibility), [authentication](https://docs.ollama.com/api/authentication), fetched 2026-09-30 |
| A live `/api/tags` call today still lists `gpt-oss:120b` | STALE as a seed lock; not re-probed | Planning record OLL-19 was VERIFIED on 2026-09-24. This amendment does not need the current list, because seeds no longer copy an entry from it. |
| `provider-agent.ts` line 247 is the `thread/start` send | STALE pointer | Line 247 is `resolveCodexPinnedModel`. The send is `codex.ts` line 445. The fact that a resolved model is sent is VERIFIED. |

---

## 10. Acceptance of this document

1. Base pins gain only the `Amended by` pointer. Their model-lock sentences stay in place so the historical pin is still readable, and this file supersedes those sentences by name.
2. No file under `packages/` changes in the commission that adds this amendment.
3. The builder act in §7 is not started by merging this file. It starts on its own Founder commission.

*End of M1 Amendment 1.*
