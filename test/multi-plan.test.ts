import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import {
  buildPlannerTranscript,
  CANDIDATES_ENTRY_TYPE,
  formatPlannerPrompt,
  formatSynthesisPrompt,
  latestCandidateSet,
  MULTI_TASK_MESSAGE_TYPE,
  PLANNER_ENV,
  type PlanCandidate,
} from "../src/multi-plan.js";
import { progressLines } from "../src/multi-plan-menu.js";
import { runPlanCompleteHook } from "../src/plan-hook.js";
import planMode from "../src/plan-mode.js";
import { plannerArgs, runPlanner } from "../src/planner-process.js";
import { createMockContext, createMockPi } from "./support.js";

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role, content, ...extra },
});

test("the planner transcript keeps conversation and answers but not tool output or finished plans", () => {
  const transcript = buildPlannerTranscript([
    message("user", "Old request"),
    { type: "compaction", id: "c1", summary: "We discussed caching.", firstKeptEntryId: "k1" },
    { ...message("user", "Add a cache layer"), id: "k1" },
    message("assistant", [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "Which store?" },
      { type: "toolCall", name: "plan_mode_question", arguments: {} },
    ]),
    message("toolResult", [{ type: "text", text: "Store: Redis" }], { toolName: "plan_mode_question" }),
    message("toolResult", [{ type: "text", text: "FILE CONTENTS" }], { toolName: "read" }),
    message("toolResult", [{ type: "text", text: "# Old plan" }], { toolName: "plan_mode_complete" }),
    { type: "custom_message", customType: MULTI_TASK_MESSAGE_TYPE, content: "Also add metrics" },
    { type: "custom_message", customType: "plan-mode-transition", content: "[CONTRACT]" },
  ]);
  assert.match(transcript, /Summary of earlier conversation:\nWe discussed caching\./u);
  assert.match(transcript, /User: Add a cache layer/u);
  assert.match(transcript, /Assistant: Which store\?/u);
  assert.match(transcript, /Answers to planning questions:\nStore: Redis/u);
  assert.match(transcript, /User: Also add metrics/u);
  for (const excluded of ["Old request", "secret reasoning", "FILE CONTENTS", "# Old plan", "[CONTRACT]"]) {
    assert.equal(transcript.includes(excluded), false, excluded);
  }

  const long = buildPlannerTranscript(
    Array.from({ length: 200 }, (_unused, index) => message("user", `message ${index} ${"x".repeat(100)}`)),
    2_000,
  );
  assert.ok(long.length <= 2_000);
  assert.match(long, /message 0 /u);
  assert.match(long, /earlier conversation omitted/u);
  assert.match(long, /message 199 /u);
});

test("planner and synthesis prompts carry the task, independence rules, and every candidate", () => {
  const plannerPrompt = formatPlannerPrompt("Add caching", "User: hi", 3);
  assert.match(plannerPrompt, /2 other models are planning the same task/u);
  assert.match(plannerPrompt, /Do not call plan_mode_question/u);
  assert.match(plannerPrompt, /## Task\n\nAdd caching/u);
  assert.match(plannerPrompt, /## Conversation so far\n\nUser: hi/u);

  const candidates: PlanCandidate[] = [
    { id: "A", label: "anthropic/claude-opus-5-5", origin: "planner", status: "done", plan: "# Plan A" },
    { id: "B", label: 'openai "sol"', origin: "planner", status: "done", plan: "# Plan B" },
  ];
  const guided = formatSynthesisPrompt(candidates, "Use B's tests");
  assert.match(guided, /Guidance from the user: Use B's tests/u);
  assert.match(guided, /<candidate id="A" source="anthropic\/claude-opus-5-5">\n# Plan A\n<\/candidate>/u);
  assert.match(guided, /source="openai &quot;sol&quot;"/u);
  assert.match(formatSynthesisPrompt(candidates, " "), /Guidance from the user: none\. Use your judgment/u);
});

test("the latest candidate set restores from the branch and drops malformed candidates", () => {
  const restored = latestCandidateSet([
    { type: "custom", customType: CANDIDATES_ENTRY_TYPE, data: { version: 1, task: "old", candidates: [] } },
    {
      type: "custom",
      customType: CANDIDATES_ENTRY_TYPE,
      data: {
        version: 1,
        task: "new",
        createdAt: 5,
        candidates: [
          { id: "A", label: "m", origin: "planner", status: "done", plan: "# A", costUsd: 0.5 },
          { id: "B", label: "n", status: "exploded" },
        ],
      },
    },
  ]);
  assert.deepEqual(restored, {
    version: 1,
    task: "new",
    createdAt: 5,
    candidates: [{ id: "A", label: "m", origin: "planner", status: "done", plan: "# A", costUsd: 0.5 }],
  });
});

test("planner arguments run Pi in JSON mode with only this extension and read-only tools", () => {
  const args = plannerArgs({
    spec: { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "xhigh" },
    prompt: "-starts with a dash",
    extensionPath: "/ext/index.ts",
    loadUserExtensions: false,
  });
  assert.deepEqual(args.slice(0, 4), ["--mode", "json", "--no-session", "--model"]);
  assert.equal(args[4], "anthropic/claude-opus-5-5:xhigh");
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash,grep,find,ls,plan_mode_question,plan_mode_complete");
  assert.ok(args.includes("--no-extensions"));
  assert.equal(args[args.indexOf("--extension") + 1], "/ext/index.ts");
  assert.deepEqual(args.slice(-2), ["--", "-starts with a dash"]);
  const ambient = plannerArgs({
    spec: { provider: "p", modelId: "m" },
    prompt: "x",
    extensionPath: "/ext/index.ts",
    loadUserExtensions: true,
  });
  assert.equal(ambient.includes("--no-extensions"), false);
});

function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnProcess = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const child = new FakeChild();
    setTimeout(() => script(child), 0);
    return child;
  }) as never;
  return { spawnProcess, calls };
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  emitEvent(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  exit(code: number) {
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit("close", code), 5);
  }
  kill(signal: string) {
    this.killed.push(signal);
    this.exit(1);
    return true;
  }
}

const assistantEnd = (text: string, cost: number, extra: Record<string, unknown> = {}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { totalTokens: 1000, cost: { total: cost } },
    stopReason: "stop",
    ...extra,
  },
});

