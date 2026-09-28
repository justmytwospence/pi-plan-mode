import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { formatPlannerPrompt, PLANNER_ENV } from "../src/multi-plan.js";
import planMode from "../src/plan-mode.js";
import { plannerArgs, runPlanner } from "../src/planner-process.js";
import {
  formatScoutResults,
  normalizeScoutTasks,
  PLAN_SUBAGENTS_TOOL_NAME,
  runScout,
  SCOUT_MODEL_ENV,
  scoutArgs,
} from "../src/scout-process.js";
import { normalizePlanModeSettings } from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  emitEvent(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  exit(code: number) {
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit("close", code), 5);
  }
  kill() {
    this.exit(1);
    return true;
  }
}

function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnProcess = ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: options.env });
    const child = new FakeChild();
    setTimeout(() => script(child), 0);
    return child;
  }) as never;
  return { spawnProcess, calls };
}

const usage = (total: number) => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { total },
});

test("scout tasks validate, and scouts run with read-only tools and no extensions", () => {
  assert.deepEqual(
    normalizeScoutTasks({
      tasks: [
        { task: " look ", label: "" },
        { task: "b", label: "B" },
      ],
    }),
    {
      ok: true,
      tasks: [
        { label: "task 1", task: "look" },
        { label: "B", task: "b" },
      ],
    },
  );
  for (const invalid of [{}, { tasks: [] }, { tasks: [{ task: "" }] }, { tasks: Array(7).fill({ task: "x" }) }]) {
    assert.equal(normalizeScoutTasks(invalid).ok, false, JSON.stringify(invalid));
  }
  const args = scoutArgs({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" }, "Find X");
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-opus-5-5:high");
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.ok(args.includes("--no-extensions"));
  assert.match(args.at(-1) ?? "", /read-only scout[\s\S]*## Task\n\nFind X/u);
});

test("a scout returns its last report and usage, without inheriting the planner environment", async () => {
  const previous = process.env[PLANNER_ENV];
  process.env[PLANNER_ENV] = "1";
  try {
    const { spawnProcess, calls } = fakeSpawn((child) => {
      child.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Looking" }],
          usage: usage(0.01),
          stopReason: "toolUse",
        },
      });
      child.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Found it in a.ts:3" }],
          usage: usage(0.02),
          stopReason: "stop",
        },
      });
      child.exit(0);
    });
    const result = await runScout({
      spec: { provider: "p", modelId: "m" },
      task: { label: "where", task: "find it" },
      cwd: process.cwd(),
      spawnProcess,
      piCommand: { command: "pi", args: [] },
    });
    assert.equal(result.status, "done");
    assert.equal(result.report, "Found it in a.ts:3");
    assert.equal(result.usage.totalTokens, 30);
    assert.ok(Math.abs(result.usage.cost.total - 0.03) < 1e-9);
    assert.equal(calls[0]?.env[PLANNER_ENV], undefined);
    assert.equal(calls[0]?.env[SCOUT_MODEL_ENV], undefined);
  } finally {
    if (previous === undefined) delete process.env[PLANNER_ENV];
    else process.env[PLANNER_ENV] = previous;
  }

  const failing = fakeSpawn((child) => {
    child.emitEvent({
      type: "message_end",
      message: { role: "assistant", content: [], usage: usage(0), stopReason: "error", errorMessage: "quota" },
    });
    child.exit(1);
  });
  const failed = await runScout({
    spec: { provider: "p", modelId: "m" },
    task: { label: "x", task: "y" },
    cwd: process.cwd(),
    spawnProcess: failing.spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.report, "quota");

  const controller = new AbortController();
  const cancelled = runScout({
    spec: { provider: "p", modelId: "m" },
    task: { label: "x", task: "y" },
    cwd: process.cwd(),
    signal: controller.signal,
    spawnProcess: fakeSpawn(() => undefined).spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await cancelled).status, "cancelled");
  assert.match(
    formatScoutResults({ provider: "p", modelId: "m" }, [
      { label: "a", status: "done", report: "A", usage: usage(0) as never },
      { label: "b", status: "timeout", report: "Timed out.", usage: usage(0) as never },
    ]),
    /Ran 2 read-only subagents on p\/m\.[\s\S]*## 1\. a\n\nA[\s\S]*## 2\. b \(timeout\)/u,
  );
});

