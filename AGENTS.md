## Learned User Preferences

- Kimi (Hephaestus) is the M1 builder. GLM is the external Witness builder; a hold on the Witness seat is not a hold on Kimi.
- Do not add a GLM or Z.ai adapter inside madc; Z.ai stays forbidden as an in-product adapter.
- Keep the product name and the `madc` command. A later npm scope change is acceptable; do not rename the command to obtain an unscoped package name.
- Do not install `@madmike40/madc` globally. That stub shadows the CLI in this repo. Leave the published package on the registry.
- Pin the subscription surface, not a model name (Founder ruling 2026-09-30). A seat pins a backing such as `claude-code`, `codex`, `ollama-cloud`, or `kimi-code`. Any model that backing currently offers is legal; a model from another subscription is not. If no model is named, the surface uses its own default and the repo does not invent one. Receipts still record the model asked for and the model that served.
- Seeds must not ship model generation strings such as `gpt-5.1-codex`, `claude-sonnet-4-5`, or `ollama-cloud/gpt-oss:120b`. A seed change never rewrites a `seats/<id>.json` already on disk.

## Learned Workspace Facts

- npm user `madmike40` published `@madmike40/madc@0.0.0` as a name-reserve stub outside this repo. The unscoped name `madc` is blocked by npm's similar-name rule. Do not publish version `0.0.0` again.
- The root package is private `madc-workspace`. The CLI package is private `@madc/cli` with bin `madc`. Publishing this repo does not claim the npm name `madc`.
- M0 has landed on main. On 2026-09-27 the Founder accepted the M1 plan as commissionable; each M1 act still needs its own Founder commission and Founder merge.
- M1-A0 (pins), M1-A1 (registry v2), M1-A2 (keychain credential store), M1-A3 (generic direct-key port plus Ollama Cloud), and M1-A7 (seat roster v1 with five seeded seats) are merged on main.
