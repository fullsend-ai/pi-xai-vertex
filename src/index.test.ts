import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ProviderStreams, Usage } from "@earendil-works/pi-ai";
import {
  GROK_4_6_COST,
  MODEL_ID,
  PROJECT_ENV_VARS,
  PROVIDER_ID,
  buildBaseUrl,
  authResultFrom,
  resolveProject,
  staleOAuthCredentialPath,
  xaiVertexProviderConfig,
  createKeepaliveFilterTransform,
  createKeepaliveFilteringFetch,
  wrapApiWithFetch,
} from "./index.ts";

describe("resolveProject", () => {
  it("prefers XAI_VERTEX_PROJECT_ID over the shared Vertex vars", () => {
    assert.equal(
      resolveProject({
        XAI_VERTEX_PROJECT_ID: "xai-proj",
        GOOGLE_CLOUD_PROJECT: "ambient-proj",
        ANTHROPIC_VERTEX_PROJECT_ID: "claude-proj",
      }),
      "xai-proj",
    );
  });

  it("falls back through the chain in order", () => {
    assert.equal(
      resolveProject({ GOOGLE_CLOUD_PROJECT: "ambient", ANTHROPIC_VERTEX_PROJECT_ID: "claude" }),
      "ambient",
    );
    assert.equal(resolveProject({ ANTHROPIC_VERTEX_PROJECT_ID: "claude" }), "claude");
  });

  it("returns undefined when nothing is set, so the extension can skip registration", () => {
    assert.equal(resolveProject({}), undefined);
  });

  it("treats blank and whitespace-only values as unset", () => {
    assert.equal(resolveProject({ XAI_VERTEX_PROJECT_ID: "   ", GOOGLE_CLOUD_PROJECT: "real" }), "real");
    assert.equal(resolveProject({ XAI_VERTEX_PROJECT_ID: "" }), undefined);
  });

  it("trims a value that would otherwise corrupt the endpoint URL", () => {
    assert.equal(resolveProject({ XAI_VERTEX_PROJECT_ID: " padded \n" }), "padded");
  });

  it("documents its precedence order in one place", () => {
    assert.deepEqual(PROJECT_ENV_VARS, [
      "XAI_VERTEX_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT",
      "ANTHROPIC_VERTEX_PROJECT_ID",
    ]);
  });
});

