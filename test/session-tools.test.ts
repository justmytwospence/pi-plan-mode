import assert from "node:assert/strict";
import { test } from "vitest";
import type { PickToolsInput } from "../src/jev-tool-picker.js";
import type { McpServerCatalog } from "../src/mcp-tools.js";
import planMode from "../src/plan-mode.js";
import { buildSessionToolTree, leafCapabilities, leaves, sessionToolChoice } from "../src/tool-tree.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const CATALOG: McpServerCatalog[] = [
  {
    name: "context7",
    known: true,
    tools: [
      { name: "query-docs", toolName: "mcp__context7__query-docs", description: "Query library docs" },
      { name: "resolve-library-id", toolName: "mcp__context7__resolve-library-id", description: "Find a library" },
    ],
  },
  {
    name: "obsidian",
    known: true,
    tools: [{ name: "delete_note", toolName: "mcp__obsidian__delete_note", description: "Delete a note" }],
  },
];

const TOOLSETS = {
  web: {
    label: "Web research",
    extensions: [],
    tools: ["web_search", "fetch_content"],
    enabled: true,
    scouts: false,
  },
  mcp: { label: "MCP servers", mcp: true, extensions: [], tools: ["codemode"], enabled: false, scouts: false },
};

const GRANTS = {
  nb: {
    label: "Notebooks",
    description: "Run notebook code",
    commands: ["bash nb.sh"],
    skills: [],
    enabled: false,
    planMode: false,
  },
};

const SESSION_TOOLS = [
  { name: "read", builtin: true },
  { name: "bash", builtin: true },
  { name: "grep", builtin: true },
  { name: "web_search", builtin: false },
  { name: "fetch_content", builtin: false },
  { name: "codemode", builtin: false },
  { name: "custom", builtin: false },
];

test("the session tool tree mirrors the planners' tree and Jev only scores what you opted into", () => {
  const roots = buildSessionToolTree({
    tools: SESSION_TOOLS,
    defaults: new Set(["read", "bash", "grep", "web_search", "codemode"]),
    toolsets: TOOLSETS,
    mcpCatalog: CATALOG,
    grants: GRANTS,
  });
  assert.deepEqual(
    roots.map((root) => root.label),
    ["Shell", "Web research", "MCP servers", "Other tools"],
  );
  const selected = Object.fromEntries(leaves(roots).map((leaf) => [leaf.id, leaf.selected]));
  assert.deepEqual(selected, {
    "tool:bash": true,
    "grant:nb": false,
    "tool:web_search": true,
    "tool:fetch_content": false,
    "mcp:context7/query-docs": true,
    "mcp:context7/resolve-library-id": true,
    "mcp:obsidian/delete_note": true,
    "tool:read": true,
    "tool:grep": true,
    "tool:custom": false,
  });
  // Built-ins and an extension tool you never enabled are never Jev's to change.
  assert.deepEqual(
    leafCapabilities(roots).map((capability) => capability.id),
    [
      "grant:nb",
      "tool:web_search",
      "tool:fetch_content",
      "mcp:context7/query-docs",
      "mcp:context7/resolve-library-id",
      "mcp:obsidian/delete_note",
    ],
  );

  // Every MCP tool selected: MCP is not restricted.
  assert.equal(sessionToolChoice(roots).mcpAllow, undefined);
  const byId = new Map(leaves(roots).map((leaf) => [leaf.id, leaf]));
  const set = (id: string, value: boolean) => {
    const leaf = byId.get(id);
    assert.ok(leaf, id);
    leaf.selected = value;
  };
  set("mcp:obsidian/delete_note", false);
  set("mcp:context7/resolve-library-id", false);
  set("tool:bash", false);
  set("grant:nb", true);
  const choice = sessionToolChoice(roots);
  assert.deepEqual(choice.mcpAllow, ["context7/query-docs"]);
  assert.deepEqual(choice.grants, ["nb"]);
  // A granted command runs through bash, so bash comes back on.
  assert.deepEqual(choice.names.sort(), ["bash", "codemode", "grep", "read", "web_search"]);
});

