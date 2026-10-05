import assert from "node:assert/strict";
import { test } from "vitest";
import { otherTools, otherToolsNode, resolveAccess } from "../src/planner/access.js";
import { type PlannerAccessConfig, PlannerAgent } from "../src/planner/agent.js";
import { plannerExtension } from "../src/planner/extension.js";
import type { PlannerSessionFactory, PlannerSessionOptions } from "../src/planner/session.js";
import { buildToolTree, leaves } from "../src/tool-tree.js";

type Tool = {
  name: string;
  execute(id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<unknown>;
};
type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

/** Run a planner extension against a tiny fake of Pi's extension API. */
function loadExtension(factory: (pi: never) => void, allTools: unknown[] = []) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  factory({
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getAllTools: () => allTools,
  } as never);
  const toolCall = async (toolName: string, input: unknown = {}) => {
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = (await handler({ toolName, input }, { cwd: "/repo" })) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (result?.block) return result;
    }
    return undefined;
  };
  return { tools, toolCall };
}

const access = (tools: string[]): PlannerAccessConfig => ({
  tools,
  extensions: [],
  skills: [],
  systemPrompt: ["planner"],
  policy: { tools: new Set(tools), grantPrefixes: ["~/.local/bin/jev-ask"], guardExtensionPath: "/ext" },
});

test("the planner policy keeps planning read-only and limited to the chosen tools", async () => {
  const plans: string[] = [];
  const { tools, toolCall } = loadExtension(
    plannerExtension({
      ...access(["read", "bash", "web_search"]).policy,
      ask: async () => undefined,
      onPlan: (plan) => plans.push(plan),
    }) as never,
  );
  assert.ok(tools.has("plan_mode_question"));
  assert.ok(tools.has("plan_mode_complete"));
  assert.equal(tools.has("plan_subagents"), false, "no subagents without a scout model");

  assert.equal(await toolCall("read"), undefined);
  assert.equal(await toolCall("web_search"), undefined);
  assert.equal(await toolCall("bash", { command: "git status && rg foo" }), undefined);
  assert.equal(await toolCall("bash", { command: "~/.local/bin/jev-ask <<'JSON'\n{}\nJSON" }), undefined);
  assert.match((await toolCall("bash", { command: "rm -rf src" }))?.reason ?? "", /Blocked command: rm -rf src/u);
  assert.match((await toolCall("write", { path: "x" }))?.reason ?? "", /read-only/u);
  assert.match((await toolCall("fetch_content"))?.reason ?? "", /not selected/u);

  await tools.get("plan_mode_complete")?.execute("1", { plan: "# Plan" });
  assert.deepEqual(plans, ["# Plan"]);
});

test("planner questions go to the lane, and a skipped question says so", async () => {
  const asked: unknown[] = [];
  let answer: unknown;
  const { tools } = loadExtension(
    plannerExtension({
      ...access(["read"]).policy,
      ask: async (questions) => {
        asked.push(questions);
        return answer as never;
      },
      onPlan: () => undefined,
    }) as never,
  );
  const question = {
    questions: [
      {
        id: "lang",
        header: "Language",
        question: "Which?",
        options: [
          { label: "Python", description: "Py" },
          { label: "Node", description: "JS" },
        ],
      },
    ],
  };
  const skipped = (await tools.get("plan_mode_question")?.execute("1", question)) as {
    details: { cancelled: boolean };
  };
  assert.equal(skipped.details.cancelled, true);
  answer = [{ id: "lang", header: "Language", question: "Which?", answer: "Node", wasCustom: false, optionIndex: 2 }];
  const answered = (await tools.get("plan_mode_question")?.execute("2", question)) as {
    details: { cancelled: boolean };
  };
  assert.equal(answered.details.cancelled, false);
  assert.equal(asked.length, 2);
});

/** A fake planner session: prompts play a script of events and tool calls. */
function fakeSessions(script: (prompt: string, run: FakeRun) => Promise<void>) {
  const created: PlannerSessionOptions[] = [];
  const sent: Array<{ kind: string; text: string }> = [];
  const factory: PlannerSessionFactory = async (_host, options) => {
    created.push(options);
    const listeners = new Set<(event: unknown) => void>();
    const loaded = loadExtension(options.policy as never);
    let streaming = false;
    const run: FakeRun = {
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
      tool: (name, params) => loaded.tools.get(name)?.execute("call", params) as Promise<unknown>,
    };
    const session = {
      get isStreaming() {
        return streaming;
      },
      prompt: async (text: string) => {
        sent.push({ kind: "prompt", text });
        streaming = true;
        run.emit({ type: "agent_start" });
        await script(text, run);
        streaming = false;
        run.emit({ type: "agent_settled" });
      },
      steer: async (text: string) => {
        sent.push({ kind: "steer", text });
      },
      abort: async () => undefined,
    };
    return {
      session: session as never,
      file: `/sessions/${options.spec.modelId}.jsonl`,
      subscribe: (listener) => {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      dispose: () => undefined,
    };
  };
  return { factory, created, sent };
}

interface FakeRun {
  emit(event: Record<string, unknown>): void;
  tool(name: string, params: unknown): Promise<unknown>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function agent(factory: PlannerSessionFactory, extra: Partial<ConstructorParameters<typeof PlannerAgent>[0]> = {}) {
  return new PlannerAgent({
    id: "A",
    spec: { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "low" },
    name: "Claude Sonnet 5.5",
    cwd: "/repo",
    access: access(["read"]),
    timeoutMs: 60_000,
    sessionDir: "/sessions",
    seed: [{ role: "user", content: "earlier conversation" }],
    onChange: () => undefined,
    createSession: factory,
    ...extra,
  });
}

test("a planner starts its own session seeded with your conversation, works, and submits a plan", async () => {
  const { factory, created } = fakeSessions(async (_prompt, run) => {
    run.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "1", args: { path: "src/a.ts" } });
    run.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "1", result: { content: [] } });
    run.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        usage: { totalTokens: 100, cost: { total: 0.01 } },
      },
    });
    await run.tool("plan_mode_complete", { plan: "# Plan A" });
  });
  const planner = agent(factory);
  await planner.start("Plan the cache", {} as never);
  await flush();
  assert.equal(created[0]?.storage.kind, "new");
  assert.deepEqual(created[0]?.storage.kind === "new" ? created[0].storage.seed : [], [
    { role: "user", content: "earlier conversation" },
  ]);
  assert.deepEqual(created[0]?.appendSystemPrompt, ["planner"]);
  assert.equal(planner.status, "idle");
  assert.equal(planner.plan, "# Plan A");
  assert.equal(planner.revision, 1);
  assert.equal(planner.stats.toolCalls, 1);
  assert.equal(planner.stats.totalTokens, 100);
  assert.equal(planner.sessionFile, "/sessions/claude-sonnet-5-5.jsonl");
});

