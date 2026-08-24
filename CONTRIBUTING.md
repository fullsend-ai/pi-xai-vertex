# Contributing

## Setup

```bash
npm ci          # installs pi as a peer — tsc and the tests need its types
npm run ci      # lint + test; must pass before any commit
```

Point your local pi at a checkout while developing:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-xai-vertex
```

Symlink the **directory**, not the file: pi resolves an extension's imports from the path it loaded
it by, so a lone `.ts` linked into `extensions/` cannot see this repo's `node_modules/`.

## Layout

pi documents three extension styles — a single `.ts` file, a directory with `index.ts`, and, for
extensions with npm dependencies, a package with its entry point under `src/`. This is the third,
because it depends on `google-auth-library`.

```
├── package.json          # "pi": { "extensions": ["./src/index.ts"] } — how pi finds the entry point
├── src/
│   ├── index.ts          # the whole extension
│   └── index.test.ts     # node --test, co-located
└── .github/workflows/ci.yml
```

`src/index.ts` keeps all logic in pure exports — `resolveProject`, `buildBaseUrl`, `credentialFrom`,
`GROK_4_6_COST`, `xaiVertexProviderConfig` — with a thin `default` that registers them. The suite
therefore runs with no pi, no network, and no GCP credentials.

Two tests are worth more than the rest, because they check the config against **pi's** expectations
rather than ours: one runs pi's real `createProvider`, the other its real `calculateCost` (including
a 250K-token request that must bill request-wide). If they fail after a pi bump, the schema moved —
read the `.d.ts` rather than loosening the test.

## How it works

Vertex serves Grok over the **OpenAI-completions** protocol at
`/v1/projects/<project>/locations/global/endpoints/openapi`, authenticated with a short-lived (~1h)
Google OAuth2 access token rather than a static key. So the provider is thin: `api` is pi's own
`openAICompletionsApi()`, and `auth.oauth` mints and renews through `google-auth-library`. pi does
streaming, tools, usage, and credential caching.

It mirrors **no** pi internals, so it cannot drift against a pi release and needs no sync tooling.
If a change starts requiring a copy of pi's source, stop and reconsider.

## Gotchas

Each of these cost real debugging time. They are not obvious from pi's docs.

**Import only from pi's allowlisted specifiers.** The extension loader maps a fixed list to bundled
virtual modules: `@earendil-works/pi-ai` (aliased to compat), `.../compat`, `.../oauth`,
`.../providers/all`, and `@earendil-works/pi-coding-agent`. Anything else — including a *real*
subpath like `.../api/openai-completions.lazy` — falls through to filesystem resolution, where the
loader appends it to the alias **file** path and dies with `Cannot find module
.../dist/compat.js/api/openai-completions.lazy`. This can appear to work on one machine and fail on
another. `openAICompletionsApi` is not on the package root's types, so it comes from `/compat`.

**A failed extension is silent.** pi omits it from `--list-models` and prints nothing. Load it with
`-e <path>` to see the actual error.

**The prose docs are stale; trust the `.d.ts`.** `docs/custom-provider.md` describes a top-level
`oauth` with `refreshToken`/`getApiKey`. The shipped types want `auth: { oauth: {...} }` with
`login`/`refresh`/`toAuth`, where `toAuth` returns a `ModelAuth` (`{ apiKey }`) and `login`/`refresh`
return `{ type: "oauth", access, refresh, expires }` — the `type` tag is required.

**One malformed entry breaks every provider.** `resolveCliModel` iterates *all* registered providers'
models before picking one, so a bad model here takes down `anthropic-vertex`, `google`, everything.
After any provider or model change, run `pi --list-models` and confirm the *others* still resolve.

This is also why `Model`, `ModelCost` and `OAuthCredential` are imported from pi rather than
re-declared, and why there are no casts: a hand-rolled `OAuthCredential` is subtly non-assignable
(pi's carries an index signature), and `as never` would silence exactly the check that catches a
schema break before production.

**Model ids are the wire value.** There is no separate wire-name field — `Model.id` is both the
registry key and what pi sends as `model`. Vertex needs the publisher-qualified `xai/grok-4.6`, so
the id keeps its slash, and the fully-qualified spec is `xai-vertex/xai/grok-4.6`. Registering it as
plain `grok-4.6` does not error; it returns an empty completion.

**`location` is fixed to `global`.** Regional endpoints answer `FAILED_PRECONDITION`. It is a
property of the model, not a preference, so it is deliberately not configurable — vercel/ai and
TanStack/ai default to `global` for the same reason.

**Peer deps are inert at runtime.** pi loads `@earendil-works/*` from bundled virtual modules, so a
copy inside the extension's `node_modules/` is never used — verified by deleting it from an installed
copy. Deployments still use `--omit=peer`, but for install size and supply-chain surface, not
correctness. (`pi install` is itself inconsistent about installing the peer tree across machines.)

## Changing the price table

`GROK_4_6_COST` is what pi reports spend with. Update it **only** from
[docs.x.ai/docs/models](https://docs.x.ai/docs/models) — never a blog post, comparison table, or
memory — and update `src/index.test.ts` in the same commit. The long-context `tiers` entry is
request-wide by design; do not convert it to per-token splitting.

## Before you commit

- `npm run ci` passes.
- Changes to the provider shape, endpoint, or auth also need one real call against a project with
  Grok enabled — the suite deliberately does not cover the network.
- Claims about Vertex, xAI, or pi behaviour need a source: the shipped `.d.ts`, a live call, or
  vendor docs.
- Commit format `{feat,fix,docs}: <concise message>`, no emojis, and sign off:
  `Signed-off-by: <name> <email>`.

## Releasing

Tag and push; `.github/workflows/release.yml` does the rest.

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

It re-runs lint and tests (never cut a release from a tree that does not pass), computes the SHA256
of the tag tarball, and publishes a release whose notes carry the tarball URL and digest — the pair
pinned consumers need. fullsend's sandbox Containerfile fetches that tarball and verifies the
digest, so it is published rather than left for each consumer to derive.

There is no npm publish step: the package is consumed with `pi install git:...`, so the git tag is
the artifact. Adding one is a few lines plus an `NPM_TOKEN` secret if that ever changes.

## Prior art

Not drop-in for pi, but the same idea, and worth reading before changing the auth path:
[vercel/ai `packages/google-vertex/src/xai`](https://github.com/vercel/ai/tree/main/packages/google-vertex/src/xai)
and [TanStack/ai `packages/ai-grok/src/vertex`](https://github.com/TanStack/ai/tree/main/packages/ai-grok/src/vertex).
For Claude on Vertex under pi, see
[twoGiants/pi-anthropic-vertex](https://github.com/twoGiants/pi-anthropic-vertex) — a sibling, and a
different protocol bridge.
