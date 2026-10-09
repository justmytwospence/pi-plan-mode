import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelSpec } from "../src/implementation-models.js";
import { type LaneCommandAgent, matchingCommands, runLaneCommand } from "../src/lane-commands.js";

function setup(extra: Partial<LaneCommandAgent> = {}) {
  const notes: string[] = [];
  const calls: string[] = [];
  const agent: LaneCommandAgent = {
    id: "A",
    spec: { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "high" },
    name: "Claude Sonnet 5.5",
    working: false,
    status: "idle",
    plan: undefined,
    lastReply: "the reply",
    stats: { totalTokens: 12_345, costUsd: 0.5 },
    note: (text) => notes.push(text),
    switchModel: async (spec: ModelSpec, name: string) => {
      calls.push(`model ${spec.provider}/${spec.modelId}:${spec.thinkingLevel ?? "-"} ${name}`);
    },
    setEffort: (level) => calls.push(`effort ${level}`),
    compact: async (instructions) => {
      calls.push(`compact ${instructions ?? ""}`);
    },
    contextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    ...extra,
  };
  const host = {
    models: () => [
      { spec: { provider: "anthropic", modelId: "claude-opus-5-5" }, name: "Claude Opus 5.5" },
      { spec: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, name: "Claude Sonnet 5.5" },
      { spec: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, name: "GPT-6.1 Sol" },
    ],
    efforts: (spec: ModelSpec) =>
      (spec.provider === "openai-codex" ? (["low", "xhigh"] as const) : (["low", "high"] as const)).slice(),
    login: (_agent: LaneCommandAgent, provider: string) => calls.push(`login ${provider}`),
    copy: async (text: string) => {
      calls.push(`copy ${text}`);
    },
  };
  return { agent, host, notes, calls };
}

test("ordinary messages are not commands, and // sends a slash", async () => {
  const { agent, host, calls } = setup();
  assert.equal(await runLaneCommand("why this cache?", agent, host), false);
  assert.equal(await runLaneCommand("//etc/hosts is fine", agent, host), false);
  assert.deepEqual(calls, []);
});

test("/model switches by a loose query, keeping the effort when the new model has it", async () => {
  const { agent, host, notes, calls } = setup();
  assert.ok(await runLaneCommand("/model opus", agent, host));
  assert.ok(await runLaneCommand("/model gpt sol", agent, host));
  assert.ok(await runLaneCommand("/model claude", agent, host));
  assert.ok(await runLaneCommand("/model", agent, host));
  assert.deepEqual(calls, [
    "model anthropic/claude-opus-5-5:high Claude Opus 5.5",
    "model openai-codex/gpt-6.1-sol:- GPT-6.1 Sol",
  ]);
  assert.match(notes[0] ?? "", /"claude" matches 2/u);
  assert.match(notes[1] ?? "", /^Model: Claude Sonnet 5\.5\. Switch with \/model <query>/u);
});

test("/thinking, /compact, /context, /copy, /login and /help", async () => {
  const { agent, host, notes, calls } = setup();
  await runLaneCommand("/thinking", agent, host);
  await runLaneCommand("/effort low", agent, host);
  await runLaneCommand("/thinking max", agent, host);
  await runLaneCommand("/compact keep the API notes", agent, host);
  await runLaneCommand("/context", agent, host);
  await runLaneCommand("/copy", agent, host);
  await runLaneCommand("/login", agent, host);
  await runLaneCommand("/login openai-codex", agent, host);
  await runLaneCommand("/help", agent, host);
  await runLaneCommand("/tree", agent, host);
  assert.deepEqual(calls, [
    "effort low",
    "compact keep the API notes",
    "copy the reply",
    "login anthropic",
    "login openai-codex",
  ]);
  assert.match(notes[0] ?? "", /Effort: high\. Levels: low, high\./u);
  assert.match(notes[1] ?? "", /takes low, high/u);
  assert.match(notes[2] ?? "", /context 50k of 200k \(25%\) · 12k tokens used · \$0\.50/u);
  assert.match(notes[3] ?? "", /Copied its last reply/u);
  assert.match(notes[4] ?? "", /^Commands: \/login \[provider\], \/model \[query\]/u);
  assert.match(notes[5] ?? "", /^Unknown command \/tree\./u);
});

test("commands that change a planner wait until it is idle, and failures are reported", async () => {
  const busy = setup({ working: true });
  await runLaneCommand("/model opus", busy.agent, busy.host);
  await runLaneCommand("/compact", busy.agent, busy.host);
  await runLaneCommand("/context", busy.agent, busy.host);
  assert.deepEqual(busy.calls, []);
  assert.equal(busy.notes.filter((note) => /is working; wait/u.test(note)).length, 2);
  const failing = setup({
    switchModel: async () => {
      throw new Error("not available");
    },
  });
  await runLaneCommand("/model opus", failing.agent, failing.host);
  assert.match(failing.notes[0] ?? "", /\/model failed: not available/u);
});

test("the hint lists the commands that match what you typed", () => {
  assert.deepEqual(
    matchingCommands("/co").map((command) => command.name),
    ["compact", "context", "copy"],
  );
  assert.deepEqual(
    matchingCommands("/eff").map((command) => command.name),
    ["thinking"],
  );
});
