import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { checkMcpCall, readMcpCatalog } from "../src/mcp-tools.js";
import { MCP_ALLOW_ENV } from "../src/multi-plan.js";
import planMode from "../src/plan-mode.js";
import { NUDGE_MESSAGE, runPlanner, WRAP_UP_MESSAGE } from "../src/planner-process.js";
import { PlannerTrace } from "../src/planner-trace.js";
import {
  applyJevPick,
  buildToolTree,
  groupState,
  leafCapabilities,
  leaves,
  toggle,
  treeToSelection,
} from "../src/tool-tree.js";
import { ToolTreeView } from "../src/tool-tree-view.js";
import { TraceView } from "../src/trace-view.js";
import { createMockContext, createMockPi } from "./support.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => `[${text}]`,
} as never;

test("the MCP guard allows only selected tools, by prefixed or original name, and never auth or installs", () => {
  const allow = ["context7/query-docs", "chrome-devtools/*"];
  assert.deepEqual(checkMcpCall({ tool: "context7_query-docs", args: {} }, allow), { allowed: true });
  assert.deepEqual(checkMcpCall({ tool: "query-docs", server: "context7" }, allow), { allowed: true });
  assert.deepEqual(checkMcpCall({ tool: "query-docs" }, allow), { allowed: true });
  assert.deepEqual(checkMcpCall({ tool: "chrome-devtools_take_screenshot" }, allow), { allowed: true });
  assert.deepEqual(checkMcpCall({ tool: "chrome_devtools_take_screenshot" }, allow), { allowed: true });
  assert.deepEqual(checkMcpCall({ tool: "anything", server: "chrome-devtools" }, allow), { allowed: true });
  for (const input of [{ search: "notes" }, { describe: "context7_query-docs" }, { server: "obsidian" }, {}]) {
    assert.deepEqual(checkMcpCall(input, allow), { allowed: true }, JSON.stringify(input));
  }
  const blocked = checkMcpCall({ tool: "context7_resolve-library-id" }, allow);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.allowed ? "" : blocked.reason, /not selected for this planning run.*context7\/query-docs/u);
  assert.equal(checkMcpCall({ tool: "obsidian_obsidian__delete_note" }, allow).allowed, false);
  assert.equal(checkMcpCall({ tool: "query-docs", server: "obsidian" }, allow).allowed, false);
  assert.equal(checkMcpCall({ action: "auth-start", server: "figma" }, allow).allowed, false);
  assert.equal(checkMcpCall({ action: "install", url: "https://x" }, allow).allowed, false);
  assert.equal(checkMcpCall({ tool: "context7_query-docs" }, []).allowed, false);
});