test("planners get plan_subagents, the scout model, and scout usage only when a scout model is set", async () => {
  const base = {
    spec: { provider: "anthropic", modelId: "claude-fable-5-1" },
    prompt: "p",
    extensionPath: "/e",
    loadUserExtensions: false,
  };
  assert.doesNotMatch(plannerArgs(base)[plannerArgs(base).indexOf("--tools") + 1] ?? "", /plan_subagents/u);
  const withScouts = plannerArgs({ ...base, scoutSpec: { provider: "anthropic", modelId: "claude-opus-5-5" } });
  assert.match(withScouts[withScouts.indexOf("--tools") + 1] ?? "", /,plan_subagents$/u);

  const { spawnProcess, calls } = fakeSpawn((child) => {
    child.emitEvent({
      type: "tool_execution_start",
      toolName: PLAN_SUBAGENTS_TOOL_NAME,
      args: { tasks: [{ task: "a" }, { task: "b" }] },
    });
    child.emitEvent({
      type: "tool_execution_end",
      toolName: PLAN_SUBAGENTS_TOOL_NAME,
      isError: false,
      result: { usage: usage(0.5) },
    });
    child.emitEvent({ type: "tool_execution_start", toolName: "plan_mode_complete", args: { plan: "# P" } });
    child.emitEvent({
      type: "message_end",
      message: { role: "assistant", content: [], usage: usage(0.25), stopReason: "toolUse" },
    });
    child.exit(0);
  });
  const progress: string[] = [];
  const candidate = await runPlanner({
    id: "A",
    ...base,
    scoutSpec: { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" },
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    onProgress: (next) => progress.push(next.lastActivity ?? ""),
    spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  assert.equal(calls[0]?.env[SCOUT_MODEL_ENV], "anthropic/claude-opus-5-5:high");
  assert.ok(Math.abs((candidate.costUsd ?? 0) - 0.75) < 1e-9);
  assert.ok(progress.includes("plan_subagents ×2"));
  assert.equal(candidate.subagentTasks, 2);
  assert.match(
    formatPlannerPrompt("t", "", 2, "anthropic/claude-opus-5-5"),
    /plan_subagents \(they run on anthropic\/claude-opus-5-5/u,
  );
  assert.doesNotMatch(formatPlannerPrompt("t", "", 2), /plan_subagents/u);
});

test("the plan_subagents tool exists only in planner processes with a scout model and is allowed in Plan mode", async () => {
  const saved = { planner: process.env[PLANNER_ENV], scout: process.env[SCOUT_MODEL_ENV] };
  try {
    delete process.env[PLANNER_ENV];
    delete process.env[SCOUT_MODEL_ENV];
    const ordinary = createMockPi({ activeTools: ["read"] });
    planMode(ordinary.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    assert.equal(
      ordinary.tools.some((tool) => tool.name === PLAN_SUBAGENTS_TOOL_NAME),
      false,
    );

    process.env[PLANNER_ENV] = "1";
    process.env[SCOUT_MODEL_ENV] = "anthropic/claude-opus-5-5:high";
    const planner = createMockPi({ activeTools: ["read", PLAN_SUBAGENTS_TOOL_NAME] });
    planMode(planner.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    const tool = planner.tools.find((candidate) => candidate.name === PLAN_SUBAGENTS_TOOL_NAME);
    assert.ok(tool);
    assert.match(String(tool.description), /anthropic\/claude-opus-5-5:high/u);
    const context = createMockContext({ mode: "json", hasUI: false });
    await planner.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    const verdict = await planner.events.get("tool_call")?.[0]?.(
      { toolName: PLAN_SUBAGENTS_TOOL_NAME, input: { tasks: [{ task: "x" }] } },
      context.ctx,
    );
    assert.equal(verdict, undefined, "Plan mode allows plan_subagents");
  } finally {
    if (saved.planner === undefined) delete process.env[PLANNER_ENV];
    else process.env[PLANNER_ENV] = saved.planner;
    if (saved.scout === undefined) delete process.env[SCOUT_MODEL_ENV];
    else process.env[SCOUT_MODEL_ENV] = saved.scout;
  }
});

test("scoutModelMap normalizes like the implementation map", () => {
  assert.deepEqual(
    normalizePlanModeSettings({ scoutModelMap: { "anthropic/claude-fable-5-1": "anthropic/claude-opus-5-5:high" } })
      ?.scoutModelMap,
    { "anthropic/claude-fable-5-1": { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" } },
  );
  assert.equal(normalizePlanModeSettings({ scoutModelMap: { bad: "anthropic/x" } }), undefined);
});

test("research extensions and tools reach planners, their scouts, and the prompts", async () => {
  const base = {
    spec: { provider: "anthropic", modelId: "claude-fable-5-1" },
    prompt: "p",
    extensionPath: "/e",
    loadUserExtensions: false,
    extraExtensions: ["/web-access"],
    extraTools: ["web_search", "fetch_content"],
  };
  const args = plannerArgs(base);
  assert.deepEqual(args.slice(args.indexOf("--no-extensions"), args.indexOf("--no-extensions") + 5), [
    "--no-extensions",
    "--extension",
    "/e",
    "--extension",
    "/web-access",
  ]);
  assert.match(args[args.indexOf("--tools") + 1] ?? "", /plan_mode_complete,web_search,fetch_content$/u);

  const { spawnProcess, calls } = fakeSpawn((child) => child.exit(0));
  await runPlanner({
    id: "A",
    ...base,
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  assert.equal(calls[0]?.env.PI_PLAN_MODE_EXTRA_TOOLS, "web_search,fetch_content");
  assert.equal(calls[0]?.env.PI_PLAN_MODE_PLANNER_EXTENSIONS, '["/web-access"]');

  const scout = scoutArgs({ provider: "p", modelId: "m" }, "Find docs", {
    extensions: ["/web-access"],
    tools: ["web_search"],
  });
  assert.equal(scout[scout.indexOf("--tools") + 1], "read,grep,find,ls,web_search");
  assert.equal(scout[scout.indexOf("--no-extensions") + 2], "/web-access");
  assert.match(scout.at(-1) ?? "", /research beyond the repository with web_search/u);
  assert.match(
    formatPlannerPrompt("t", "", 2, undefined, ["web_search", "fetch_content"]),
    /Research beyond the repository[^\n]*web_search, fetch_content/u,
  );
  assert.deepEqual(normalizePlanModeSettings({ plannerExtensions: ["~/x"], plannerTools: ["web_search"] }), {
    thinkingLevel: "inherit",
    plannerExtensions: ["~/x"],
    plannerTools: ["web_search"],
  });
});

test("Plan mode admits the extra research tools only inside planner processes", async () => {
  const saved = { planner: process.env[PLANNER_ENV], tools: process.env.PI_PLAN_MODE_EXTRA_TOOLS };
  try {
    for (const planner of [false, true]) {
      if (planner) {
        process.env[PLANNER_ENV] = "1";
        process.env.PI_PLAN_MODE_EXTRA_TOOLS = "web_search";
      } else {
        delete process.env[PLANNER_ENV];
        process.env.PI_PLAN_MODE_EXTRA_TOOLS = "web_search";
      }
      const mock = createMockPi({ activeTools: ["read", "web_search"] });
      planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
      const context = createMockContext({ mode: "json", hasUI: false });
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
      if (!planner) await mock.commands.get("plan")?.handler("start", context.ctx);
      const verdict = (await mock.events.get("tool_call")?.[0]?.(
        { toolName: "web_search", input: { query: "x" } },
        context.ctx,
      )) as { block?: boolean } | undefined;
      assert.equal(verdict?.block === true, !planner, planner ? "planner" : "ordinary session");
    }
  } finally {
    if (saved.planner === undefined) delete process.env[PLANNER_ENV];
    else process.env[PLANNER_ENV] = saved.planner;
    if (saved.tools === undefined) delete process.env.PI_PLAN_MODE_EXTRA_TOOLS;
    else process.env.PI_PLAN_MODE_EXTRA_TOOLS = saved.tools;
  }
});
