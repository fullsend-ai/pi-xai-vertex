# AGENTS.md

A [pi](https://github.com/earendil-works/pi) provider extension: xAI Grok on Google Cloud Vertex AI.
Registers provider `xai-vertex`, model `xai/grok-4.6`. **This repo is public.**

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything — it covers the layout, how the
provider works, and the pi-specific gotchas behind each decision. The rules below are the short form.

## Commands

```bash
npm ci          # installs pi as a peer; tsc and the tests need its types
npm run ci      # lint + test — must pass before any commit
```

## Rules

- **Never cast at `createProvider()`.** `Model`, `ModelCost` and `AuthResult` come from
  `@earendil-works/pi-ai`. Fix type errors; never silence them with `as never` or `@ts-ignore`.
- **Import only from pi's allowlisted specifiers**: `@earendil-works/pi-ai`, `.../compat`,
  `.../oauth`, `.../providers/all`, `@earendil-works/pi-coding-agent`. Any other subpath fails to
  load — silently, since pi drops a failed extension from `--list-models` without printing anything.
- **Auth is ambient: `auth.apiKey` with no `login`, never `auth.oauth`.** ADC comes from the
  environment; `oauth` makes pi wait for a persisted interactive credential and fails on any fresh
  machine (it shipped that way in v0.1.0). Verify by deleting the provider's `~/.pi/agent/auth.json`
  entry, then `pi -ne -e . --model xai-vertex/xai/grok-4.6 "hi"`.
- **Trust `node_modules/@earendil-works/pi-ai/dist/**/*.d.ts`, not pi's prose docs.**
- **Re-test other providers after any provider/model change** with `pi --list-models`: one bad entry
  breaks every registered provider, not just this one.
- **Change prices only from [docs.x.ai/docs/models](https://docs.x.ai/docs/models)**, and update
  `src/index.test.ts` in the same commit. The long-context `tiers` entry is request-wide by design.
- **`location: global` is a constraint, not a preference.** Do not make it configurable.
- **Never hardcode a GCP project.** No project ids, host names, or employer-internal repo names in
  code, tests, or docs — tests use `proj`/`my-proj`.
- **`google-auth-library` is the only runtime dependency.** Do not add more, and do not mint tokens
  by shelling out to a CLI or interpreter.
- **Use the three-segment model spec** in automation: `xai-vertex/xai/grok-4.6`.
- **Erasable TypeScript only** (pi uses Node strip-only mode): no `enum`, `namespace`, or parameter
  properties. Top-level imports only. No `any`.
- **Direct dependencies are pinned to exact versions.** Refresh the lockfile with
  `npm install --package-lock-only --ignore-scripts`.

## Before you commit

- `npm run ci` passes, plus one real call for provider/endpoint/auth changes.
- Verify claims about Vertex, xAI, or pi against the `.d.ts`, a live call, or vendor docs.
- Commit format `{feat,fix,docs}: <message>`, no emojis, and `Signed-off-by: <name> <email>`.