test("the MCP catalog follows the adapter's config precedence, drops disabled servers, and reads cached tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-mcp-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(home, ".config", "mcp"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(home, ".config", "mcp", "mcp.json"),
      JSON.stringify({ mcpServers: { context7: { url: "x" }, obsidian: { url: "y" }, figma: { url: "z" } } }),
    );
    await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { obsidian: { disabled: true } } }));
    await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "x" } } }));
    await writeFile(
      join(agent, "mcp-cache.json"),
      JSON.stringify({
        version: 1,
        servers: {
          context7: { tools: [{ name: "query-docs", description: "Query docs" }] },
          obsidian: { tools: [{ name: "search_notes" }] },
          stale: { tools: [{ name: "gone" }] },
        },
      }),
    );
    assert.deepEqual(readMcpCatalog(cwd, agent, home), [
      { name: "context7", tools: [{ name: "query-docs", description: "Query docs" }], known: true },
      { name: "figma", tools: [], known: false },
      { name: "local", tools: [], known: false },
    ]);
    assert.deepEqual(readMcpCatalog(join(root, "nowhere"), join(root, "none"), join(root, "nobody")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sampleTree() {
  return buildToolTree({
    toolsets: {
      web: {
        label: "Web research",
        extensions: [],
        tools: ["web_search", "fetch_content"],
        enabled: true,
        scouts: true,
      },
      mcp: { label: "MCP servers", extensions: [], tools: ["mcp"], mcp: true, enabled: false, scouts: true },
    },
    mcpCatalog: [
      {
        name: "obsidian",
        known: true,
        tools: [
          { name: "search_notes", description: "Search notes" },
          { name: "delete_note", description: "Delete a note" },
        ],
      },
      { name: "figma", known: false, tools: [] },
    ],
    scoutTargets: ["anthropic/claude-opus-5-5:high"],
  });
}

test("the tool tree groups toolsets and MCP servers, toggles groups, and maps to a selection", () => {
  const roots = sampleTree();
  assert.deepEqual(
    leaves(roots).map((leaf) => [leaf.id, leaf.selected]),
    [
      ["shell", true],
      ["subagents", true],
      ["toolset:web/web_search", true],
      ["toolset:web/fetch_content", true],
      ["mcp:obsidian/search_notes", false],
      ["mcp:obsidian/delete_note", false],
      ["mcp:figma", false],
    ],
  );
  const mcpGroup = roots.find((root) => root.id === "toolset:mcp");
  const obsidian = mcpGroup?.children?.find((child) => child.id === "mcp:obsidian");
  assert.ok(mcpGroup && obsidian);
  assert.equal(groupState(obsidian), "none");
  const search = obsidian.children?.[0];
  assert.ok(search);
  toggle(search);
  assert.equal(groupState(obsidian), "some");
  assert.deepEqual(treeToSelection(roots), {
    shell: true,
    subagents: true,
    toolsetTools: { web: ["web_search", "fetch_content"] },
    mcp: ["obsidian/search_notes"],
  });
  toggle(mcpGroup);
  assert.equal(groupState(mcpGroup), "all");
  assert.deepEqual(treeToSelection(roots).mcp, ["obsidian/*", "figma/*"]);
  toggle(mcpGroup);
  assert.equal(groupState(mcpGroup), "none");

  applyJevPick(roots, {
    kind: "jev",
    model: "jev",
    probabilities: { "mcp:obsidian/search_notes": 0.8, "toolset:web/fetch_content": 0.2 },
    selected: { "mcp:obsidian/search_notes": true, "toolset:web/fetch_content": false },
  });
  assert.equal(search.selected, true);
  assert.equal(search.jev, 0.8);
  assert.deepEqual(
    leafCapabilities(roots).find((capability) => capability.id === "mcp:obsidian/delete_note"),
    {
      id: "mcp:obsidian/delete_note",
      label: "delete_note",
      description: "obsidian: Delete a note",
      fallbackSelected: false,
    },
  );
});

test("the tool tree view starts on Start, toggles and expands rows, and returns the time limit", () => {
  const roots = sampleTree();
  const results: unknown[] = [];
  const view = new ToolTreeView(theme, {
    title: "Plan with multiple models · 2/2 tools",
    lines: ["Task: x"],
    roots,
    startLabel: "Start planning with 2 models",
    timeLimitMinutes: 45,
    timeLimitChoices: [15, 30, 45, 60],
    rows: () => 30,
    requestRender: () => undefined,
    onDone: (result) => results.push(result),
  });
  let screen = view.render(120).join("\n");
  assert.match(screen, /› ▶ Start planning with 2 models · 4 tools selected/u);
  assert.match(screen, /Time limit {2}‹ 45 min ›/u);
  assert.match(screen, /▾ \[ \] MCP servers +0\/3/u);
  assert.match(screen, /▸ \[ \] obsidian/u);
  assert.doesNotMatch(screen, /search_notes/u);

  view.handleInput("\u001b[B"); // down to time limit
  view.handleInput("\u001b[C"); // right: 60 min
  for (let index = 0; index < 7; index += 1) view.handleInput("\u001b[B"); // to obsidian
  screen = view.render(120).join("\n");
  assert.match(screen, /› +▸ \[ \] obsidian/u);
  view.handleInput("\u001b[C"); // expand obsidian
  view.handleInput(" "); // select all of obsidian
  screen = view.render(120).join("\n");
  assert.match(screen, /▾ \[x\] obsidian +2\/2/u);
  assert.match(screen, /\[x\] search_notes/u);
  view.handleInput("g");
  view.handleInput("\r");
  assert.deepEqual(results, [{ kind: "start", timeLimitMinutes: 60 }]);
  assert.deepEqual(treeToSelection(roots).mcp, ["obsidian/*"]);
  view.handleInput("\u001b");
  assert.deepEqual(results.at(-1), { kind: "back" });
});

test("Enter opens and closes servers, Space selects them, and the mouse does both", () => {
  const roots = sampleTree();
  const view = new ToolTreeView(theme, {
    title: "tools",
    lines: [],
    roots,
    startLabel: "Start",
    timeLimitMinutes: 45,
    timeLimitChoices: [45],
    rows: () => 40,
    requestRender: () => undefined,
    onDone: () => undefined,
  });
  const screen = () => view.render(120);
  for (let index = 0; index < 8; index += 1) view.handleInput("\u001b[B"); // obsidian
  view.handleInput("\r");
  assert.match(screen().join("\n"), /▾ \[ \] obsidian[\s\S]*\[ \] search_notes[\s\S]*\[ \] delete_note/u);
  view.handleInput("\u001b[B"); // search_notes
  view.handleInput("\r");
  assert.match(screen().join("\n"), /▾ \[-\] obsidian +1\/2[\s\S]*\[x\] search_notes/u);
  view.handleInput("\u001b[A"); // back to obsidian
  view.handleInput("\r"); // close it again
  assert.doesNotMatch(screen().join("\n"), /search_notes/u);
  view.handleInput(" "); // select the whole server
  assert.match(screen().join("\n"), /▸ \[x\] obsidian +2\/2/u);

  // Mouse: clicking a group's label opens it; clicking its checkbox clears it.
  const lines = screen();
  const obsidianLine = lines.findIndex((line) => line.includes("obsidian"));
  view.handleMouse({ type: "click", button: "left", x: 30, y: obsidianLine } as never);
  assert.match(screen().join("\n"), /▾ \[x\] obsidian[\s\S]*\[x\] delete_note/u);
  const boxX = (screen()[obsidianLine] ?? "").indexOf("[x]");
  view.handleMouse({ type: "click", button: "left", x: boxX, y: obsidianLine } as never);
  assert.match(screen().join("\n"), /▾ \[ \] obsidian +0\/2/u);
  assert.deepEqual(view.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: 1 } as never), {
    handled: true,
  });
});

