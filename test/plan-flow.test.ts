import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/index.js";
import type { PlannerSessionFactory } from "../src/planner/session.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

const SONNET = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Planner sessions that submit `# Plan from <model>` for any prompt. */
function fakeSessions() {
  const prompts: Array<{ model: string; text: string }> = [];
  const factory: PlannerSessionFactory = async (_host, options) => {
    const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
    (options.policy as (pi: unknown) => void)({
      registerTool: (tool: { name: string; execute(...args: unknown[]): Promise<unknown> }) =>
        tools.set(tool.name, tool),
      on: () => undefined,
      getAllTools: () => [],
    });
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    return {
      session: {
        isStreaming: false,
        prompt: async (text: string) => {
          prompts.push({ model: options.spec.modelId, text });
          emit({ type: "agent_start" });
          await tools
            .get("plan_mode_complete")
            ?.execute("1", { plan: `# Plan from ${options.spec.modelId} #${prompts.length}` });
          emit({ type: "agent_settled" });
        },
        steer: async () => undefined,
        abort: async () => undefined,
      } as never,
      file: `/sessions/${options.spec.modelId}.jsonl`,
      subscribe: (listener) => {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      dispose: () => undefined,
    };
  };
  return { factory, prompts };
}

function setup() {
  const mock = createMockPi({ thinkingLevel: "high" });
  const sessions = fakeSessions();
  planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit",
      planners: [{ provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "low" }],
      jevToolSelection: false,
    }),
    createSession: sessions.factory,
  });
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  const sent: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    model: SONNET,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 140, undefined, 40);
      return harness.resultPromise;
    },
    modelRegistry: {
      getAvailable: () => [SONNET, OPUS],
      find: (provider: string, id: string) =>
        [SONNET, OPUS].find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    },
    sessionManager: {
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "earlier" }] }),
      getSessionFile: () => "/main.jsonl",
      getSessionId: () => "main",
    },
  });
  (context.ctx as { sendUserMessage?: unknown }).sendUserMessage = async (text: string) => sent.push(text);
  return { mock, context, sessions, sent, harness: () => harness };
}