function plannerOptions(overrides: Record<string, unknown> = {}) {
  return {
    id: "B",
    spec: { provider: "anthropic", modelId: "claude-opus-5-5" },
    cwd: process.cwd(),
    prompt: "plan",
    timeoutMs: 5_000,
    extensionPath: "/ext/index.ts",
    loadUserExtensions: false,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    piCommand: { command: "pi", args: [] },
    ...overrides,
  };
}

test("a planner run collects the submitted plan, usage, and progress", async () => {
  const progress: string[] = [];
  const { spawnProcess, calls } = fakeSpawn((child) => {
    child.emitEvent({ type: "session", id: "x" });
    child.emitEvent({ type: "tool_execution_start", toolName: "read", args: { path: "src/app.ts" } });
    child.emitEvent(assistantEnd("Looking around", 0.1));
    child.emitEvent({ type: "tool_execution_start", toolName: "plan_mode_complete", args: { plan: " # Final plan " } });
    child.emitEvent(assistantEnd("", 0.2));
    child.exit(0);
  });
  const candidate = await runPlanner(
    plannerOptions({
      spawnProcess,
      onProgress: (next: { lastActivity?: string }) => progress.push(next.lastActivity ?? ""),
    }),
  );
  assert.equal(candidate.status, "done");
  assert.equal(candidate.plan, "# Final plan");
  assert.equal(candidate.toolCalls, 2);
  assert.equal(candidate.totalTokens, 2000);
  assert.ok(Math.abs((candidate.costUsd ?? 0) - 0.3) < 1e-9);
  assert.deepEqual(candidate.model, { provider: "anthropic", modelId: "claude-opus-5-5" });
  assert.ok(progress.includes("read src/app.ts"));
  assert.ok(progress.includes("submitted plan"));
  assert.equal(calls[0]?.env[PLANNER_ENV], "1");
});

test("a planner that answers in prose or a proposed_plan block still yields a candidate", async () => {
  const prose = `Here is the plan.\n\n${"Step. ".repeat(60)}`;
  const { spawnProcess } = fakeSpawn((child) => {
    child.emitEvent(assistantEnd(prose, 0));
    child.exit(0);
  });
  const fromProse = await runPlanner(plannerOptions({ spawnProcess }));
  assert.equal(fromProse.status, "done");
  assert.equal(fromProse.planFromText, true);

  const block = fakeSpawn((child) => {
    child.emitEvent(assistantEnd("<proposed_plan>\n# Block plan\n</proposed_plan>", 0));
    child.exit(0);
  });
  const fromBlock = await runPlanner(plannerOptions({ spawnProcess: block.spawnProcess }));
  assert.equal(fromBlock.plan, "# Block plan");
  assert.equal(fromBlock.planFromText, undefined);
});