test("traces record streamed text, thinking, tool calls with results, and notes", () => {
  const trace = new PlannerTrace();
  trace.apply({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Let me " } });
  trace.apply({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "look." } });
  trace.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Reading." } });
  trace.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/a.ts" } });
  trace.apply({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "a\nb\nc" }] },
  });
  trace.apply({
    type: "tool_execution_start",
    toolCallId: "t2",
    toolName: "mcp",
    args: { tool: "context7_query-docs" },
  });
  trace.apply({
    type: "tool_execution_end",
    toolCallId: "t2",
    toolName: "mcp",
    isError: true,
    result: { content: [{ type: "text", text: "not selected" }] },
  });
  trace.note("Soft deadline reached", "warning");
  assert.deepEqual(trace.entries, [
    { kind: "thinking", text: "Let me look." },
    { kind: "text", text: "Reading." },
    { kind: "tool", id: "t1", name: "read", summary: "read src/a.ts", status: "ok", result: "3 lines" },
    {
      kind: "tool",
      id: "t2",
      name: "mcp",
      summary: "mcp call context7_query-docs",
      status: "error",
      result: "not selected",
    },
    { kind: "note", text: "Soft deadline reached", tone: "warning" },
  ]);
});

function tracePanes() {
  const panes = ["A", "B"].map((id) => ({
    id,
    label: id === "A" ? "anthropic/claude-fable-5-1:xhigh" : "openai-codex/gpt-6-astra:xhigh",
    trace: new PlannerTrace(),
    progress: {
      spec: { provider: "p", modelId: id },
      state: "running" as const,
      startedAt: Date.now() - 65_000,
      toolCalls: id === "A" ? 12 : 3,
      subagentTasks: 0,
      totalTokens: 1_234_567,
      costUsd: 1.5,
    },
  }));
  for (let index = 0; index < 60; index += 1) {
    panes[0]?.trace.apply({
      type: "tool_execution_start",
      toolCallId: `a${index}`,
      toolName: "read",
      args: { path: `a${index}.ts` },
    });
    panes[1]?.trace.apply({
      type: "tool_execution_start",
      toolCallId: `b${index}`,
      toolName: "grep",
      args: { pattern: `b${index}` },
    });
  }
  return panes;
}

