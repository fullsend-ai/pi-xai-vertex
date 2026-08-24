// pi provider extension: xAI Grok models via Google Cloud Vertex AI Model Garden.
//
// Grok-on-Vertex (launched 2026-08-21) speaks the OpenAI-completions protocol, unlike pi's
// built-in "xai" provider (native xAI API, needs XAI_API_KEY) and pi's built-in "google-vertex"
// provider (built for Gemini's own native Vertex API shape, not OpenAI-compatible). Neither
// covers this case, so it needs its own provider registration — this is NOT related to
// @twogiants/pi-anthropic-vertex, which is tightly coupled to Anthropic's own message/streaming
// format; bridging a different protocol needs its own bridge.
//
// Prior art in other ecosystems (not drop-in for pi, but the same idea and worth reading before
// changing anything here): vercel/ai's packages/google-vertex/src/xai (AI SDK, LanguageModelV4)
// and TanStack/ai's packages/ai-grok/src/vertex. Both mint a Google access token per request via
// google-auth-library, which is exactly the shape below. As of 2026-08-24 nothing pi-shaped
// exists and earendil-works/pi has no open issue or PR for xai-on-Vertex, so unlike
// anthropic-vertex (tracked against upstream pi#5262) there is no upstream to wait for.
//
// Endpoint shape confirmed empirically 2026-08-24: the model is only served on the *global*
// Vertex endpoint (regional endpoints return a 400 FAILED_PRECONDITION telling you to use global),
// so this hardcodes "global" rather than reading GOOGLE_CLOUD_LOCATION/CLOUD_ML_REGION — that's a
// real technical constraint of this specific model, not a configuration preference. Both
// implementations above default to "global" too.
//
// Auth: Vertex requires a short-lived (~1hr) OAuth2 access token minted from Application Default
// Credentials, not a static API key. Reuses pi's own `auth.oauth` block (see docs/custom-provider.md)
// so pi handles expiry/caching/persistence to ~/.pi/agent/auth.json and calls refresh() for you —
// no separate proxy process, no manual re-export needed. Token minting uses the Node
// google-auth-library (declared in this directory's package.json) rather than shelling out to
// python3's google.auth: it is the same library the Claude-on-Vertex path already depends on, it
// needs no child_process on the credential path, and it is the only one proven against the
// rewritten external_account config that fullsend's prepare-sandbox-credentials.sh hands a sandbox.
//
// The GCP project comes from an env var and is never hardcoded here: it is deployment-specific
// config, and this source is public.

// pi's extension loader resolves a fixed allowlist of specifiers to bundled virtual modules
// (core/extensions/loader.ts): "@earendil-works/pi-ai" (aliased to the compat entrypoint),
// ".../compat", ".../oauth", ".../providers/all", and "@earendil-works/pi-coding-agent". Anything
// else — including a real subpath like ".../api/openai-completions.lazy" — falls through to
// filesystem resolution, where the loader appends it to the alias *file* path and fails with
// "Cannot find module .../dist/compat.js/api/openai-completions.lazy". Import only from the
// allowlisted specifiers.
//
// openAICompletionsApi is not declared on the package root's types, so it comes from "/compat",
// which is allowlisted and re-exports it. createProvider and the types come from the root, whose
// declarations are the accurate ones.
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model, ModelCost, OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoogleAuth } from "google-auth-library";

/** Env vars consulted for the GCP project, in precedence order. */
export const PROJECT_ENV_VARS = [
  "XAI_VERTEX_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_VERTEX_PROJECT_ID",
] as const;