test("planner failures, timeouts, and cancellation resolve with an explanatory candidate", async () => {
  const failing = fakeSpawn((child) => {
    child.emitEvent(assistantEnd("", 0, { stopReason: "error", errorMessage: "401 unauthorized" }));
    child.exit(1);
  });
  const failed = await runPlanner(plannerOptions({ spawnProcess: failing.spawnProcess }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "401 unauthorized");

  const hanging = fakeSpawn(() => undefined);
  const timedOut = await runPlanner(plannerOptions({ spawnProcess: hanging.spawnProcess, timeoutMs: 20 }));
  assert.equal(timedOut.status, "timeout");

  const controller = new AbortController();
  const cancelledRun = runPlanner(
    plannerOptions({ spawnProcess: fakeSpawn(() => undefined).spawnProcess, signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 10);
  assert.equal((await cancelledRun).status, "cancelled");
});

test("progress lines summarize each planner", () => {
  const lines = progressLines(
    [
      { provider: "a", modelId: "one", thinkingLevel: "high" },
      { provider: "b", modelId: "two" },
      { provider: "c", modelId: "three" },
    ],
    [
      {
        spec: { provider: "a", modelId: "one" },
        state: "running",
        startedAt: Date.now() - 65_000,
        toolCalls: 4,
        subagentTasks: 3,
        totalTokens: 12_345,
        costUsd: 0,
        lastActivity: "read x.ts",
      },
      {
        spec: { provider: "b", modelId: "two" },
        state: "done",
        startedAt: 0,
        endedAt: 30_000,
        toolCalls: 9,
        subagentTasks: 0,
        totalTokens: 0,
        costUsd: 0,
      },
      undefined,
    ],
  );
  assert.match(lines[1] ?? "", /^… a\/one:high · 1m 0[45]s · 4 tool calls · 3 subagents · 12k tokens · read x\.ts$/u);
  assert.match(lines[2] ?? "", /^✓ b\/two · 30s · 9 tool calls · done$/u);
  assert.equal(lines[3], "  c/three · waiting");
});

test("the plan-complete hook receives Claude-style JSON and the plan file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-hook-"));
  try {
    const script = join(directory, "hook.sh");
    const out = join(directory, "out.json");
    await writeFile(
      script,
      `#!/bin/sh\ninput=$(cat)\nprintf '%s' "$input" > "${out}"\nfile=$(printf '%s' "$input" | sed -E 's/.*"filePath":"([^"]+)".*/\\1/')\ncp "$file" "${directory}/plan-copy.md"\n`,
    );
    await runPlanCompleteHook({
      command: ["sh", script],
      plan: "# Plan",
      cwd: directory,
      model: { provider: "anthropic", modelId: "claude-opus-5-5" },
    });
    const payload = JSON.parse(await readFile(out, "utf8"));
    assert.equal(payload.cwd, directory);
    assert.equal(payload.tool_name, "plan_mode_complete");
    assert.equal(payload.tool_input.plan, "# Plan");
    assert.equal(payload.model, "anthropic/claude-opus-5-5");
    assert.equal(await readFile(join(directory, "plan-copy.md"), "utf8"), "# Plan\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const SOL = { provider: "openai-codex", id: "gpt-6-sol" };
const SONNET = { provider: "anthropic", id: "claude-sonnet-5" };

function multiPlanHarness(outcome: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  const calls: Record<string, unknown[]> = { choosePlanners: [], run: [], compare: [], ready: [] };
  const plannerCandidates: PlanCandidate[] = [
    {
      id: "A",
      label: "anthropic/claude-opus-5-5",
      origin: "planner",
      model: { provider: "anthropic", modelId: "claude-opus-5-5" },
      status: "done",
      plan: "# Plan A",
    },
    {
      id: "B",
      label: "openai-codex/gpt-6-sol",
      origin: "planner",
      model: { provider: "openai-codex", modelId: "gpt-6-sol" },
      status: "done",
      plan: "# Plan B",
    },
  ];
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        planners: [
          { provider: "anthropic", modelId: "claude-opus-5-5" },
          { provider: "openai-codex", modelId: "gpt-6-sol" },
        ],
        ...settings,
      },
    }),
    loadInteractiveUi: async () =>
      ({
        choosePlanners: async (_ctx: unknown, options: { preselected: unknown[] }) => {
          calls.choosePlanners?.push(options);
          return options.preselected;
        },
        runPlannersWithProgress: async (_ctx: unknown, options: { specs: unknown[] }) => {
          calls.run?.push(options.specs);
          return plannerCandidates;
        },
        showCandidateComparison: async (_ctx: unknown, set: { candidates: PlanCandidate[] }) => {
          calls.compare?.push(set);
          if (outcome.kind === "use") return { kind: "use", candidate: set.candidates[outcome.index as number] };
          if (outcome.kind === "synthesize") {
            return { kind: "synthesize", candidates: set.candidates, guidance: outcome.guidance };
          }
          return { kind: "close" };
        },
        showReadyPlanMenu: async (_ctx: unknown, options: unknown) => {
          calls.ready?.push(options);
        },
      }) as never,
  });
  const branch: unknown[] = [message("user", "Add a cache layer")];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: OPUS,
    sessionManager: {
      getSessionId: () => "multi-plan-session",
      getSessionName: () => undefined,
      getBranch: () => branch,
      getEntries: () => branch,
    },
    modelRegistry: {
      getAvailable: () => [OPUS, SOL, SONNET],
      find: (provider: string, id: string) =>
        [OPUS, SOL, SONNET].find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    },
  });
  return { mock, context, calls, branch };
}

