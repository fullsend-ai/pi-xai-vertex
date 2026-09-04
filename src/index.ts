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
// Credentials, not a static API key. ADC is *ambient* — discovered from the environment, with
// nothing for a user to type — so this registers `auth.apiKey` with **no `login` handler**, which is
// how pi spells "ambient-only", and pi calls `resolve()` per request. Do NOT switch this to
// `auth.oauth`: that shape means "an interactive login mints a credential pi persists to
// ~/.pi/agent/auth.json", so pi refuses the provider until one exists. It shipped that way in v0.1.0
// and looked fine on any machine that had logged in once, while failing on every fresh environment
// with "No API key found for xai-vertex".
//
// Token minting uses the Node google-auth-library (declared in this directory's package.json)
// rather than shelling out to python3's google.auth: it is the same library the Claude-on-Vertex
// path already depends on, it needs no child_process on the credential path, it is the only one
// proven against the rewritten external_account config that fullsend's
// prepare-sandbox-credentials.sh hands a sandbox, and it does its own token caching and renewal —
// which is why there is no expiry arithmetic here.
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
import type { AuthResult, Model, ModelCost } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// AuthResult, Model and ModelCost are imported from pi rather than re-declared locally. A
// hand-rolled equivalent is subtly non-assignable, which forces a cast at the createProvider() call
// — and that cast would switch off the one compile-time check that catches a provider or model
// entry pi can no longer accept. Keep these bound to pi's own types so a pi upgrade fails
// `npm run lint` here instead of throwing at model resolution in production.
//
// Token lifetime is deliberately not tracked here: google-auth-library caches the access token and
// re-mints it when it ages out, and pi calls resolve() per request, so there is no expiry
// arithmetic to get wrong.

/**
 * Turn what google-auth-library returned into pi's request auth. Vertex takes the access token as a
 * bearer token, which pi sends as the `apiKey`.
 */
export function authResultFrom(token: string | null | undefined): AuthResult {
  if (!token) {
    throw new Error(
      "xai-vertex: Google ADC returned no access token. Run `gcloud auth application-default login`, " +
        "or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
    );
  }
  return { auth: { apiKey: token }, source: "Google ADC" };
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
 * Creates a TransformStream that filters out Vertex AI keepalive frames from SSE streams.
 *
 * The Vertex partner-model endpoint sends keepalives as `data: : keepalive\n\n` (an SSE data event
 * whose payload is `: keepalive`). The OpenAI SDK's SSE decoder drops SSE *comment* lines
 * (`: keepalive`) but JSON.parse()s every `data:` line's payload, so these keepalives abort the
 * stream with "Unexpected token ':'". This transform drops such lines (including their trailing
 * empty line separator) before the SDK sees them.
 */
export function createKeepaliveFilterTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      // Append the new chunk to any buffered partial line from the previous chunk
      buffer += decoder.decode(chunk, { stream: true });

      // Split on newlines but keep the delimiters so we can reconstruct the stream
      const lines = buffer.split("\n");

      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || "";

      // Process complete lines, filtering out keepalive events
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Drop lines that are SSE data events with a keepalive payload
        // Match: "data: : keepalive" (with optional trailing \r)
        if (/^data:\s*:\s*keepalive\s*\r?$/.test(line)) {
          // Also skip the next line if it's empty (the SSE event separator)
          if (i + 1 < lines.length && lines[i + 1].trim() === "") {
            i++; // Skip the empty line that follows
          }
          continue; // Skip the keepalive line itself
        }
        // Emit the line with its trailing newline
        controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      // Emit any remaining buffered content
      if (buffer.length > 0) {
        // Check if the final buffer is a keepalive line
        if (!/^data:\s*:\s*keepalive\s*\r?$/.test(buffer)) {
          controller.enqueue(encoder.encode(buffer));
        }
      }
    },
  });
}

/**
 * Wraps the global fetch to filter Vertex AI keepalive frames from streaming responses.
 */
