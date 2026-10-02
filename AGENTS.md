## Learned User Preferences

- Kimi (Hephaestus) is the M1 builder. GLM is the external Witness builder; a hold on the Witness seat is not a hold on Kimi.
- Do not add a GLM or Z.ai adapter inside madc. Founder ruling D-FS-1 (issued 2026-09-30) keeps `zai-glm-coding-plan` and Antigravity sign-in forbidden. The next catalog act may add an unwired `zai-payg` id only, with no adapter and no frozen base URL. D-R3 still bars the Coding Plan and the vendor-tool path. M1-A4 left `zai-glm-5-2` and `zai-glm-5-3` on the pinned Mistral catalog unfiltered; policy still forbids Z.ai/GLM.
- Keep the product name and the `madc` command. A later npm scope change is acceptable; do not rename the command to obtain an unscoped package name.
- Do not install `@madmike40/madc` globally. That stub shadows the CLI in this repo. Leave the published package on the registry.
- Pin the subscription surface, not a model name (Founder ruling 2026-09-30). A seat pins a backing such as `claude-code`, `codex`, `ollama-cloud`, or `kimi-code`. Any model that backing currently offers is legal; a model from another subscription is not. If no model is named, the surface uses its own default and the repo does not invent one. Receipts still record the model asked for and the model that served.
- Seeds must not ship model generation strings such as `gpt-5.1-codex`, `claude-sonnet-4-5`, or `ollama-cloud/gpt-oss:120b`. A seed change never rewrites a `seats/<id>.json` already on disk.

## Learned Workspace Facts

- npm user `madmike40` published `@madmike40/madc@0.0.0` as a name-reserve stub outside this repo. The unscoped name `madc` is blocked by npm's similar-name rule. Do not publish version `0.0.0` again.
- The root package is private `madc-workspace`. The CLI package is private `@madc/cli` with bin `madc`. Publishing this repo does not claim the npm name `madc`.
- M0 has landed on main. On 2026-09-27 the Founder accepted the M1 plan as commissionable; each M1 act still needs its own Founder commission and Founder merge.
- M1-A0 (pins), M1-A1 (registry v2), M1-A2 (keychain credential store), M1-A3 (generic direct-key port plus Ollama Cloud), M1-A4 (direct-key batch: Mistral, DeepSeek, Gemini, xAI API), M1-A5 (interactive-only MiniMax Token Plan and Alibaba Coding Plan), M1-A6 (generic ACP client plus Grok Build), M1-A7 (seat roster v1 with five seeded seats), and M1-A8 (CLI surfaces and doctor lanes report) are merged on main.
- The M0 Witness terminal CLI is on main (PR #35). Rev 6.2 conformance remains unverified.
- M1-A8 left turn-time catalog staleness for a follow-up, and the Witness stays headless. Lanes verified on 2026-09-24 show denied in doctor from 2026-10-25 while turns still serve them until terms are re-verified or the turn check receives the current date.
