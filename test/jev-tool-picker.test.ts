import assert from "node:assert/strict";
import { test } from "vitest";
import { pickToolsWithJev, type ToolCapability } from "../src/jev-tool-picker.js";

const CAPABILITIES: ToolCapability[] = [
  { id: "shell", label: "Shell", description: "git and rg", fallbackSelected: true },
  { id: "toolset:web", label: "Web research", description: "search the web", fallbackSelected: true },
  { id: "toolset:mcp", label: "MCP servers", description: "notes and docs", fallbackSelected: false },
];

function fakeSdk(behavior: (request: Record<string, unknown>, options: Record<string, unknown>) => unknown) {
  const calls: Array<{ config: unknown; request: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const sdk = {
    noul: (instructions: unknown, criteria: unknown) => ({ type: "noul", instructions, criteria }),
    TypeSafeClient: class {
      constructor(readonly config: unknown) {}
      async systemOne(request: Record<string, unknown>, options: Record<string, unknown>) {
        calls.push({ config: this.config, request, options });
        return behavior(request, options);
      }
    },
  };
  return { loadSdk: async () => sdk as never, calls };
}

const env = { TYPESAFE_API_KEY: "test-key" };

test("Jev preselects capabilities at the threshold from one request", async () => {
  const { loadSdk, calls } = fakeSdk(() => ({
    model: "jev-1.13.0",
    answers: { c0: { type: "noul", noul: 0.84 }, c1: { type: "noul", noul: 0.49 }, c2: { type: "noul", noul: 0.93 } },
  }));
  const pick = await pickToolsWithJev({
    task: "Build onboarding from the Figma file and my Obsidian notes",
    conversation: "",
    cwd: "/work/my-app",
    capabilities: CAPABILITIES,
    env,
    loadSdk,
  });
  assert.deepEqual(pick, {
    kind: "jev",
    model: "jev-1.13.0",
    probabilities: { shell: 0.84, "toolset:web": 0.49, "toolset:mcp": 0.93 },
    selected: { shell: true, "toolset:web": false, "toolset:mcp": true },
  });
  assert.equal(calls.length, 1);
  const request = calls[0]?.request as {
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, { instructions: { capability: { name: string; provides: string } } }>;
  };
  assert.equal(request.model, "jev-latest");
  assert.deepEqual(request.state, {
    task: "Build onboarding from the Figma file and my Obsidian notes",
    working_directory: "my-app",
  });
  assert.deepEqual(request.questions.c2?.instructions.capability, { name: "MCP servers", provides: "notes and docs" });
  assert.deepEqual(calls[0]?.options?.retry, { maxRetries: 1 });
  assert.equal((calls[0]?.config as { logLevel?: string } | undefined)?.logLevel, "off");

  const strict = await pickToolsWithJev({
    task: "x",
    conversation: "",
    cwd: "/w",
    capabilities: CAPABILITIES,
    threshold: 0.9,
    model: "jev-1.13.0",
    env,
    loadSdk,
  });
  assert.deepEqual(strict.kind === "jev" ? strict.selected : undefined, {
    shell: false,
    "toolset:web": false,
    "toolset:mcp": true,
  });
  assert.equal((calls[1]?.request as { model: string } | undefined)?.model, "jev-1.13.0");
});

test("Jev falls back gracefully without a key, a task, the SDK, or a usable answer", async () => {
  const neverCalled = fakeSdk(() => {
    throw new Error("should not be called");
  });
  const base = { task: "t", conversation: "", cwd: "/w", capabilities: CAPABILITIES, loadSdk: neverCalled.loadSdk };
  assert.deepEqual(await pickToolsWithJev({ ...base, env: {} }), {
    kind: "fallback",
    reason: "TYPESAFE_API_KEY is not set",
  });
  assert.deepEqual(await pickToolsWithJev({ ...base, env: { TYPESAFE_API_KEY: "  " } }), {
    kind: "fallback",
    reason: "TYPESAFE_API_KEY is not set",
  });
  assert.equal((await pickToolsWithJev({ ...base, task: " ", env })).kind, "fallback");
  assert.equal(neverCalled.calls.length, 0);

  const missingSdk = await pickToolsWithJev({
    ...base,
    env,
    loadSdk: async () => {
      throw new Error("Cannot find module");
    },
  });
  assert.match(missingSdk.kind === "fallback" ? missingSdk.reason : "", /SDK is not installed/u);

  const unauthorized = fakeSdk(() => {
    throw Object.assign(new Error("Unauthorized"), { name: "AuthenticationError", status: 401 });
  });
  const denied = await pickToolsWithJev({ ...base, env, loadSdk: unauthorized.loadSdk });
  assert.deepEqual(denied, { kind: "fallback", reason: "Jev is unavailable (invalid API key)" });

  const timeout = fakeSdk(() => {
    throw Object.assign(new Error("Request timed out"), { name: "APITimeoutError" });
  });
  assert.deepEqual(await pickToolsWithJev({ ...base, env, loadSdk: timeout.loadSdk }), {
    kind: "fallback",
    reason: "Jev is unavailable (timed out)",
  });

  const malformed = fakeSdk(() => ({ model: "jev", answers: { c0: { noul: 0.9 }, c1: { noul: "yes" } } }));
  assert.deepEqual(await pickToolsWithJev({ ...base, env, loadSdk: malformed.loadSdk }), {
    kind: "fallback",
    reason: "Jev returned an unexpected answer",
  });
});

test("Jev judges from the conversation when there is no explicit task", async () => {
  const { loadSdk, calls } = fakeSdk(() => ({
    model: "jev",
    answers: { c0: { noul: 1 }, c1: { noul: 0 }, c2: { noul: 0 } },
  }));
  await pickToolsWithJev({
    task: "",
    conversation: `User: ${"x".repeat(5_000)} upgrade React Router`,
    cwd: "/w",
    capabilities: CAPABILITIES,
    env,
    loadSdk,
  });
  const state = calls[0]?.request?.state as { task: string; conversation: string };
  assert.match(state.task, /discussed in `conversation`/u);
  assert.ok(state.conversation.length <= 3_000);
  assert.match(state.conversation, /upgrade React Router$/u);
});
