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
          await tools.get("plan_mode_complete")?.execute("1", { plan: `# Plan from ${options.spec.modelId}` });
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
  assert.match(screen, /Task\s+add a cache/u);
  assert.match(screen, /Planner A\s+Claude Sonnet 5\.5/u);
  assert.doesNotMatch(screen, /default/u, "efforts are real levels");

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
  app.handleInput("\r");
  await flush();
  screen = app.render().join("\n");
  assert.match(screen, /B · Claude Opus 5\.5/u);
  assert.equal(sessions.prompts.length, 2);
  assert.match(sessions.prompts[1]?.text ?? "", /Another model is planning the same task/u);

  // Implement A here.
  app.handleInput("\t");
  app.handleInput("\t");
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /● Implement/u);
  app.handleInput("\r");
  await opened;
  await flush();
  assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Plan from claude-sonnet-5-5/u);
  const stored = mock.entries.filter((entry) => entry.customType === "plan-run").at(-1)?.data as { state: string };
  assert.equal(stored.state, "implemented");
});
