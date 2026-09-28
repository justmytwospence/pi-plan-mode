import assert from "node:assert/strict";
import { test } from "vitest";
import { formatModelSpec, parseModelSpec } from "../src/implementation-models.js";

test("model specs parse provider, slash-containing model IDs, and known effort suffixes", () => {
  assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-5"), {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
  });
  assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-5:high"), {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    thinkingLevel: "high",
  });
  assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-opus:XHIGH"), {
    provider: "openrouter",
    modelId: "anthropic/claude-opus",
    thinkingLevel: "xhigh",
  });
  assert.deepEqual(parseModelSpec("bedrock/anthropic.claude-v1:0"), {
    provider: "bedrock",
    modelId: "anthropic.claude-v1:0",
  });
  for (const invalid of ["", "no-slash", "/missing-provider", "provider/", 42, undefined]) {
    assert.equal(parseModelSpec(invalid), undefined, String(invalid));
  }
  assert.equal(formatModelSpec({ provider: "a", modelId: "b", thinkingLevel: "low" }), "a/b:low");
  assert.equal(formatModelSpec({ provider: "a", modelId: "b" }), "a/b");
});