test("the trace view shows planners side by side, follows the tail, scrolls, and confirms cancelling", () => {
  const panes = tracePanes();
  const events: string[] = [];
  let live = true;
  const view = new TraceView(theme, {
    title: "Planning with 2 models",
    getPanes: () => panes,
    isLive: () => live,
    rows: () => 30,
    requestRender: () => undefined,
    onCancel: () => events.push("cancel"),
    onClose: () => events.push("close"),
  });
  let screen = view.render(160).join("\n");
  assert.match(screen, /… A anthropic\/claude-fable-5-1:xhigh +1m 05s +12 tools +1.23M tok +\$1.50/u);
  assert.match(screen, /⋯ read a59\.ts +│ ⋯ grep b59/u, "both panes follow their latest entries side by side");
  assert.doesNotMatch(screen, /read a0\.ts/u);

  view.handleInput("g"); // top of the focused pane (A)
  screen = view.render(160).join("\n");
  assert.match(screen, /read a0\.ts/u);
  assert.match(screen, /A · anthropic\/claude-fable-5-1:xhigh · 1-/u);

  view.handleInput("s"); // one at a time
  view.handleInput("\t"); // focus B
  screen = view.render(160).join("\n");
  assert.match(screen, /\[ B · openai-codex\/gpt-6-astra:xhigh \]/u);
  assert.match(screen, /grep b59/u);
  assert.doesNotMatch(screen, /read a/u);

  view.handleInput("\u001b");
  assert.match(view.render(160).join("\n"), /Cancel every planner\?/u);
  view.handleInput("n");
  assert.deepEqual(events, []);
  view.handleInput("\u001b");
  view.handleInput("\u001b");
  assert.deepEqual(events, ["cancel"]);

  live = false;
  view.handleInput("\r");
  assert.deepEqual(events, ["cancel", "close"]);
  assert.ok(view.render(60).every((line) => line.length <= 60 + 20));
});

class RpcChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  records: Record<string, unknown>[] = [];
  stdinEnded = false;
  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.records.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      this.emit("record", this.records.at(-1));
    });
    this.stdin.on("finish", () => {
      this.stdinEnded = true;
      setTimeout(() => this.exit(0), 1);
    });
  }
  send(record: unknown) {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }
  exit(code: number) {
    if (this.listenerCount("close") === 0) return;
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => {
      this.emit("close", code);
      this.removeAllListeners("close");
    }, 2);
  }
  kill() {
    this.exit(1);
    return true;
  }
}

