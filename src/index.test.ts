import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, createProvider } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import {
  EXPIRY_SKEW_MS,
  FALLBACK_TTL_MS,
  GROK_4_6_COST,
  MODEL_ID,
  PROJECT_ENV_VARS,
  PROVIDER_ID,
  buildBaseUrl,
  credentialFrom,
  resolveProject,
  xaiVertexProviderConfig,
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

describe("credentialFrom", () => {
  const NOW = 1_000_000_000_000;

  it("uses the credential's real expiry, minus the renewal skew", () => {
    const oneHour = NOW + 3_600_000;
    assert.equal(credentialFrom("tok", oneHour, NOW).expires, oneHour - EXPIRY_SKEW_MS);
  });

  it("falls back to a fixed TTL when the credential exposes no expiry", () => {
    for (const missing of [undefined, null]) {
      assert.equal(credentialFrom("tok", missing, NOW).expires, NOW + FALLBACK_TTL_MS);
    }
  });

  it("falls back rather than returning an already-expired credential", () => {
    assert.equal(credentialFrom("tok", NOW - 1, NOW).expires, NOW + FALLBACK_TTL_MS);
  });

  it("renews strictly before the real expiry", () => {
    const expiry = NOW + 3_600_000;
    assert.ok(credentialFrom("tok", expiry, NOW).expires < expiry);
  });

  it('tags the credential "oauth" — pi rejects the object without it', () => {
    const cred = credentialFrom("tok", null, NOW);
    assert.equal(cred.type, "oauth");
    assert.equal(cred.access, "tok");
    assert.equal(typeof cred.refresh, "string");
  });

  it("throws an actionable error instead of registering an empty token", () => {
    for (const empty of [undefined, null, ""]) {
      assert.throws(() => credentialFrom(empty, NOW + 1000, NOW), /no access token/i);
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

  it("authenticates through pi's oauth block, not a static apiKey", () => {
    assert.ok(config.auth.oauth, "oauth must nest under `auth`, not sit at the top level");
    assert.equal(typeof config.auth.oauth.login, "function");
    assert.equal(typeof config.auth.oauth.refresh, "function", "method is `refresh`, not `refreshToken`");
    assert.equal(typeof config.auth.oauth.toAuth, "function", "method is `toAuth`, not `getApiKey`");
    assert.ok(!("apiKey" in config), "a static apiKey would defeat token renewal");
  });

  it("hands pi a ModelAuth object, not a bare token string", async () => {
    assert.deepEqual(await config.auth.oauth.toAuth({ access: "tok" }), { apiKey: "tok" });
  });

  it("declares exactly the pricing asserted above", () => {
    assert.deepEqual(config.models[0].cost, GROK_4_6_COST);
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