test("/plan opens on the settings, goes through tools, plans with one planner, adds a second, and implements", async () => {
  const { mock, context, sessions, harness } = setup();
  const command = mock.commands.get("plan");
  assert.ok(command);
  const opened = command.handler("add a cache", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  let screen = app.render().join("\n");
  assert.match(screen, /● Settings/u);
  assert.match(screen, /Task\s*\n {5}│ add a cache/u, "the task is a block under its label");

  // Enter edits the task in place in a multi-line editor; Enter saves it.
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /shift\+⏎ new line/u);
  for (const char of " and its tests") app.handleInput(char);
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /│ add a cache and its tests/u);
  assert.doesNotMatch(screen, /shift\+⏎ new line/u, "editing ended");
  assert.match(screen, /Planner A\s+Claude Sonnet 5\.5/u);
  assert.doesNotMatch(screen, /default/u, "efforts are real levels");

  // Subagents get their own effort row, under theirs, once they have a model.
  const underSubagents = () => {
    const lines = app.render();
    const index = lines.findIndex((line) => line.includes("subagents"));
    return { subagents: lines[index] ?? "", next: lines[index + 1] ?? "" };
  };
  assert.match(underSubagents().next, /Planner B/u, "no subagent effort without subagents");
  for (let row = 0; row < 3; row += 1) app.handleInput("\u001b[B");
  app.handleInput("\u001b[C");
  let rows = underSubagents();
  assert.match(rows.subagents, /subagents\s+‹ Claude Sonnet 5\.5 ›\s*$/u, "the model row shows only the model");
  assert.match(rows.next, /^ {7}effort\s+medium/u, "subagents start at medium");
  app.handleInput("\u001b[B");
  app.handleInput("\u001b[D");
  rows = underSubagents();
  assert.match(rows.next, /effort\s+‹ low ›/u);
  assert.match(rows.subagents, /Claude Sonnet 5\.5/u, "the effort changes without the model");
  app.handleInput("\u001b[C");
  for (let row = 0; row < 4; row += 1) app.handleInput("\u001b[A");

  app.handleInput("\t");
  screen = app.render().join("\n");
  assert.match(screen, /● Tools/u);
  assert.doesNotMatch(screen, /▶ Start/u, "no start row in the tools");
  app.handleInput("\r");
  assert.match(app.render().join("\n"), /Start planning with 1 planner\?/u);
  app.handleInput("\r");
  await flush();
  screen = app.render().join("\n");
  assert.match(screen, /● Review/u);
  assert.match(screen, /A · Claude Sonnet 5\.5 low/u);
  assert.match(screen, /# Plan from claude-sonnet-5-5|Plan from claude-sonnet-5-5/u);
  assert.equal(sessions.prompts.length, 1);
  assert.match(sessions.prompts[0]?.text ?? "", /add a cache/u);

  // Add a second planner from the actions.
  app.handleInput("\t");
  app.handleInput("\u001b[C");
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /Add a planner/u);
  assert.match(screen, /Merger\s+Claude Sonnet 5\.5 \(as planner A\)/u);
  app.handleInput("\r");
  await flush();
  screen = app.render().join("\n");
  assert.match(screen, /B · Claude Opus 5\.5/u);
  assert.equal(sessions.prompts.length, 2);
  assert.match(sessions.prompts[1]?.text ?? "", /Another model is planning the same task/u);

  // Talk the plans over with M, the merger, in the pane below the lanes (Tab: A, B, M, actions).
  app.handleInput("\t");
  app.handleInput("\t");
  screen = app.render().join("\n");
  assert.match(screen, /M · merger · Claude Sonnet 5\.5 low/u);
  assert.match(screen, /not started/u);
  assert.doesNotMatch(screen, /Merge into/u);
  for (const char of "keep A's cache") app.handleInput(char);
  app.handleInput("\r");
  await flush();
  assert.equal(sessions.prompts.length, 3);
  const briefing = sessions.prompts[2]?.text ?? "";
  assert.match(
    briefing,
    /<plan id="A" model="anthropic\/claude-sonnet-5-5:low" version="1">\n# Plan from claude-sonnet-5-5 #1/u,
  );
  assert.match(
    briefing,
    /<plan id="B" model="anthropic\/claude-opus-5-5[^"]*" version="1">\n# Plan from claude-opus-5-5 #2/u,
  );
  assert.match(briefing, /## The user's message\n\nkeep A's cache$/u);
  screen = app.render().join("\n");
  assert.match(
    screen,
    /# Plan from claude-sonnet-5-5 #3|Plan from claude-sonnet-5-5 #3/u,
    "M's pane shows its merged plan",
  );
  assert.match(screen, /Implement M… · Implement A… · Implement B…/u, "the merged plan comes first");

  // A revises its plan; M gets only the revised plan with your next message.
  app.handleInput("\t");
  app.handleInput("\t");
  for (const char of "smaller") app.handleInput(char);
  app.handleInput("\r");
  await flush();
  assert.match(app.render().join("\n"), /A · Claude Sonnet 5\.5 low · v2/u);
  app.handleInput("\t");
  app.handleInput("\t");
  for (const char of "and now?") app.handleInput(char);
  app.handleInput("\r");
  await flush();
  const update = sessions.prompts.at(-1)?.text ?? "";
  assert.match(update, /<plan id="A" [^>]*version="2">\n# Plan from claude-sonnet-5-5 #4/u);
  assert.doesNotMatch(update, /<plan id="B"/u);
  assert.match(update, /and now\?$/u);

  // Implement the merged plan.
  app.handleInput("\t");
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /● Implement/u);
  assert.match(screen, /M \(merged\) · Claude Sonnet 5\.5 v2/u);
  app.handleInput("\r");
  await opened;
  await flush();
  assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Plan from claude-sonnet-5-5 #5/u);
  const stored = mock.entries.filter((entry) => entry.customType === "plan-run").at(-1)?.data as {
    state: string;
    merger?: { plan?: string; seen?: Record<string, number> };
  };
  assert.equal(stored.state, "implemented");
  assert.deepEqual(stored.merger?.seen, { A: 2, B: 1 });
});