function fixture(options: { jev?: boolean; pickSelected?: Record<string, boolean> } = {}) {
  const mock = createMockPi({
    activeTools: ["read", "bash", "web_search", "fetch_content", "codemode"],
    allTools: [
      builtinTool("read"),
      builtinTool("bash"),
      extensionTool("web_search"),
      extensionTool("fetch_content"),
      // Pi's built-in extensions report their tools as built-in; Plan mode treats them as opt-in.
      { name: "codemode", sourceInfo: { source: "builtin", scope: "temporary", path: "builtin:codemode" } },
      ...["mcp__context7__query-docs", "mcp__context7__resolve-library-id", "mcp__obsidian__delete_note"].map(
        (name) => ({
          name,
          exposure: "codemode",
          namespace: { name: name.split("__").slice(0, 2).join("__") },
          sourceInfo: { source: "builtin", scope: "temporary", path: "builtin:mcp" },
        }),
      ),
    ],
  });
  const pickCalls: PickToolsInput[] = [];
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        defaultPlanTools: ["read", "bash", "web_search", "fetch_content", "codemode"],
        plannerToolsets: TOOLSETS,
        commandGrants: GRANTS,
        ...(options.jev === false ? { jevToolSelection: false } : {}),
      },
    }),
    readMcpCatalog: () => CATALOG,
    pickTools: async (input) => {
      pickCalls.push(input);
      const selected = options.pickSelected ?? {
        "tool:bash": true,
        "grant:nb": false,
        "tool:web_search": false,
        "tool:fetch_content": false,
        "mcp:context7/query-docs": true,
        "mcp:context7/resolve-library-id": false,
        "mcp:obsidian/delete_note": false,
      };
      return {
        kind: "jev" as const,
        model: "jev-test",
        probabilities: Object.fromEntries(Object.entries(selected).map(([id, on]) => [id, on ? 0.9 : 0.1])),
        selected,
      };
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true });
  const state = () =>
    mock.entries.at(-1)?.data as
      | {
          workflowToolPolicy?: { allowedNames: string[] };
          workflowToolChoice?: { mcpAllow?: string[]; jevPending?: boolean; jevScores?: Record<string, number> };
        }
      | undefined;
  const firstPrompt = async (prompt: string) => {
    for (const handler of mock.events.get("before_agent_start") ?? []) {
      await handler({ prompt, systemPrompt: "system" }, context.ctx);
    }
  };
  const toolCall = async (toolName: string, input: unknown) => {
    for (const handler of mock.events.get("tool_call") ?? []) {
      const verdict = await handler({ toolName, input }, context.ctx);
      if (verdict) return verdict as { block?: boolean; reason?: string };
    }
    return undefined;
  };
  return { mock, context, pickCalls, state, firstPrompt, toolCall };
}

test("Jev picks Plan mode's tools at the first prompt, once, and the MCP guard follows its pick", async () => {
  const { mock, context, pickCalls, state, firstPrompt, toolCall } = fixture();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(state()?.workflowToolChoice?.jevPending, true);
  assert.deepEqual([...(state()?.workflowToolPolicy?.allowedNames ?? [])].sort(), [
    "bash",
    "codemode",
    "fetch_content",
    "read",
    "web_search",
  ]);

  await firstPrompt("Upgrade the docs to the new React API");
  assert.equal(pickCalls.length, 1);
  assert.equal(pickCalls[0]?.task, "Upgrade the docs to the new React API");
  assert.deepEqual([...(state()?.workflowToolPolicy?.allowedNames ?? [])].sort(), ["bash", "codemode", "read"]);
  assert.deepEqual(state()?.workflowToolChoice?.mcpAllow, ["context7/query-docs"]);
  assert.equal(state()?.workflowToolChoice?.jevPending, undefined);
  assert.equal(state()?.workflowToolChoice?.jevScores?.["mcp:context7/query-docs"], 0.9);
  assert.match(
    context.notifications.at(-1)?.message ?? "",
    /Jev picked this plan's tools: Shell 1\/2 · MCP servers 1\/3 · Other tools\./u,
  );

  await firstPrompt("A follow-up");
  assert.equal(pickCalls.length, 1, "Jev picks once per workflow");

  // Codemode scripts call MCP tools, which are never active; the allowlist gates each call.
  assert.equal(await toolCall("mcp__context7__query-docs", {}), undefined);
  const blocked = await toolCall("mcp__obsidian__delete_note", {});
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /context7\/query-docs/u);
  assert.equal((await toolCall("web_search", { query: "x" }))?.block, true);

  const contextResult = (await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx)) as
    | { messages: Array<{ customType?: string; content?: string }> }
    | undefined;
  const note = contextResult?.messages.find((message) => message.customType === "plan-mode-mcp-tools");
  assert.match(note?.content ?? "", /only these MCP tools .*: context7\/query-docs/u);
});

test("/plan <prompt> uses Jev too; turning it off keeps the defaults", async () => {
  for (const jev of [true, false]) {
    const { mock, context, pickCalls, state, firstPrompt } = fixture({ jev });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    await mock.commands.get("plan")?.handler("Audit the retry logic", context.ctx);
    assert.equal(mock.sentUserMessages.at(-1)?.text, "Audit the retry logic");
    await firstPrompt("Audit the retry logic");
    assert.equal(pickCalls.length, jev ? 1 : 0);
    assert.deepEqual(
      [...(state()?.workflowToolPolicy?.allowedNames ?? [])].sort(),
      jev ? ["bash", "codemode", "read"] : ["bash", "codemode", "fetch_content", "read", "web_search"],
    );
  }
});

test("a granted command Jev picks lets bash run it in Plan mode", async () => {
  const { mock, context, firstPrompt, toolCall } = fixture({
    pickSelected: { "tool:bash": false, "grant:nb": true },
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal((await toolCall("bash", { command: "bash nb.sh" }))?.block, true, "not granted before Jev");
  await firstPrompt("Look at the notebook data");
  assert.equal(await toolCall("bash", { command: "bash nb.sh" }), undefined);
  assert.equal((await toolCall("bash", { command: "rm -rf x" }))?.block, true);
});