function runRpcPlanner(script: (child: RpcChild) => void, timeoutMs = 5_000) {
  let child: RpcChild | undefined;
  const traces: PlannerTrace[] = [];
  const result = runPlanner({
    id: "A",
    spec: { provider: "p", modelId: "m" },
    cwd: process.cwd(),
    prompt: "Plan it",
    timeoutMs,
    extensionPath: "/ext",
    loadUserExtensions: false,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onTrace: (trace) => traces.push(trace),
    spawnProcess: (() => {
      child = new RpcChild();
      const current = child;
      setTimeout(() => script(current), 0);
      return current;
    }) as never,
    piCommand: { command: "pi", args: [] },
  });
  return { result, child: () => child, traces };
}

const planCall = {
  type: "tool_execution_start",
  toolCallId: "c",
  toolName: "plan_mode_complete",
  args: { plan: "# Plan" },
};

test("RPC planners get the prompt over stdin, decline dialogs, and shut down after submitting a plan", async () => {
  const run = runRpcPlanner((child) => {
    child.send({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["a"] });
    child.send({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "hi" });
    child.send(planCall);
    child.send({ type: "agent_settled" });
  });
  const candidate = await run.result;
  const child = run.child();
  assert.equal(candidate.status, "done");
  assert.equal(candidate.plan, "# Plan");
  assert.deepEqual(child?.records[0], { id: "prompt", type: "prompt", message: "Plan it" });
  assert.deepEqual(child?.records[1], { type: "extension_ui_response", id: "ui-1", cancelled: true });
  assert.equal(child?.records.length, 2, "fire-and-forget UI gets no response");
  assert.equal(child?.stdinEnded, true);
  assert.ok(run.traces.at(-1)?.entries.some((entry) => entry.kind === "note" && entry.text === "Plan submitted."));
});

test("an RPC planner that stops without a plan is nudged once to submit it", async () => {
  const run = runRpcPlanner((child) => {
    child.on("record", (record: Record<string, unknown>) => {
      if (record.message === NUDGE_MESSAGE) {
        child.send(planCall);
        child.send({ type: "agent_settled" });
      }
    });
    child.send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hmm." }], stopReason: "stop" },
    });
    child.send({ type: "agent_settled" });
  });
  const candidate = await run.result;
  assert.equal(candidate.status, "done");
  assert.deepEqual(
    run.child()?.records.map((record) => record.type),
    ["prompt", "prompt"],
  );
});

test("at the soft deadline an RPC planner is steered to wrap up, and its late plan still counts", async () => {
  const run = runRpcPlanner((child) => {
    child.on("record", (record: Record<string, unknown>) => {
      if (record.type === "steer" && record.message === WRAP_UP_MESSAGE) {
        child.send(planCall);
        child.send({ type: "agent_settled" });
      }
    });
  }, 400);
  const candidate = await run.result;
  assert.equal(candidate.status, "done");
  assert.ok(run.child()?.records.some((record) => record.type === "steer"));
  assert.ok(run.traces.at(-1)?.entries.some((entry) => entry.kind === "note" && /Soft deadline/u.test(entry.text)));
});

test("the MCP allowlist env makes Plan mode block unselected mcp calls in planners and scouts", async () => {
  const previous = process.env[MCP_ALLOW_ENV];
  process.env[MCP_ALLOW_ENV] = JSON.stringify(["context7/query-docs"]);
  try {
    const mock = createMockPi({ activeTools: ["read", "mcp"] });
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    const context = createMockContext({ mode: "json", hasUI: false });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    const handlers = mock.events.get("tool_call") ?? [];
    const verdicts = [];
    for (const input of [{ tool: "context7_query-docs" }, { tool: "obsidian_obsidian__delete_note" }]) {
      let verdict: unknown;
      for (const handler of handlers) {
        verdict = await handler({ toolName: "mcp", input }, context.ctx);
        if (verdict) break;
      }
      verdicts.push(verdict);
    }
    assert.equal(verdicts[0], undefined);
    assert.equal((verdicts[1] as { block?: boolean }).block, true);
  } finally {
    if (previous === undefined) delete process.env[MCP_ALLOW_ENV];
    else process.env[MCP_ALLOW_ENV] = previous;
  }
});