test("a run with a merger comes back after a reload, and M carries on without a second briefing", async () => {
  const { mock, context, sessions, harness } = setup();
  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r1",
      createdAt: 1,
      task: "add a cache",
      state: "active",
      planners: [
        {
          id: "A",
          spec: "anthropic/claude-sonnet-5-5:low",
          name: "Claude Sonnet 5.5",
          sessionFile: "/a.jsonl",
          plan: "# A",
          revision: 1,
        },
        {
          id: "B",
          spec: "anthropic/claude-opus-5-5:high",
          name: "Claude Opus 5.5",
          sessionFile: "/b.jsonl",
          plan: "# B v2",
          revision: 2,
        },
      ],
      merger: {
        id: "M",
        spec: "anthropic/claude-opus-5-5:high",
        name: "Claude Opus 5.5",
        sessionFile: "/m.jsonl",
        seen: { A: 1, B: 1 },
      },
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  const opened = mock.commands.get("plan")?.handler("", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  const screen = app.render().join("\n");
  assert.match(screen, /M · merger · Claude Opus 5\.5 high/u);
  assert.match(screen, /M restored\./u);
  assert.doesNotMatch(screen, /starting/u, "a restored merger waits for you");

  app.handleInput("\t");
  app.handleInput("\t");
  for (const char of "go on") app.handleInput(char);
  app.handleInput("\r");
  await flush();
  const sent = sessions.prompts.at(-1)?.text ?? "";
  assert.match(sent, /<plan id="B" [^>]*version="2">\n# B v2/u);
  assert.doesNotMatch(sent, /<plan id="A"/u);
  assert.doesNotMatch(sent, /## Task/u, "no second briefing");
  assert.match(sent, /go on$/u);

  app.handleInput("\u001b");
  app.handleInput("\r");
  await opened;
});

test("restoring a run resumes the turns a reload cut off or that had failed, and leaves the rest", async () => {
  const { mock, context, sessions } = setup();
  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r2",
      createdAt: 1,
      task: "add a cache",
      state: "active",
      planners: [
        {
          id: "A",
          spec: "anthropic/claude-sonnet-5-5:low",
          name: "Claude Sonnet 5.5",
          sessionFile: "/a.jsonl",
          turn: "interrupted",
        },
        {
          id: "B",
          spec: "anthropic/claude-opus-5-5:high",
          name: "Claude Opus 5.5",
          sessionFile: "/b.jsonl",
          turn: "failed",
        },
      ],
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await flush();
  const resumed = sessions.prompts.map((prompt) => prompt.model);
  assert.deepEqual(resumed.sort(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.match(
    sessions.prompts.find((prompt) => prompt.model === "claude-sonnet-5-5")?.text ?? "",
    /cut off because the user's pi session restarted.*Carry on from where you left off/su,
  );
  assert.match(
    sessions.prompts.find((prompt) => prompt.model === "claude-opus-5-5")?.text ?? "",
    /previous turn failed with an error/u,
  );
  // Both finished their resumed turns; the saved run no longer marks them as cut off.
  const stored = mock.entries.filter((entry) => entry.customType === "plan-run").at(-1)?.data as {
    planners: Array<{ id: string; turn?: string; plan?: string }>;
  };
  assert.deepEqual(
    stored.planners.map((planner) => [planner.id, planner.turn, Boolean(planner.plan)]),
    [
      ["A", undefined, true],
      ["B", undefined, true],
    ],
  );

  // A planner that was idle (done, or stopped by you) is not resumed.
  const idle = setup();
  idle.mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r3",
      createdAt: 1,
      task: "t",
      state: "active",
      planners: [
        {
          id: "A",
          spec: "anthropic/claude-sonnet-5-5:low",
          name: "S",
          sessionFile: "/a.jsonl",
          plan: "# A",
          revision: 1,
        },
      ],
    },
  });
  for (const handler of idle.mock.events.get("session_start") ?? []) await handler({}, idle.context.ctx);
  await flush();
  assert.equal(idle.sessions.prompts.length, 0);
});
