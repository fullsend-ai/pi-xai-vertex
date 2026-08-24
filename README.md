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
as the Claude-on-Vertex setup; the token is minted and renewed from your environment on each
request, so a fresh machine or a CI sandbox needs nothing beyond ADC.

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
