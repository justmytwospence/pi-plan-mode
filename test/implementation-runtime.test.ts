import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi, selectImplementHere } from "./support.js";

const PLAN = "# Plan\n\n1. Do the thing.";
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" };
const SONNET = { provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet" };
const GPT = { provider: "openai-codex", id: "gpt-6-sol", name: "Sol" };

function registry(available = [OPUS, SONNET, GPT], authOk = true) {
  return {
    getAvailable: () => available,
    find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
    getApiKeyAndHeaders: async () => (authOk ? { ok: true as const } : { ok: false as const, error: "no key" }),
  };
}

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
  const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("complete", { plan: PLAN }, undefined, undefined, ctx);
}

function settingsWith(extra: Record<string, unknown>) {
  return {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, ...extra },
    }),
  };
}

test("implementing here switches to the mapped model and effort before sending the handoff", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(
    mock.pi,
    settingsWith({
      implementationModelMap: {
        "anthropic/claude-opus-5-5": { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" },
      },
    }),
  );
  const order: string[] = [];
  const originalSetModel = mock.rawPi.setModel;
  mock.rawPi.setModel = async (model: unknown) => {
    order.push("setModel");
    return originalSetModel(model);
  };
  const originalSend = mock.rawPi.sendUserMessage;
  mock.rawPi.sendUserMessage = (text: string, options?: unknown) => {
    order.push("send");
    originalSend(text, options);
  };
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: OPUS,
    modelRegistry: registry(),
    select: async (_title: string, options: string[]) => selectImplementHere(options),
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);

  assert.deepEqual(mock.setModels, [SONNET]);
  assert.equal(mock.thinkingLevel, "high");
  assert.deepEqual(order, ["setModel", "send"]);
  assert.equal(mock.sentUserMessages.length, 1);
});

test("/plan implement uses the map without a menu and records the plan model", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(
    mock.pi,
    settingsWith({
      implementationModelMap: { "openai-codex/gpt-6-sol": { provider: "anthropic", modelId: "claude-sonnet-5" } },
      defaultImplementationThinkingLevel: "low",
    }),
  );
  const context = createMockContext({ mode: "rpc", hasUI: true, model: GPT, modelRegistry: registry() });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  const readyState = mock.entries.at(-1)?.data as { latestPlanModel?: unknown };
  assert.deepEqual(readyState.latestPlanModel, { provider: "openai-codex", modelId: "gpt-6-sol" });

  await mock.commands.get("plan")?.handler("implement", context.ctx);

  assert.deepEqual(mock.setModels, [SONNET]);
  assert.equal(mock.thinkingLevel, "low");
  assert.equal(mock.sentUserMessages.length, 1);
});

test("an unauthenticated implementation model keeps the current model and still implements", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(
    mock.pi,
    settingsWith({
      implementationModelMap: { "anthropic/claude-opus-5-5": { provider: "anthropic", modelId: "claude-sonnet-5" } },
    }),
  );
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: OPUS,
    modelRegistry: registry(undefined, false),
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);

  assert.deepEqual(mock.setModels, []);
  assert.equal(mock.sentUserMessages.length, 1);
  assert.ok(context.notifications.some((notice) => /could not be authenticated/u.test(notice.message)));
});

test("a saved plan keeps its authoring model for the implementation default", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi, settingsWith({}));
  const context = createMockContext({ mode: "rpc", hasUI: true, model: GPT, modelRegistry: registry() });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("save", context.ctx);
  const saved = mock.entries.at(-1)?.data as { savedPlan?: { model?: unknown } };
  assert.deepEqual(saved.savedPlan?.model, { provider: "openai-codex", modelId: "gpt-6-sol" });
});