export function createKeepaliveFilteringFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);

    // Only transform streaming responses
    if (!response.body) {
      return response;
    }

    // Pipe the response body through the keepalive filter
    const filteredBody = response.body.pipeThrough(createKeepaliveFilterTransform());

    // Return a new Response with the filtered body
    return new Response(filteredBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Wraps a ProviderStreams API to inject a custom fetch into all stream calls.
 */
function wrapApiWithFetch(baseApi: ReturnType<typeof openAICompletionsApi>, customFetch: typeof fetch) {
  return {
    stream(model: Parameters<typeof baseApi.stream>[0], context: Parameters<typeof baseApi.stream>[1], options?: Parameters<typeof baseApi.stream>[2]) {
      return baseApi.stream(model, context, { ...options, fetch: customFetch });
    },
    streamSimple(model: Parameters<typeof baseApi.streamSimple>[0], context: Parameters<typeof baseApi.streamSimple>[1], options?: Parameters<typeof baseApi.streamSimple>[2]) {
      return baseApi.streamSimple(model, context, { ...options, fetch: customFetch });
    },
    fetchDeferred: baseApi.fetchDeferred,
    cancelDeferred: baseApi.cancelDeferred,
  };
}

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
      // Ambient-only auth: no `login`, because there is nothing interactive to do — the credential
      // is Application Default Credentials, discovered from the environment. pi's ApiKeyAuth
      // documents an absent `login` as exactly this ("Absent = ambient-only"), and calls `resolve`
      // per request, so google-auth-library's own caching and renewal stay in charge of expiry.
      //
      // This must NOT be `auth.oauth`: that shape means "an interactive login mints a credential pi
      // then persists to ~/.pi/agent/auth.json", so pi refuses to use the provider until such a
      // credential exists. It appears to work on a machine that once logged in, and fails on every
      // fresh one — including a sandbox — with "No API key found for xai-vertex".
      apiKey: {
        name: "Google Cloud ADC (xAI Vertex)",
        async check() {
          // Side-effect-free relative to resolve(), which performs request-time credential
          // discovery — so pi asks this first to decide whether the model is available. (Note this
          // can still touch the network: with no other ADC source configured, google-auth-library
          // probes the GCE metadata server.)
          return (await hasAdcCredentials()) ? { type: "api_key" as const, source: "Google ADC" } : undefined;
        },
        async resolve() {
          return authResultFrom(await mintAccessToken());
        },
      },
    },
    models: [model],
    api: wrapApiWithFetch(openAICompletionsApi(), createKeepaliveFilteringFetch()),
  };
}

// One GoogleAuth per process: it caches the resolved client and the underlying credential, so
// repeated getAccessToken() calls only hit the network once the token has actually aged out.
let auth: GoogleAuth | undefined;

function googleAuth(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth;
}

async function mintAccessToken(): Promise<string | null | undefined> {
  const client = await googleAuth().getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/**
 * Whether ADC can be discovered at all, without minting a token.
 *
 * pi's `AuthCheck` can only say available/unavailable — there is no field for a reason — so an
 * unavailable provider otherwise surfaces as a bare "model not found", with nothing pointing at the
 * credentials. Since that opacity is what made the v0.1.0 auth bug hard to spot in the first place,
 * the discovery failure is written to stderr before returning false. pi captures extension stderr
 * (fullsend tees it to pi-debug.log), and this only fires when ADC is genuinely broken.
 *
 * Warned once per process: pi calls check() for each model-availability query, and repeating an
 * identical multi-line credential error turns a useful hint into noise.
 */
let warnedAdcUnavailable = false;

async function hasAdcCredentials(): Promise<boolean> {
  try {
    await googleAuth().getClient();
    return true;
  } catch (error) {
    if (!warnedAdcUnavailable) {
      warnedAdcUnavailable = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[xai-vertex] Google ADC unavailable, so the provider will not be offered: ${reason}. ` +
          "Run `gcloud auth application-default login`, or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
      );
    }
    return false;
  }
}

/**
 * v0.1.0 declared `auth.oauth`, so anyone who ran `pi login` for this provider has a
 * `{ "type": "oauth" }` entry for it in auth.json. pi resolves auth by *stored credential type*
 * first: with a stored oauth credential and no `auth.oauth` on the provider, both
 * resolveProviderAuth() and checkProviderAuth() short-circuit to undefined and never reach the
 * ambient apiKey path below. The provider then vanishes from --list-models and requests fail with
 * "No API key found" — on a machine that used to work.
 *
 * pi gates before calling into the provider, so the extension cannot intercept and repair this at
 * resolve time. Detect it at load and say exactly what to delete, so the failure explains itself
 * instead of looking like the bug v0.1.1 fixed.
 */
export function staleOAuthCredentialPath(readFile: (p: string) => string = (f) => readFileSync(f, "utf8")): string | undefined {
  let authPath: string;
  try {
    authPath = join(getAgentDir(), "auth.json");
  } catch {
    return undefined;
  }
  try {
    const stored = JSON.parse(readFile(authPath)) as Record<string, { type?: string } | undefined>;
    return stored?.[PROVIDER_ID]?.type === "oauth" ? authPath : undefined;
  } catch {
    // No auth.json, unreadable, or not JSON — nothing to migrate.
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const project = resolveProject();
  if (!project) {
    // No project configured — don't register a provider that would fail at call time with a
    // confusing auth error. Silently skip, same posture as a disabled hook.
    return;
  }
  const stale = staleOAuthCredentialPath();
  if (stale) {
    console.error(
      `[${PROVIDER_ID}] Found a leftover OAuth credential from v0.1.0 in ${stale}. ` +
        `Auth is now ambient (Application Default Credentials), and pi will ignore this provider ` +
        `while that entry exists. Remove the "${PROVIDER_ID}" entry from that file — ` +
        `\`pi logout ${PROVIDER_ID}\` if your pi version supports it, otherwise edit it out.`,
    );
  }
  pi.registerProvider(createProvider(xaiVertexProviderConfig(project)));
}