test("/plan multi runs the configured planners and using a candidate opens the ready menu with its model", async () => {
  const { mock, context, calls, branch } = multiPlanHarness(
    { kind: "use", index: 1 },
    {
      implementationModelMap: {
        "openai-codex/gpt-6-sol": { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" },
      },
    },
  );
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("multi Add a cache layer", context.ctx);

  assert.equal(calls.run?.length, 1);
  assert.equal((calls.run?.[0] as unknown[] | undefined)?.length, 2);
  const taskMessage = mock.sentMessages.find(
    (sent) => (sent.message as { customType?: string }).customType === MULTI_TASK_MESSAGE_TYPE,
  );
  assert.match(String((taskMessage?.message as { content?: string } | undefined)?.content), /Add a cache layer/u);
  const candidatesEntry = mock.entries.find((entry) => entry.customType === CANDIDATES_ENTRY_TYPE);
  assert.equal((candidatesEntry?.data as { candidates: unknown[] } | undefined)?.candidates.length, 2);
  const selected = mock.sentMessages.find(
    (sent) => (sent.message as { customType?: string }).customType === "plan-mode-selected-plan",
  );
  assert.match(String((selected?.message as { content?: string } | undefined)?.content), /Selected plan B.*# Plan B/su);

  const state = mock.entries.filter((entry) => entry.customType === "plan-mode-state").at(-1)?.data as {
    enabled: boolean;
    latestPlan?: string;
    latestPlanModel?: unknown;
  };
  assert.equal(state.enabled, true);
  assert.equal(state.latestPlan, "# Plan B");
  assert.deepEqual(state.latestPlanModel, { provider: "openai-codex", modelId: "gpt-6-sol" });
  assert.equal(calls.ready?.length, 1);
  const readyOptions = calls.ready?.[0] as { implementation: { planModel: unknown; resolved: { model: unknown } } };
  assert.deepEqual(readyOptions.implementation.planModel, { provider: "openai-codex", modelId: "gpt-6-sol" });
  assert.deepEqual(readyOptions.implementation.resolved.model, { provider: "anthropic", modelId: "claude-sonnet-5" });

  branch.push({ type: "custom", customType: CANDIDATES_ENTRY_TYPE, data: candidatesEntry?.data });
  await mock.commands.get("plan")?.handler("compare", context.ctx);
  assert.equal(calls.compare?.length, 2, "/plan compare reopens the stored candidates");
  assert.equal(calls.run?.length, 1);
});

test("synthesis sends one Plan-mode prompt with every candidate and the user's guidance", async () => {
  const { mock, context } = multiPlanHarness({ kind: "synthesize", guidance: "Prefer A's migrations" });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("multi Add a cache layer", context.ctx);

  const prompt = mock.sentUserMessages.at(-1)?.text ?? "";
  assert.match(prompt, /Guidance from the user: Prefer A's migrations/u);
  assert.match(prompt, /<candidate id="A"[^>]*>\n# Plan A/u);
  assert.match(prompt, /<candidate id="B"[^>]*>\n# Plan B/u);
});

test("comparing from a ready plan adds it as candidate A and skips its model by default", async () => {
  const { mock, context, calls } = multiPlanHarness({ kind: "close" });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await complete("call", { plan: "# Session plan" }, undefined, undefined, context.ctx);
  await mock.commands.get("plan")?.handler("compare", context.ctx);

  const chosen = calls.choosePlanners?.[0] as { preselected: Array<{ modelId: string }> };
  assert.deepEqual(
    chosen.preselected.map((spec) => spec.modelId),
    ["gpt-6-sol"],
  );
  const set = calls.compare?.[0] as { candidates: PlanCandidate[] };
  assert.equal(set.candidates[0]?.origin, "session");
  assert.equal(set.candidates[0]?.plan, "# Session plan");
  assert.match(context.notifications.at(-1)?.message ?? "", /Reopen them with \/plan compare/u);
});

test("a planner subprocess enters Plan mode on its own at session start", async () => {
  const previous = process.env[PLANNER_ENV];
  process.env[PLANNER_ENV] = "1";
  try {
    const mock = createMockPi({ activeTools: ["read", "bash"] });
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    const context = createMockContext({ mode: "json", hasUI: false });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    const state = mock.entries.filter((entry) => entry.customType === "plan-mode-state").at(-1)?.data as {
      enabled: boolean;
    };
    assert.equal(state.enabled, true);
  } finally {
    if (previous === undefined) delete process.env[PLANNER_ENV];
    else process.env[PLANNER_ENV] = previous;
  }
});