test("talking to an idle planner starts a turn; a revised plan bumps its revision", async () => {
  const { factory, sent } = fakeSessions(async (prompt, run) => {
    await run.tool("plan_mode_complete", { plan: `# Plan for ${prompt}` });
  });
  const planner = agent(factory);
  await planner.start("task", {} as never);
  await flush();
  await planner.say("use sh", {} as never);
  await flush();
  assert.deepEqual(
    sent.map((entry) => entry.kind),
    ["prompt", "prompt"],
  );
  assert.equal(planner.plan, "# Plan for use sh");
  assert.equal(planner.revision, 2);
  assert.ok(planner.trace.entries.some((entry) => entry.kind === "user" && entry.text === "use sh"));
});

test("a planner waits for your answers to its questions", async () => {
  const { factory } = fakeSessions(async (_prompt, run) => {
    const result = (await run.tool("plan_mode_question", {
      questions: [
        {
          id: "lang",
          header: "Language",
          question: "Which?",
          options: [
            { label: "Python", description: "Py" },
            { label: "Node", description: "JS" },
          ],
        },
      ],
    })) as { content: Array<{ text: string }> };
    await run.tool("plan_mode_complete", { plan: result.content[0]?.text ?? "" });
  });
  const planner = agent(factory);
  const started = planner.start("task", {} as never);
  await flush();
  assert.equal(planner.status, "asking");
  assert.equal(planner.pending?.questions[0]?.header, "Language");
  planner.answer([
    { id: "lang", header: "Language", question: "Which?", answer: "Node", wasCustom: false, optionIndex: 2 },
  ]);
  await started;
  await flush();
  assert.match(planner.plan ?? "", /Node/u);
  assert.equal(planner.status, "idle");
});

test("a restored planner reopens its session file when you talk to it", async () => {
  const { factory, created } = fakeSessions(async () => undefined);
  const planner = agent(factory, { sessionFile: "/sessions/old.jsonl", plan: "# Old", revision: 2 });
  assert.equal(planner.status, "idle");
  assert.equal(planner.plan, "# Old");
  await planner.say("hello again", {} as never);
  await flush();
  assert.deepEqual(created[0]?.storage, { kind: "open", file: "/sessions/old.jsonl" });
});

test("Other tools come from extension files; access resolves selections into planner tools", () => {
  const tool = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: `${name} tool`,
    sourceInfo: { path, source: "local" },
    ...extra,
  });
  const all = [
    tool("read", "builtin:read", { sourceInfo: { path: "builtin:read", source: "builtin" } }),
    tool("ask_user_question", "/ext/ask.ts"),
    tool("web_search", "/ext/web.ts"),
    tool("radius_web_search", "/ext/radius.ts"),
    tool("mcp__ctx__docs", "builtin:mcp", { namespace: { name: "mcp__ctx" } }),
    tool("plan_helper", "/repo/src/index.ts"),
  ];
  const others = otherTools(all as never, new Set(["web_search"]), "/repo/src/index.ts");
  assert.deepEqual(
    others.map((other) => other.name),
    ["radius_web_search"],
  );
  const roots = buildToolTree({
    toolsets: {},
    mcpCatalog: [],
    scoutTargets: ["anthropic/claude-opus-5-5"],
    grants: {},
  });
  const node = otherToolsNode(others);
  assert.ok(node);
  roots.push(node);
  for (const leaf of leaves(roots)) leaf.selected = true;
  const resolved = resolveAccess({
    roots,
    toolsets: {},
    grants: {},
    others,
    scout: { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" },
    guardExtensionPath: "/ext",
    expandPath: (path) => path,
  });
  assert.deepEqual(resolved.config.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "plan_mode_question",
    "plan_mode_complete",
    "plan_subagents",
    "radius_web_search",
  ]);
  assert.deepEqual(resolved.config.extensions, ["/ext/radius.ts"]);
  assert.equal(resolved.scoutLabel, "anthropic/claude-opus-5-5:high");
});
