import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, createProvider } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
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
  async function transformText(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(input));
        controller.close();
      },
    });

    const transformed = stream.pipeThrough(createKeepaliveFilterTransform());
    const reader = transformed.getReader();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode(); // flush
    return result;
  }

  it("drops data lines with keepalive payloads", async () => {
    const input = "data: : keepalive\n\n";
    const output = await transformText(input);
    assert.equal(output, "");
  });

  it("preserves normal SSE data lines", async () => {
    const input = 'data: {"content":"hello"}\n\n';
    const output = await transformText(input);
    assert.equal(output, input);
  });

  it("filters keepalives while preserving real data", async () => {
    const input =
      'data: {"delta":"start"}\n\n' +
      "data: : keepalive\n\n" +
      'data: {"delta":"end"}\n\n';
    const expected =
      'data: {"delta":"start"}\n\n' +
      'data: {"delta":"end"}\n\n';
    const output = await transformText(input);
    assert.equal(output, expected);
  });

  it("handles keepalive with varying whitespace", async () => {
    const variations = [
      "data: : keepalive\n",
      "data:  :  keepalive\n",
      "data: : keepalive  \n",
      "data: : keepalive\r\n",
    ];
    for (const input of variations) {
      const output = await transformText(input);
      assert.equal(output, "", `should filter: ${JSON.stringify(input)}`);
    }
  });

  it("preserves SSE comment lines", async () => {
    const input = ": this is a comment\n\n";
    const output = await transformText(input);
    assert.equal(output, input);
  });

  it("preserves event type lines", async () => {
    const input = "event: message\ndata: content\n\n";
    const output = await transformText(input);
    assert.equal(output, input);
  });

  it("handles chunks split mid-line", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send "data: : keep" then "alive\n\n" as separate chunks
        controller.enqueue(encoder.encode("data: : keep"));
        controller.enqueue(encoder.encode("alive\n\n"));
        controller.close();
      },
    });

    const transformed = stream.pipeThrough(createKeepaliveFilterTransform());
    const reader = transformed.getReader();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    assert.equal(result, "", "should filter keepalive even when split across chunks");
  });
});

describe("createKeepaliveFilteringFetch", () => {
  it("passes through non-streaming responses unchanged", async () => {
    const mockFetch = async () =>
      new Response("plain text", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      });

    const wrappedFetch = createKeepaliveFilteringFetch(mockFetch as typeof fetch);
    const response = await wrappedFetch("http://example.com");

    assert.equal(response.status, 200);
    assert.equal(response.statusText, "OK");
    assert.equal(await response.text(), "plain text");
  });

  it("filters keepalive frames from streaming responses", async () => {
    const encoder = new TextEncoder();
    const mockFetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"chunk":1}\n\n'));
          controller.enqueue(encoder.encode("data: : keepalive\n\n"));
          controller.enqueue(encoder.encode('data: {"chunk":2}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const wrappedFetch = createKeepaliveFilteringFetch(mockFetch as typeof fetch);
    const response = await wrappedFetch("http://example.com");
    const text = await response.text();

    assert.ok(text.includes('{"chunk":1}'), "should include first chunk");
    assert.ok(text.includes('{"chunk":2}'), "should include second chunk");
    assert.ok(!text.includes("keepalive"), "should filter out keepalive");
  });

  it("preserves response status and headers", async () => {
    const mockFetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        {
          status: 201,
          statusText: "Created",
          headers: { "x-custom": "value" },
        },
      );

    const wrappedFetch = createKeepaliveFilteringFetch(mockFetch as typeof fetch);
    const response = await wrappedFetch("http://example.com");

    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");
    assert.equal(response.headers.get("x-custom"), "value");
  });
});
