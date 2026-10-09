import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/index.js";
import type { PlannerSessionFactory } from "../src/planner/session.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
const SONNET = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Planner sessions that submit `# Plan from <model>` for any prompt (or, with `ask`, ask first). */
function fakeSessions(ask = false, failFirst?: { model: string; error: string }) {
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
          if (
            failFirst?.model === options.spec.modelId &&
            prompts.filter((p) => p.model === failFirst.model).length === 1
          ) {
            emit({
              type: "message_end",
              message: { role: "assistant", content: [], stopReason: "error", errorMessage: failFirst.error },
            });
            emit({ type: "agent_settled" });
            return;
          }
          if (ask) {
            await tools.get("plan_mode_question")?.execute("q", {
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
            });
          }
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

function setup(
  options: {
    ask?: boolean;
    failFirst?: { model: string; error: string };
    login?: (providerId: string, show: (dialog: never) => void) => Promise<void>;
  } = {},
) {
  const mock = createMockPi({ thinkingLevel: "high" });
  const sessions = fakeSessions(options.ask, options.failFirst);
  planMode(mock.pi, {
    ...(options.login ? { login: options.login } : {}),
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
  assert.match(screen, /Task\s*\n {3}─+\n {4}add a cache/u, "the task is a box under its label");

  // Tab moves into the task's multi-line editor and back out.
  app.handleInput("\t");
  screen = app.render().join("\n");
  assert.match(screen, /shift\+⏎ new line/u);
  app.handleInput("\u001b[F");
  for (const char of " and its tests") app.handleInput(char);
  app.handleInput("\t");
  screen = app.render().join("\n");
  assert.match(screen, /\n {4}add a cache and its tests/u);
  assert.doesNotMatch(screen, /shift\+⏎ new line/u, "editing ended");
  assert.match(screen, /Planner A\s+‹ Claude Sonnet 5\.5 ›/u, "the rows have focus again");
  assert.doesNotMatch(screen, /default/u, "efforts are real levels");

  // Subagents get their own effort row, under theirs, once they have a model.
  const underSubagents = () => {
    const lines = app.render();
    const index = lines.findIndex((line) => line.includes("subagents"));
    return { subagents: lines[index] ?? "", next: lines[index + 1] ?? "" };
  };
  assert.match(underSubagents().next, /Planner B/u, "no subagent effort without subagents");
  for (let row = 0; row < 2; row += 1) app.handleInput("\u001b[B");
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
  for (let row = 0; row < 3; row += 1) app.handleInput("\u001b[A");

  // Enter on a row goes on (Tab would move to the task).
  app.handleInput("\r");
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
  assert.doesNotMatch(screen, /Merger/u, "no merger model: your main agent merges");
  app.handleInput("\r");
  await flush();
  screen = app.render().join("\n");
  assert.match(screen, /B · Claude Opus 5\.5/u);
  assert.equal(sessions.prompts.length, 2);
  assert.match(sessions.prompts[1]?.text ?? "", /Another model is planning the same task/u);

  // Each plan landed in your main conversation, in full, without starting a turn.
  type Delivery = { content: string; details: { kind: string; id: string; revision?: number } };
  const deliveries = () =>
    mock.sentMessages
      .filter((sent) => (sent.message as { customType?: string }).customType === "plan-mode-plan")
      .map((sent) => sent.message as Delivery);
  assert.deepEqual(
    deliveries().map((delivery) => [delivery.details.id, delivery.details.revision]),
    [
      ["A", 1],
      ["B", 1],
    ],
  );
  assert.match(deliveries()[1]?.content ?? "", /<plan id="B" version="1">\n# Plan from claude-opus-5-5 #2/u);
  assert.match(deliveries()[1]?.content ?? "", /Planner A's plan is earlier in this conversation\./u);
  assert.deepEqual(mock.sentMessages[0]?.options, { triggerTurn: false });
  // Your main agent has its run tools while the run is active.
  const tools = () => mock.rawPi.getActiveTools();
  assert.ok(tools().includes("plan_ask_planner") && tools().includes("plan_submit_merged"));
  assert.doesNotMatch(app.render().join("\n"), /Merge into/u);

  // M, below the lanes, is your main agent: what you type there goes to your main session, and the
  // pane shows your agent's reply as it streams (fed by your main session's events).
  const mainEvent = async (type: string, payload: Record<string, unknown> = {}) => {
    for (const handler of mock.events.get(type) ?? []) await handler({ type, ...payload }, context.ctx);
  };
  screen = app.render().join("\n");
  assert.match(screen, /M · main agent · Claude Sonnet 5\.5/u);
  assert.match(screen, /Plan B delivered to your agent\./u, "M's pane notes each delivery");
  assert.match(screen, /2 planners · main agent/u);
  app.handleInput("\t");
  app.handleInput("\t");
  for (const char of "which is safer?") app.handleInput(char);
  app.handleInput("\r");
  assert.equal(mock.sentUserMessages.at(-1)?.text, "which is safer?");
  // Your session's events, in the order Pi emits them.
  const user = { role: "user", content: "which is safer?" };
  const reply = { role: "assistant", content: [{ type: "text", text: "B's invalidation is safer." }] };
  await mainEvent("agent_start");
  await mainEvent("message_start", { message: user });
  await mainEvent("message_end", { message: user });
  await mainEvent("message_start", { message: { role: "assistant", content: [] } });
  await mainEvent("message_update", {
    message: reply,
    assistantMessageEvent: { type: "text_delta", delta: "B's invalidation is safer." },
  });
  screen = app.render().join("\n");
  assert.match(screen, /which is safer\?/u, "your message, as Pi shows it");
  assert.match(screen, /B's invalidation is safer\./u);
  assert.match(screen, /M main agent · Claude Sonnet 5\.5.*writing/u, "its stats row shows it working");
  assert.doesNotMatch(screen, /Write plan M/u, "not offered while M is working");
  await mainEvent("agent_end", { messages: [] });

  // With both plans in, Write plan M comes first; it asks M for the merged plan and moves to M.
  screen = app.render().join("\n");
  assert.match(screen, /Write plan M · Implement A… · Implement B…/u);
  app.handleInput("\t");
  app.handleInput("\r");
  assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /^Write plan M: merge the planners' plans/u);
  assert.match(app.render().join("\n"), /Tab to the actions and choose Write plan M/u, "back on M's pane");

  // Your main agent asks planner A something; A answers (here it also resubmits), and v2 is delivered.
  const tool = (name: string) =>
    mock.tools.find((candidate) => (candidate as { name: string }).name === name) as unknown as {
      execute(...args: unknown[]): Promise<{ content: Array<{ text: string }> }>;
    };
  const asked = await tool("plan_ask_planner").execute(
    "t1",
    { planner: "a", message: "why this cache?" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.match(asked.content[0]?.text ?? "", /Planner A answered:[\s\S]*resubmitted its plan as v2/u);
  assert.match(sessions.prompts.at(-1)?.text ?? "", /^\[From the user's main agent[\s\S]*why this cache\?$/u);
  assert.match(app.render().join("\n"), /main agent › why this cache\?|A · Claude Sonnet 5\.5 low · v2/u);
  assert.deepEqual(deliveries().at(-1)?.details, {
    kind: "plan",
    id: "A",
    model: "Claude Sonnet 5.5 low",
    revision: 2,
    lines: 1,
  });
  const busy = await tool("plan_ask_planner").execute(
    "t2",
    { planner: "C", message: "?" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.match(busy.content[0]?.text ?? "", /There is no planner C; this run has A and B\./u);

  // When you ask for it, your main agent records the merged plan: M, first among the plans.
  const recorded = await tool("plan_submit_merged").execute(
    "t3",
    { plan: "# Merged plan" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.match(recorded.content[0]?.text ?? "", /^Recorded as plan M\./u);
  screen = app.render().join("\n");
  assert.match(screen, /✓ M main agent · Claude Sonnet 5\.5.*plan ready/u, "M's row shows its merged plan");
  assert.match(screen, /# Merged plan|Merged plan/u, "and its pane shows it");
  assert.match(
    screen,
    /Implement M… · Revise plan M · Implement A… · Implement B…/u,
    "the merged plan comes first, and M can revise it",
  );
  assert.match(screen, /Save & close/u);

  // Implement the merged plan (focus is on M: one Tab to the actions).
  app.handleInput("\t");
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /● Implement/u);
  assert.match(screen, /M \(merged\) · Claude Sonnet 5\.5/u);
  app.handleInput("\r");
  await opened;
  await flush();
  assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Merged plan/u);
  const stored = mock.entries.filter((entry) => entry.customType === "plan-run").at(-1)?.data as {
    state: string;
    merged?: { plan: string; revision: number };
    planners: Array<{ id: string; delivered?: { revision: number } }>;
  };
  assert.equal(stored.state, "implemented");
  assert.equal(stored.merged?.plan, "# Merged plan");
  assert.deepEqual(
    stored.planners.map((planner) => [planner.id, planner.delivered?.revision]),
    [
      ["A", 2],
      ["B", 1],
    ],
  );
  assert.ok(!tools().includes("plan_ask_planner"), "the run tools go away with the run");
});

test("a restored run keeps its deliveries and plan M, turns the tools back on, and delivers older runs' plans once", async () => {
  const { mock, context, harness } = setup();
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
          delivered: { revision: 1, mark: 0 },
        },
        // Saved before deliveries existed: delivered now, once.
        {
          id: "B",
          spec: "anthropic/claude-opus-5-5:high",
          name: "Claude Opus 5.5",
          sessionFile: "/b.jsonl",
          plan: "# B",
          revision: 2,
        },
      ],
      merged: { plan: "# M", revision: 1, name: "Claude Opus 5.5", spec: "anthropic/claude-opus-5-5" },
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await flush();
  const delivered = mock.sentMessages.map((sent) => (sent.message as { details?: { id: string } }).details?.id);
  assert.deepEqual(delivered, ["B"]);
  // Plans restored with the run are not announced again.
  assert.deepEqual(
    context.notifications.filter((note) => /is ready/u.test(note.message)),
    [],
  );
  assert.ok(mock.rawPi.getActiveTools().includes("plan_submit_merged"));

  const opened = mock.commands.get("plan")?.handler("", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  const screen = app.render().join("\n");
  assert.match(screen, /M · main agent · Claude Sonnet 5\.5/u, "M is your main agent, on its model");
  assert.match(screen, /✓ M main agent · Claude Sonnet 5\.5.*plan ready/u, "with plan M restored");
  assert.match(screen, /Implement M…/u);
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

test("a planner asking you something shows in herdr as blocked until it stops asking", async () => {
  const { mock, context } = setup({ ask: true });
  const blocked: unknown[] = [];
  mock.eventBus.on("herdr:blocked", (data) => blocked.push(data));
  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r4",
      createdAt: 1,
      task: "add a cache",
      state: "active",
      planners: [
        { id: "A", spec: "anthropic/claude-sonnet-5-5:low", name: "S", sessionFile: "/a.jsonl", turn: "interrupted" },
      ],
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await flush();
  assert.deepEqual(blocked, [{ active: true, label: "Planner question" }]);
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, context.ctx);
  await flush();
  assert.deepEqual(blocked, [{ active: true, label: "Planner question" }, { active: false }]);
});

test("a planner refused for its login offers to log in again from /plan, then tries again", async () => {
  const logins: string[] = [];
  const { mock, context, sessions, harness } = setup({
    failFirst: { model: "claude-sonnet-5-5", error: "Encountered invalidated oauth token for user, failing request" },
    login: async (providerId) => {
      logins.push(providerId);
    },
  });
  const opened = mock.commands.get("plan")?.handler("add a cache", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  app.handleInput("\r");
  app.handleInput("\r");
  app.handleInput("\r");
  await flush();
  let screen = app.render().join("\n");
  assert.match(screen, /failed: Encountered invalidated oauth token/u);
  assert.match(screen, /Log in to anthropic…/u, "a login action for the planner's provider");
  // Tab to the actions; the login comes first.
  app.handleInput("\t");
  app.handleInput("\r");
  await flush();
  assert.deepEqual(logins, ["anthropic"]);
  assert.equal(sessions.prompts.length, 2, "the planner tried again");
  assert.match(sessions.prompts[1]?.text ?? "", /previous turn failed with an error/u);
  screen = app.render().join("\n");
  assert.doesNotMatch(screen, /Log in to anthropic/u, "gone once the planner recovered");
  assert.match(screen, /plan ready/u);
  assert.ok(
    context.notifications.some((note) => /Logged in to anthropic\. Planner A is trying again\./u.test(note.message)),
  );
  app.handleInput("\u001b");
  app.handleInput("\r");
  await opened;
});
