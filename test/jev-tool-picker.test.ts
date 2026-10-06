import assert from "node:assert/strict";
import { test } from "vitest";
import { pickToolsWithJev, type ToolCapability } from "../src/jev-tool-picker.js";
import { applyAlwaysOffer, applyJevPick, buildToolTree, leaves, offerNames } from "../src/tool-tree.js";

const CAPABILITIES: ToolCapability[] = [
  { id: "shell", label: "Shell", description: "git and rg", fallbackSelected: true },
  { id: "toolset:web", label: "Web research", description: "search the web", fallbackSelected: true },
  { id: "toolset:mcp", label: "MCP servers", description: "notes and docs", fallbackSelected: false },
];

type Call = {
  model: unknown;
  context: { state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string }> };
  options: Record<string, unknown>;
};

function fakeRegistry(behavior: (call: Call) => unknown, options: { model?: boolean } = {}) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const registry = {
    findOfType: (type: string, provider: string, id: string) => {
      lookups.push(`${type}:${provider}/${id}`);
      return options.model === false ? undefined : { type, provider, id };
    },
    classify: async (model: unknown, context: Call["context"], opts: Record<string, unknown>) => {
      const call = { model, context, options: opts };
      calls.push(call);
      return behavior(call);
    },
  };
  return { registry: registry as never, calls, lookups };
}

const bools = (values: Record<string, unknown>) => ({
  stopReason: "stop",
  model: "jev-latest",
  answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "bool", probability: v }])),
});

