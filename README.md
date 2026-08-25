# @fullsend-ai/pi-xai-vertex

xAI **Grok 4.6** on Google Cloud **Vertex AI**, as a [pi](https://github.com/earendil-works/pi)
provider.

## Install

```bash
pi install git:github.com/fullsend-ai/pi-xai-vertex
export XAI_VERTEX_PROJECT_ID=your-gcp-project
gcloud auth application-default login
```

That's it — no `XAI_API_KEY` and no `pi login`. Auth uses Application Default Credentials, the same
as the Claude-on-Vertex setup. Auth is resolved per request from ADC; `google-auth-library` caches
the token and only re-mints it near expiry, so a fresh machine or a CI sandbox needs nothing beyond
ADC.

> **Upgrading from v0.1.0?** Remove the `xai-vertex` entry from `~/.pi/agent/auth.json`
> (`pi logout xai-vertex`). v0.1.0 stored an OAuth credential there, and pi resolves auth by stored
> credential type — so that leftover entry makes pi skip this provider entirely.

## Use

```bash
pi --model xai-vertex/xai/grok-4.6 "your prompt"
```

Or set it as your default in `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "xai-vertex", "defaultModel": "xai/grok-4.6" }
```

> **Use the full `xai-vertex/xai/grok-4.6` in scripts.** The shorter `xai/grok-4.6` is ambiguous —
> pi has a built-in `xai` provider (xAI's own API) that will answer to it instead.

## Pricing

Per million tokens ([xAI's published rates](https://docs.x.ai/docs/models)):

| | Input | Cached input | Output |
|---|---|---|---|
| Standard | $2.00 | $0.50 | $6.00 |
| Prompt ≥ 200K | $4.00 | $1.00 | $12.00 |

pi reports spend with these automatically. Note the long-context rate applies to the **whole
request** once the prompt crosses 200K, output included — not just the excess.

Roughly, against Claude Sonnet 5 ($2 / $10, cache read $0.20, no long-context premium): Grok is
~40% cheaper on output at short context, and pricier above 200K or on cache-heavy agent loops.

## Using alongside other Vertex providers

pi can serve models from multiple Vertex AI providers and multiple GCP projects in a single session.
Each provider resolves its project from its own environment variable, so Grok can run from one
project while Claude or Gemini run from another — important in practice because model availability
in Vertex Model Garden is per-project.

### Environment variables are independent

| Provider | Project variable | Location | Notes |
|---|---|---|---|
| `xai-vertex` (this) | `XAI_VERTEX_PROJECT_ID`, then `GOOGLE_CLOUD_PROJECT`, then `ANTHROPIC_VERTEX_PROJECT_ID` | fixed `global` | not configurable — Vertex serves Grok only on the global endpoint |
| `anthropic-vertex` | `ANTHROPIC_VERTEX_PROJECT_ID` (among others) | `CLOUD_ML_REGION` | separate extension, see [twoGiants/pi-anthropic-vertex](https://github.com/twoGiants/pi-anthropic-vertex) |
| `google-vertex` (built in) | `GOOGLE_CLOUD_PROJECT` | `GOOGLE_CLOUD_LOCATION` | **both required** |

All three use ADC for credentials (`gcloud auth application-default login`), so one login covers
every provider even across projects — it is the *project* that differs, not the identity.

See [Requirements](#requirements) below for this provider's project fallback order and
[Install](#install) for the ADC setup.

### Worked example: two projects, three providers

```bash
# Grok from project A, Claude and Gemini from project B
export XAI_VERTEX_PROJECT_ID=my-grok-project
export ANTHROPIC_VERTEX_PROJECT_ID=my-models-project
export GOOGLE_CLOUD_PROJECT=my-models-project
export GOOGLE_CLOUD_LOCATION=us-central1
export CLOUD_ML_REGION=us-central1

gcloud auth application-default login

pi install git:github.com/fullsend-ai/pi-xai-vertex
pi install git:github.com/twoGiants/pi-anthropic-vertex

# All three answer, each from its own project:
pi --model xai-vertex/xai/grok-4.6 "hi"
pi --model anthropic-vertex/claude-opus-4-6 "hi"
pi --model google-vertex/gemini-3.7-flash "hi"
```

**Always set `XAI_VERTEX_PROJECT_ID` explicitly when Grok lives in a different project.** This
provider falls back through the other providers' project variables, so omitting it when projects
differ silently routes Grok traffic via `GOOGLE_CLOUD_PROJECT` or `ANTHROPIC_VERTEX_PROJECT_ID`.

### Always use fully qualified model specs

Bare model ids are ambiguous and produce confusing failures:

- `xai/grok-4.6` resolves to pi's **built-in `xai`** provider (xAI's native API, wants
  `XAI_API_KEY`), not this one. See [Use](#use) above.
- `gemini-3.7-flash` exists under both `google` (Gemini API, wants `GEMINI_API_KEY`, fails with
  `API_KEY_INVALID` against `generativelanguage.googleapis.com`) and `google-vertex` (ADC). A stale
  or absent key sends you debugging a path unrelated to Vertex.

Use the three-segment form in scripts: `xai-vertex/xai/grok-4.6`, `google-vertex/gemini-3.7-flash`.

### google-vertex requires both project and location

`google-vertex` needs `GOOGLE_CLOUD_PROJECT` *and* `GOOGLE_CLOUD_LOCATION`. With either missing it
fails with a generic `Use /login to log into a provider`, naming neither variable. This provider
registers nothing when unconfigured and, since v0.2.0, prints the specific cause.

### How to tell which model actually answered

A model's self-report is not evidence — switching `/model` mid-session can produce a reply still
claiming to be the previous model, because earlier turns in the context said so. Ground truth,
cheapest first:

- `PI_MODEL` / `PI_PROVIDER` / `PI_SESSION_FILE` are exported into the agent's shell
- The session JSONL records `model_change` events and per-message `provider` / `model` / `api`
- `responseId` is server-generated (`msg_vrtx_…` is Anthropic-on-Vertex)
- Cost arithmetic discriminates: Grok bills output at $6/M with no cache-write charge

## Requirements

- pi ≥ 0.84
- A GCP project with the Grok model enabled in Vertex AI Model Garden
- ADC credentials (`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`)

`XAI_VERTEX_PROJECT_ID` falls back to `GOOGLE_CLOUD_PROJECT`, then `ANTHROPIC_VERTEX_PROJECT_ID`.
With none of them set the provider registers nothing and stays quiet, rather than offering a model
that fails at call time.

## Troubleshooting

**The model doesn't appear in `pi --list-models`.** Almost always an unset project — check
`XAI_VERTEX_PROJECT_ID`. If it is set, load the extension explicitly to see the real error, which
pi otherwise swallows:

```bash
pi -e ~/.pi/agent/git/github.com/fullsend-ai/pi-xai-vertex/src/index.ts --list-models
```

**`No API key found for xai`.** You used `xai/grok-4.6` and reached pi's built-in provider. Use the
full `xai-vertex/xai/grok-4.6`.

**A 403 or `FAILED_PRECONDITION`.** The project lacks access to the model in Model Garden, or ADC
is pointed at a different project than you expect.

---

Contributing, architecture, and the pi-specific gotchas behind the design:
[CONTRIBUTING.md](CONTRIBUTING.md). Rules for AI agents working in this repo: [AGENTS.md](AGENTS.md).

MIT licensed.