/** First non-empty project id in PROJECT_ENV_VARS order, or undefined if none is set. */
export function resolveProject(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROJECT_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Grok-on-Vertex is served only on the *global* endpoint — regional ones answer
 * `400 FAILED_PRECONDITION: ... is only available via global endpoint`. That is a property of the
 * model, not a preference, so the location is deliberately not configurable.
 */
export function buildBaseUrl(project: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi`;
}

/** Renew a minute early so an in-flight request can't be the one that discovers the expiry. */
export const EXPIRY_SKEW_MS = 60_000;
/**
 * Only used when the credential type doesn't expose expiry_date (some impersonation paths).
 * Google access tokens last ~1h; 55m keeps the fallback inside that even with clock drift.
 */
export const FALLBACK_TTL_MS = 55 * 60 * 1000;

// OAuthCredential, Model and ModelCost are imported from pi rather than re-declared locally. A
// hand-rolled equivalent is subtly non-assignable (pi's carries an index signature), which forces a
// cast at the createProvider() call — and that cast would switch off the one compile-time check that
// catches a provider or model entry pi can no longer accept. Keep these bound to pi's own types so a
// pi upgrade fails `npm run lint` here instead of throwing at model resolution in production.

/**
 * Build pi's oauth credential from what google-auth-library returned. Prefers the credential's real
 * expiry (minus skew) and falls back to a fixed TTL when it is absent or already in the past.
 */
export function credentialFrom(
  token: string | null | undefined,
  expiryDate: number | null | undefined,
  now: number = Date.now(),
): OAuthCredential {
  if (!token) {
    throw new Error(
      "xai-vertex: Google ADC returned no access token. Run `gcloud auth application-default login`, " +
        "or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
    );
  }
  const expires =
    typeof expiryDate === "number" && expiryDate > now
      ? expiryDate - EXPIRY_SKEW_MS
      : now + FALLBACK_TTL_MS;
  // `refresh` is required on pi's oauth credential, but ADC holds the real refresh material itself —
  // google-auth-library re-derives the token from it, so there is nothing to persist here.
  return { type: "oauth", access: token, refresh: "adc", expires };
}

/**
 * Published xAI rates per million tokens (docs.x.ai/docs/models, read 2026-08-24).
 *
 * xAI bills long context request-wide — "requests whose prompt reaches the listed token threshold
 * are billed at the higher rate for all tokens in the request" — which is exactly pi's tier
 * semantics ("the highest matching input threshold applies to the full request"), so this maps 1:1
 * rather than needing per-token splitting. Grok has no cache-*write* charge: caching is automatic
 * and only reads are priced.
 */
export const GROK_4_6_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
} satisfies ModelCost;

export const PROVIDER_ID = "xai-vertex";
/**
 * The id is both pi's registry key and the value sent on the wire (there is no separate wire-name
 * field), so the slash is load-bearing: Vertex expects the publisher-qualified `xai/grok-4.6`.
 */
export const MODEL_ID = "xai/grok-4.6";

/**
 * The provider config pi registers. Built separately from the extension entry point so it can be
 * asserted without a live pi — every field below is required by pi's model resolution, and omitting
 * any one of them throws inside resolveCliModel and breaks *every* registered provider, not just
 * this one.
 */
export function xaiVertexProviderConfig(project: string) {
  const baseUrl = buildBaseUrl(project);
  const model: Model<"openai-completions"> = {
    id: MODEL_ID,
    provider: PROVIDER_ID,
    name: "Grok 4.6 (Vertex)",
    api: "openai-completions",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 500000,
    maxTokens: 65536,
    cost: GROK_4_6_COST,
  };
  return {
    id: PROVIDER_ID,
    name: "xAI Grok (Vertex)",
    baseUrl,
    auth: {
      oauth: {
        name: "Google Cloud ADC (xAI Vertex)",
        login: mintCredential,
        refresh: mintCredential,
        async toAuth(credential: { access: string }) {
          return { apiKey: credential.access };
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  };
}

// One GoogleAuth per process: it caches the resolved client and the underlying credential, so
// repeated getAccessToken() calls only hit the network once the token has actually aged out.
let auth: GoogleAuth | undefined;

async function mintCredential(): Promise<OAuthCredential> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return credentialFrom(token, client.credentials?.expiry_date);
}

export default function (pi: ExtensionAPI) {
  const project = resolveProject();
  if (!project) {
    // No project configured — don't register a provider that would fail at call time with a
    // confusing auth error. Silently skip, same posture as a disabled hook.
    return;
  }
  pi.registerProvider(createProvider(xaiVertexProviderConfig(project)));
}