test("Jev preselects capabilities at the threshold from one request", async () => {
  const { registry, calls, lookups } = fakeRegistry(() => bools({ c0: 0.84, c1: 0.49, c2: 0.93 }));
  const pick = await pickToolsWithJev({
    task: "Build onboarding from the Figma file and my Obsidian notes",
    conversation: "",
    cwd: "/work/my-app",
    capabilities: CAPABILITIES,
    registry,
  });
  assert.deepEqual(pick, {
    kind: "jev",
    model: "jev-latest",
    probabilities: { shell: 0.84, "toolset:web": 0.49, "toolset:mcp": 0.93 },
    selected: { shell: true, "toolset:web": false, "toolset:mcp": true },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(lookups, ["classifier:typesafe/jev-latest"]);
  assert.deepEqual(calls[0]?.context.state, {
    task: "Build onboarding from the Figma file and my Obsidian notes",
    working_directory: "my-app",
  });
  assert.equal(calls[0]?.context.questions.c2?.type, "bool");
  assert.match(calls[0]?.context.questions.c2?.instructions ?? "", /"MCP servers" gives the agents: notes and docs/u);
  assert.equal(calls[0]?.options.timeoutMs, 4_000);

  const strict = await pickToolsWithJev({
    task: "x",
    conversation: "",
    cwd: "/w",
    capabilities: CAPABILITIES,
    threshold: 0.9,
    provider: "openrouter",
    model: "typesafe/jev-1.13",
    registry,
  });
  assert.deepEqual(strict.kind === "jev" ? strict.selected : undefined, {
    shell: false,
    "toolset:web": false,
    "toolset:mcp": true,
  });
  assert.equal(lookups[1], "classifier:openrouter/typesafe/jev-1.13");
});

test("Jev falls back gracefully without a classifier, a task, credentials, or a usable answer", async () => {
  const missing = fakeRegistry(
    () => {
      throw new Error("should not be called");
    },
    { model: false },
  );
  const base = { task: "t", conversation: "", cwd: "/w", capabilities: CAPABILITIES };
  assert.deepEqual(await pickToolsWithJev({ ...base, registry: missing.registry }), {
    kind: "fallback",
    reason: "no classifier model typesafe/jev-latest",
  });
  assert.equal((await pickToolsWithJev({ ...base, task: " ", registry: missing.registry })).kind, "fallback");
  assert.equal(missing.calls.length, 0);

  const noKey = fakeRegistry(() => ({
    stopReason: "error",
    errorMessage: "No API key for provider: typesafe",
    answers: {},
  }));
  assert.deepEqual(await pickToolsWithJev({ ...base, registry: noKey.registry }), {
    kind: "fallback",
    reason: "Jev is unavailable (no TypeSafe credentials)",
  });

  const denied = fakeRegistry(() => ({
    stopReason: "error",
    errorMessage: "System One API returned 401",
    answers: {},
  }));
  assert.deepEqual(await pickToolsWithJev({ ...base, registry: denied.registry }), {
    kind: "fallback",
    reason: "Jev is unavailable (invalid API key)",
  });

  const timeout = fakeRegistry(() => ({
    stopReason: "error",
    errorMessage: "Request timed out after 4000ms",
    answers: {},
  }));
  assert.deepEqual(await pickToolsWithJev({ ...base, registry: timeout.registry }), {
    kind: "fallback",
    reason: "Jev is unavailable (timed out)",
  });

  const aborted = fakeRegistry(() => ({ stopReason: "aborted", answers: {} }));
  assert.deepEqual(await pickToolsWithJev({ ...base, registry: aborted.registry }), {
    kind: "fallback",
    reason: "Jev is unavailable (cancelled)",
  });

  const malformed = fakeRegistry(() => bools({ c0: 0.9, c1: "yes" }));
  assert.deepEqual(await pickToolsWithJev({ ...base, registry: malformed.registry }), {
    kind: "fallback",
    reason: "Jev returned an unexpected answer",
  });
});

test("Jev judges from the conversation when there is no explicit task", async () => {
  const { registry, calls } = fakeRegistry(() => bools({ c0: 1, c1: 0, c2: 0 }));
  await pickToolsWithJev({
    task: "",
    conversation: `User: ${"x".repeat(5_000)} upgrade React Router`,
    cwd: "/w",
    capabilities: CAPABILITIES,
    registry,
  });
  const state = calls[0]?.context.state as { task: string; conversation: string };
  assert.match(state.task, /discussed in `conversation`/u);
  assert.ok(state.conversation.length <= 3_000);
  assert.match(state.conversation, /upgrade React Router$/u);
});

test("tools in alwaysOffer start selected, show it, and Jev scores but never deselects them", () => {
  const roots = buildToolTree({
    toolsets: {
      web: {
        label: "Web research",
        extensions: [],
        tools: ["web_search", "fetch_content"],
        enabled: false,
        scouts: false,
      },
      mcp: { label: "MCP", extensions: [], tools: ["codemode"], mcp: true, enabled: false, scouts: false },
    },
    mcpCatalog: [
      {
        name: "context7",
        known: true,
        tools: [
          { name: "resolve-library-id", description: "ids", readOnly: true },
          { name: "query-docs", description: "docs", readOnly: true },
        ],
      },
      { name: "paperless", known: true, tools: [{ name: "search", description: "docs", readOnly: true }] },
    ] as never,
    scoutTargets: [],
    grants: { jev: { label: "Jev judgments", commands: ["jev-ask"], skills: [], enabled: false, planMode: true } },
  });
  applyAlwaysOffer(roots, ["web", "jev", "context7"]);
  const leaf = (id: string) => leaves(roots).find((candidate) => candidate.id === id);
  for (const id of [
    "toolset:web/web_search",
    "toolset:web/fetch_content",
    "grant:jev",
    "mcp:context7/resolve-library-id",
    "mcp:context7/query-docs",
  ]) {
    assert.equal(leaf(id)?.selected, true, id);
    assert.equal(leaf(id)?.always, true, id);
  }
  assert.equal(leaf("mcp:paperless/search")?.selected, false);

  const probabilities = Object.fromEntries(leaves(roots).map((candidate) => [candidate.id, 0.1]));
  applyJevPick(roots, {
    kind: "jev",
    model: "jev",
    probabilities,
    selected: Object.fromEntries(leaves(roots).map((candidate) => [candidate.id, false])),
  });
  assert.equal(leaf("toolset:web/web_search")?.selected, true, "Jev leaves it on");
  assert.equal(leaf("toolset:web/web_search")?.jev, 0.1, "but still scores it");

  // One tool of a group, by group/tool.
  const single = buildToolTree({
    toolsets: {
      web: { label: "Web", extensions: [], tools: ["web_search", "fetch_content"], enabled: false, scouts: false },
    },
    mcpCatalog: [],
    scoutTargets: [],
  });
  applyAlwaysOffer(single, ["web/web_search"]);
  assert.deepEqual(
    leaves(single)
      .filter((candidate) => candidate.selected && candidate.id.startsWith("toolset:"))
      .map((candidate) => candidate.id),
    ["toolset:web/web_search"],
  );
  assert.deepEqual(offerNames({ id: "mcp:context7/query-docs", label: "query-docs", description: "" }), [
    "context7/query-docs",
    "context7",
    "query-docs",
  ]);
});

test("Jev is asked whether a tool makes the plan better informed, not whether the plan depends on it", async () => {
  let request: { questions: Record<string, { instructions: string; criteria: Record<string, string> }> } | undefined;
  await pickToolsWithJev({
    task: "add a cache",
    conversation: "",
    cwd: "/repo",
    capabilities: [{ id: "web", label: "web_search", description: "Search the web", fallbackSelected: false }],
    registry: {
      findOfType: () => ({ id: "jev" }) as never,
      classify: async (_model: unknown, input: unknown) => {
        request = input as never;
        return { stopReason: "stop", model: "jev", answers: { c0: { type: "bool", probability: 0.9 } } } as never;
      },
    },
  });
  const question = request?.questions.c0;
  assert.match(question?.instructions ?? "", /better informed or more correct/u);
  assert.doesNotMatch(question?.instructions ?? "", /materially benefit/u);
  assert.match(question?.criteria.false ?? "", /nothing relevant to offer/u);
});