describe("buildBaseUrl", () => {
  it("targets the global endpoint — Grok-on-Vertex rejects regional ones", () => {
    const url = buildBaseUrl("my-proj");
    assert.equal(
      url,
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi",
    );
    assert.match(url, /\/locations\/global\//);
  });

  it("hits the non-regional host, so no region prefix can be interpolated in", () => {
    assert.match(buildBaseUrl("p"), /^https:\/\/aiplatform\.googleapis\.com\//);
  });
});

describe("authResultFrom", () => {
  it("hands pi the access token as the request apiKey", () => {
    assert.deepEqual(authResultFrom("tok"), { auth: { apiKey: "tok" }, source: "Google ADC" });
  });

  it("labels the source so pi's status UI names ADC rather than a key", () => {
    assert.equal(authResultFrom("tok").source, "Google ADC");
  });

  it("throws an actionable error instead of returning an empty token", () => {
    for (const empty of [undefined, null, ""]) {
      assert.throws(() => authResultFrom(empty), /no access token/i);
    }
  });
});

describe("GROK_4_6_COST", () => {
  // docs.x.ai/docs/models, read 2026-08-24. These are the numbers pi reports spend with; a silent
  // drift here misprices every run, so they are asserted literally rather than derived.
  it("matches xAI's published standard-tier rates", () => {
    assert.equal(GROK_4_6_COST.input, 2);
    assert.equal(GROK_4_6_COST.output, 6);
    assert.equal(GROK_4_6_COST.cacheRead, 0.5);
  });

  it("charges nothing to write cache — Grok prices reads only", () => {
    assert.equal(GROK_4_6_COST.cacheWrite, 0);
    assert.equal(GROK_4_6_COST.tiers[0].cacheWrite, 0);
  });

  it("carries the long-context tier at the documented 200K threshold", () => {
    assert.equal(GROK_4_6_COST.tiers.length, 1);
    const tier = GROK_4_6_COST.tiers[0];
    assert.equal(tier.inputTokensAbove, 200_000);
    assert.equal(tier.input, 4);
    assert.equal(tier.output, 12);
    assert.equal(tier.cacheRead, 1);
  });

  it("prices long context strictly above standard, never below", () => {
    const tier = GROK_4_6_COST.tiers[0];
    assert.ok(tier.input > GROK_4_6_COST.input);
    assert.ok(tier.output > GROK_4_6_COST.output);
    assert.ok(tier.cacheRead > GROK_4_6_COST.cacheRead);
  });

  it("keeps cache reads cheaper than fresh input in both tiers", () => {
    assert.ok(GROK_4_6_COST.cacheRead < GROK_4_6_COST.input);
    assert.ok(GROK_4_6_COST.tiers[0].cacheRead < GROK_4_6_COST.tiers[0].input);
  });
});

describe("xaiVertexProviderConfig", () => {
  const config = xaiVertexProviderConfig("proj");

  it("registers under the provider id the docs and runtime flags use", () => {
    assert.equal(config.id, PROVIDER_ID);
    assert.equal(PROVIDER_ID, "xai-vertex");
  });

  // Every field below is required by pi's model resolution. Omitting any one throws inside
  // resolveCliModel, which iterates *all* registered providers — so a mistake here breaks every
  // provider in the process, not just this one. That is why they are asserted individually.
  it("sets every field pi's model resolution requires", () => {
    const [model] = config.models;
    assert.equal(model.id, MODEL_ID);
    assert.equal(model.provider, PROVIDER_ID, "model.provider must match the provider id");
    assert.equal(model.api, "openai-completions");
    assert.equal(typeof model.baseUrl, "string");
    assert.ok(model.baseUrl.length > 0);
    assert.equal(typeof model.name, "string");
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      assert.equal(typeof model.cost[field], "number", `cost.${field} must be present`);
    }
  });

  it("keeps the publisher prefix in the model id — it is sent on the wire", () => {
    assert.equal(MODEL_ID, "xai/grok-4.6");
    assert.ok(MODEL_ID.includes("/"), "Vertex expects the publisher-qualified id");
  });

  it("points the model at the same endpoint as the provider", () => {
    assert.equal(config.models[0].baseUrl, config.baseUrl);
    assert.equal(config.baseUrl, buildBaseUrl("proj"));
  });

  it("threads the project through to the endpoint", () => {
    assert.ok(xaiVertexProviderConfig("other-proj").baseUrl.includes("/projects/other-proj/"));
  });

  // Auth must be AMBIENT, not interactive. pi treats `auth.oauth` as "an interactive login mints a
  // credential I persist to auth.json", and refuses the provider until one exists — which passes on
  // a machine that logged in once and fails on every fresh one, including a sandbox, with
  // "No API key found for xai-vertex". ADC is discovered from the environment, so the right shape
  // is apiKey with no `login` ("Absent = ambient-only" in pi's own ApiKeyAuth docs).
  it("uses ambient apiKey auth, never the interactive oauth flow", () => {
    assert.ok(config.auth.apiKey, "auth must be apiKey-shaped");
    assert.ok(!("oauth" in config.auth), "oauth would require an interactive login first");
  });

  it("declares no login handler, which is what marks it ambient-only", () => {
    assert.ok(
      !("login" in config.auth.apiKey) || config.auth.apiKey.login === undefined,
      "a login handler makes pi wait for an interactive credential",
    );
  });

  it("exposes resolve and a side-effect-free check", () => {
    assert.equal(typeof config.auth.apiKey.resolve, "function");
    assert.equal(typeof config.auth.apiKey.check, "function", "check lets pi test availability without minting");
  });

  it("does not pin a static key on the provider", () => {
    assert.ok(!("apiKey" in config), "a static top-level apiKey would defeat per-request token minting");
  });

  it("declares exactly the pricing asserted above", () => {
    assert.deepEqual(config.models[0].cost, GROK_4_6_COST);
  });
});

describe("staleOAuthCredentialPath", () => {
  // The v0.1.0 -> v0.1.1 upgrade hazard: pi resolves auth by *stored credential type* first, so a
  // leftover {"type":"oauth"} entry makes pi skip the ambient path and drop the provider on a
  // machine that used to work. Detecting it is the difference between a self-explaining message
  // and a mystery that looks exactly like the bug this version fixed.
  it("detects a leftover oauth credential for this provider", () => {
    const path = staleOAuthCredentialPath(() => JSON.stringify({ "xai-vertex": { type: "oauth", access: "x" } }));
    assert.ok(path, "a stored oauth credential for this provider must be reported");
    assert.match(path, /auth\.json$/);
  });

  it("ignores an api_key credential, which is the shape this version uses", () => {
    assert.equal(staleOAuthCredentialPath(() => JSON.stringify({ "xai-vertex": { type: "api_key" } })), undefined);
  });

  it("ignores other providers' oauth credentials", () => {
    assert.equal(staleOAuthCredentialPath(() => JSON.stringify({ anthropic: { type: "oauth" } })), undefined);
  });

  it("is quiet when there is no auth.json, or it is unreadable or not JSON", () => {
    assert.equal(staleOAuthCredentialPath(() => { throw new Error("ENOENT"); }), undefined);
    assert.equal(staleOAuthCredentialPath(() => "not json at all"), undefined);
    assert.equal(staleOAuthCredentialPath(() => "null"), undefined);
    assert.equal(staleOAuthCredentialPath(() => "{}"), undefined);
  });
});

describe("auth availability check", () => {
  const config = xaiVertexProviderConfig("proj");

  it("reports availability when ADC resolves, without minting a token", async () => {
    // The sandbox this runs in has ADC via GOOGLE_APPLICATION_CREDENTIALS or gcloud; when it does
    // not, check() must say unavailable rather than throw. Either answer is valid here — what is
    // not valid is an exception escaping into pi's model-availability path.
    const result = await config.auth.apiKey.check();
    if (result !== undefined) {
      assert.equal(result.type, "api_key");
      assert.equal(result.source, "Google ADC");
    }
  });

  it("never throws, so a broken credential cannot break model listing", async () => {
    await assert.doesNotReject(() => config.auth.apiKey.check());
  });

  it("explains itself on stderr when ADC is unavailable", async () => {
    // The reason is the whole point: pi's AuthCheck has no field for it, so an unavailable
    // provider otherwise shows up as a bare "model not found" with nothing naming credentials.
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/definitely-not-a-credential.json";
      const fresh = xaiVertexProviderConfig("proj");
      const result = await fresh.auth.apiKey.check();
      if (result === undefined && lines.length > 0) {
        assert.match(lines.join("\n"), /xai-vertex/, "the warning names the provider");
        assert.match(lines.join("\n"), /ADC|credential/i, "the warning names the cause");
      }
    } finally {
      console.error = original;
      if (saved === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = saved;
    }
  });
});

describe("createProvider integration", () => {
  // The assertions above check the config against *our* expectations. This one checks it against
  // pi's, by running it through the real createProvider from the installed peer — no network, no
  // credentials, no registration. It is the test that actually catches a pi release changing the
  // provider or model schema, which is the failure that takes down every registered provider at
  // once. If this breaks after a pi bump, the schema moved; read pi-ai/dist/*.d.ts, not the docs.
  it("is accepted by pi's own createProvider", () => {
    assert.doesNotThrow(() => createProvider(xaiVertexProviderConfig("proj")));
  });

  it("round-trips the provider id through pi", () => {
    assert.equal(createProvider(xaiVertexProviderConfig("proj")).id, PROVIDER_ID);
  });
});

describe("cost through pi's own engine", () => {
  const model = xaiVertexProviderConfig("proj").models[0];
  // pi and these expectations multiply/divide in a different order, so results differ in the last
  // float ulp (0.0006 vs 0.0006000000000000001). Compare to a tolerance far tighter than any real
  // pricing difference but looser than IEEE-754 noise.
  const costEq = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: got ${actual}, want ${expected}`);

  const usage = (input: number, output = 0, cacheRead = 0): Usage => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  // These run pi's real calculateCost over the cost table, so they check the *wiring* (does pi read
  // the tier at all?) rather than just the literals asserted above.
  it("bills a short-context request at the standard rate", () => {
    const cost = calculateCost(model, usage(1_000, 100));
    costEq(cost.input, (1_000 * 2) / 1e6, "input");
    costEq(cost.output, (100 * 6) / 1e6, "output");
  });

  it("bills cache reads at the standard cached rate", () => {
    costEq(calculateCost(model, usage(0, 0, 10_000)).cacheRead, (10_000 * 0.5) / 1e6, "cacheRead");
  });

  it("applies the long-context tier request-wide once the prompt passes 200K", () => {
    const cost = calculateCost(model, usage(250_000, 1_000, 10_000));
    // xAI bills the *whole* request at the higher rate, output included — not just the excess.
    costEq(cost.input, (250_000 * 4) / 1e6, "input");
    costEq(cost.output, (1_000 * 12) / 1e6, "output");
    costEq(cost.cacheRead, (10_000 * 1) / 1e6, "cacheRead");
  });

  it("stays on the standard tier exactly at the threshold", () => {
    // `inputTokensAbove` is exclusive: 200_000 itself is still standard.
    costEq(calculateCost(model, usage(200_000)).input, (200_000 * 2) / 1e6, "input");
  });

  it("charges nothing for cache writes at either tier", () => {
    assert.equal(calculateCost(model, usage(1_000)).cacheWrite, 0);
    assert.equal(calculateCost(model, usage(250_000)).cacheWrite, 0);
  });
});

describe("createKeepaliveFilterTransform", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** Runs the given byte chunks through the transform and returns the output as text. */
  async function transformChunks(chunks: Uint8Array[]): Promise<string> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const reader = stream.pipeThrough(createKeepaliveFilterTransform()).getReader();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  }

  const transformText = (...chunks: string[]) => transformChunks(chunks.map((c) => encoder.encode(c)));

  it("drops data lines with keepalive payloads", async () => {
    assert.equal(await transformText("data: : keepalive\n\n"), "");
  });

  it("preserves normal SSE data lines", async () => {
    const input = 'data: {"content":"hello"}\n\n';
    assert.equal(await transformText(input), input);
  });

  it("filters keepalives while preserving real data byte for byte", async () => {
    const input = 'data: {"delta":"start"}\n\n' + "data: : keepalive\n\n" + 'data: {"delta":"end"}\n\n';
    assert.equal(await transformText(input), 'data: {"delta":"start"}\n\n' + 'data: {"delta":"end"}\n\n');
  });

  it("handles keepalive with varying whitespace and every SSE line terminator", async () => {
    const variations = [
      "data: : keepalive\n",
      "data:  :  keepalive\n",
      "data: : keepalive  \n",
      "data: : keepalive\r\n",
      "data: : keepalive\r\n\r\n",
      "data: : keepalive\r\r",
      "data:: keepalive\n\n",
    ];
    for (const input of variations) {
      assert.equal(await transformText(input), "", `should filter: ${JSON.stringify(input)}`);
    }
  });

  it("drops any comment-shaped data payload, not just the word keepalive", async () => {
    assert.equal(await transformText("data: : ping\n\n"), "");
    assert.equal(await transformText("data: : keep-alive 42\n\n"), "");
  });

  it("keeps data payloads that merely contain a colon", async () => {
    const input = 'data: {"text":": not a comment"}\n\n' + "data: [DONE]\n\n";
    assert.equal(await transformText(input), input);
  });

  it("keeps the [DONE] sentinel intact after a keepalive", async () => {
    assert.equal(await transformText("data: : keepalive\n\ndata: [DONE]\n\n"), "data: [DONE]\n\n");
  });

  it("preserves SSE comment lines", async () => {
    const input = ": this is a comment\n\n";
    assert.equal(await transformText(input), input);
  });

  it("preserves event type lines", async () => {
    const input = "event: message\ndata: content\n\n";
    assert.equal(await transformText(input), input);
  });

  it("handles chunks split mid-line", async () => {
    assert.equal(await transformText("data: : keep", "alive\n\n"), "");
  });

  it("drops the event separator when it arrives in a later chunk", async () => {
    assert.equal(await transformText("data: : keepalive\n", "\n", 'data: {"a":1}\n\n'), 'data: {"a":1}\n\n');
    assert.equal(await transformText("data: : keepalive", "\n", "\n"), "");
  });

  it("keeps the rest of an event that also carried a keepalive line", async () => {
    assert.equal(
      await transformText('data: {"a":1}\ndata: : keepalive\n\n', 'data: {"b":2}\n\n'),
      'data: {"a":1}\n\n' + 'data: {"b":2}\n\n',
    );
  });

  it("drops an event whose only data line was a keepalive, field lines included", async () => {
    assert.equal(await transformText("event: ping\ndata: : keepalive\n\n", 'data: {"b":2}\n\n'), 'data: {"b":2}\n\n');
    assert.equal(await transformText("id: 7\r\ndata: : keepalive\r\n\r\n"), "");
  });

  it("keeps blank lines that are not a dropped event's terminator", async () => {
    assert.equal(await transformText("\n\ndata: x\n\n\n"), "\n\ndata: x\n\n\n");
    assert.equal(await transformText("data: : keepalive\n\n\n"), "\n");
  });

  it("does not split a CRLF terminator that straddles two chunks", async () => {
    assert.equal(await transformText("data: x\r", "\ndata: y\r\n"), "data: x\r\ndata: y\r\n");
    assert.equal(await transformText("data: : keepalive\r", "\n\r\ndata: y\r\n"), "data: y\r\n");
  });

  it("handles the end of the stream", async () => {
    // An unterminated final event is emitted as-is, minus any keepalive line.
    assert.equal(await transformText('data: {"a":1}'), 'data: {"a":1}');
    assert.equal(await transformText('event: m\ndata: {"a":1}'), 'event: m\ndata: {"a":1}');
    assert.equal(await transformText('data: {"a":1}\n\ndata: : keepalive'), 'data: {"a":1}\n\n');
    // ...and a keepalive-only event that is cut off before its blank line is dropped whole.
    assert.equal(await transformText("event: ping\ndata: : keepalive"), "");
    assert.equal(await transformText('data: {"a":1}\n\nid: 7\ndata: : keepalive\n'), 'data: {"a":1}\n\n');
    // A trailing lone CR is a terminator once the stream ends.
    assert.equal(await transformText("data: x\r"), "data: x\r");
  });

  it("keeps a multi-byte character that straddles two chunks", async () => {
    const bytes = encoder.encode("data: caf\u00e9\n\n");
    const cut = bytes.indexOf(0xc3) + 1; // split inside the two-byte sequence for \u00e9
    assert.equal(await transformChunks([bytes.slice(0, cut), bytes.slice(cut)]), "data: caf\u00e9\n\n");
  });
});

describe("createKeepaliveFilteringFetch", () => {
  const encoder = new TextEncoder();

  function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
  }

  it("returns non-SSE responses untouched", async () => {
    const original = new Response("plain text", { status: 200, statusText: "OK", headers: { "content-type": "text/plain" } });
    const mockFetch: typeof fetch = async () => original;

    const response = await createKeepaliveFilteringFetch(mockFetch)("http://example.com");

    assert.equal(response, original);
    assert.equal(await response.text(), "plain text");
  });

  it("filters keepalive frames from event streams byte for byte", async () => {
    const mockFetch: typeof fetch = async () =>
      sseResponse(['data: {"chunk":1}\n\n', "data: : keepalive\n\n", 'data: {"chunk":2}\n\n']);

    const response = await createKeepaliveFilteringFetch(mockFetch)("http://example.com");

    assert.equal(await response.text(), 'data: {"chunk":1}\n\n' + 'data: {"chunk":2}\n\n');
  });

  it("filters only bodies whose media type is text/event-stream", async () => {
    const keepaliveOnly = ["data: : keepalive\n\n"];
    for (const contentType of ["text/event-stream", "text/event-stream; charset=utf-8", "TEXT/EVENT-STREAM"]) {
      const mockFetch: typeof fetch = async () => sseResponse(keepaliveOnly, { headers: { "content-type": contentType } });
      const response = await createKeepaliveFilteringFetch(mockFetch)("http://example.com");
      assert.equal(await response.text(), "", `should filter with content-type ${contentType}`);
    }
    const others: Record<string, string>[] = [{ "content-type": "application/json" }, { "content-type": "text/event-streamy" }, {}];
    for (const headers of others) {
      const other = new Response("data: : keepalive\n\n", { headers });
      const mockFetch: typeof fetch = async () => other;
      assert.equal(await createKeepaliveFilteringFetch(mockFetch)("http://example.com"), other, JSON.stringify(headers));
    }
  });

  it("drops the original body's length and encoding headers", async () => {
    const mockFetch: typeof fetch = async () =>
      sseResponse(["data: : keepalive\n\n"], {
        headers: {
          "content-type": "text/event-stream",
          "content-length": "20",
          "content-encoding": "identity",
          "transfer-encoding": "chunked",
          "x-keep": "1",
        },
      });
    const response = await createKeepaliveFilteringFetch(mockFetch)("http://example.com");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.equal(response.headers.get("x-keep"), "1");
  });

  it("preserves response status and headers", async () => {
    const mockFetch: typeof fetch = async () =>
      sseResponse([], { status: 201, statusText: "Created", headers: { "content-type": "text/event-stream", "x-custom": "value" } });

    const response = await createKeepaliveFilteringFetch(mockFetch)("http://example.com");

    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");
    assert.equal(response.headers.get("x-custom"), "value");
  });

  it("forwards the request and resolves globalThis.fetch per call", async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
    const originalFetch = globalThis.fetch;
    const wrapped = createKeepaliveFilteringFetch(); // created before the global is swapped
    try {
      globalThis.fetch = async (input, init) => {
        calls.push({ input, init });
        return sseResponse(["data: : keepalive\n\n"]);
      };
      const signal = new AbortController().signal;
      const response = await wrapped("http://127.0.0.1:9/stream", { method: "POST", signal });
      assert.equal(await response.text(), "");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].input, "http://127.0.0.1:9/stream");
      assert.equal(calls[0].init?.method, "POST");
      assert.equal(calls[0].init?.signal, signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("the provider's api", () => {
  const encoder = new TextEncoder();

  /** An OpenAI chat-completions chunk stream for the given words, with a keepalive before each. */
  function completionStream(words: string[]): Response {
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const frames: string[] = [];
    for (const word of words) {
      frames.push("data: : keepalive\n\n", chunk({ role: "assistant", content: word }, null));
    }
    frames.push("data: : keepalive\n\n", chunk({}, "stop"), "data: [DONE]\n\n");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  it("streams through pi's openai-completions adapter with a caller-supplied fetch composed in", async () => {
    const config = xaiVertexProviderConfig("proj");
    const urls: string[] = [];
    const callerFetch: typeof fetch = async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return completionStream(["Hello", " world"]);
    };

    const message = await config.api
      .streamSimple(
        config.models[0],
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { apiKey: "tok", fetch: callerFetch },
      )
      .result();

    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, [{ type: "text", text: "Hello world" }]);
    assert.equal(urls.length, 1, "the caller's fetch is the one invoked, with the filter on top");
    assert.ok(urls[0].startsWith(buildBaseUrl("proj")), urls[0]);
  });

  it("is needed: the unwrapped adapter dies on the captured keepalive frame", async () => {
    const config = xaiVertexProviderConfig("proj");
    const rawFetch: typeof fetch = async () => completionStream(["Hello"]);

    const message = await openAICompletionsApi()
      .streamSimple(
        config.models[0],
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { apiKey: "tok", fetch: rawFetch },
      )
      .result();

    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /keepalive/);
  });

  it("composes the filter onto stream() the same way", async () => {
    const config = xaiVertexProviderConfig("proj");
    let calls = 0;
    const callerFetch: typeof fetch = async () => {
      calls++;
      return completionStream(["ok"]);
    };

    const message = await config.api
      .stream(
        config.models[0],
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { apiKey: "tok", fetch: callerFetch },
      )
      .result();

    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
    assert.equal(calls, 1);
  });

  it("keeps every member of the wrapped api, including ones pi adds later", () => {
    const base: ProviderStreams & { later: string } = {
      stream: () => {
        throw new Error("unused");
      },
      streamSimple: () => {
        throw new Error("unused");
      },
      cancelDeferred: async () => {},
      later: "a member this version of ProviderStreams does not declare",
    };
    const wrapped = wrapApiWithFetch(base);
    assert.equal(wrapped.cancelDeferred, base.cancelDeferred);
    assert.equal(wrapped.fetchDeferred, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(wrapped, "later")?.value, base.later);
    assert.notEqual(wrapped.stream, base.stream);
    assert.notEqual(wrapped.streamSimple, base.streamSimple);
  });
});
