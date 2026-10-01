import assert from "node:assert/strict";
import { test } from "vitest";
import { HERDR_BLOCKED_CHANNEL, HERDR_WORKING_CHANNEL, holdWorking, whileBlocked } from "../src/herdr-blocked.js";
import { runPlannersWithProgress } from "../src/multi-plan-menu.js";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

function recordBlocked(mock: ReturnType<typeof createMockPi>) {
  const seen: Array<{ active: boolean; label?: string }> = [];
  mock.rawPi.events.on(HERDR_BLOCKED_CHANNEL, (data) => {
    seen.push(data as { active: boolean; label?: string });
  });
  return seen;
}

test("whileBlocked emits active then inactive, also when the dialog throws", async () => {
  const seen: unknown[] = [];
  const events = { emit: (_channel: string, data: unknown) => seen.push(data) };
  assert.equal(await whileBlocked(events, "Q", async () => 7), 7);
  await assert.rejects(
    whileBlocked(events, "Q", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(seen, [
    { active: true, label: "Q" },
    { active: false },
    { active: true, label: "Q" },
    { active: false },
  ]);
});

test("whileBlocked survives a throwing listener and a missing bus", async () => {
  const events = {
    emit: () => {
      throw new Error("listener");
    },
  };
  assert.equal(await whileBlocked(events, "Q", async () => "ok"), "ok");
  assert.equal(await whileBlocked(undefined, "Q", async () => "ok"), "ok");
});

test("plan_mode_question holds herdr blocked while the dialog is open", async () => {
  const mock = createMockPi();
  const seen = recordBlocked(mock);
  planMode(mock.pi);
  let blockedDuringDialog = false;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      blockedDuringDialog = seen.length === 1 && seen[0]?.active === true;
      return "1. Small — Only the bug.";
    },
  });
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const execute = mock.tools.find((tool) => tool.name === "plan_mode_question")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(execute);
  const question = {
    id: "scope",
    header: "Scope",
    question: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  };
  await execute("call-1", { questions: [question] }, undefined, undefined, context.ctx);
  assert.equal(blockedDuringDialog, true);
  assert.deepEqual(
    seen.map((event) => event.active),
    [true, false],
  );
});

test("the ready-plan menu holds herdr blocked in pairs", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
  const seen = recordBlocked(mock);
  planMode(mock.pi);
  let blockedDuringMenu = false;
  const context = createMockContext({
    hasUI: true,
    select: async () => {
      blockedDuringMenu = seen.at(-1)?.active === true;
      return "Implement here";
    },
  });
  await mock.commands.get("plan")?.handler("design it", context.ctx);
  await mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", content: "<proposed_plan>\n# Ship it\n</proposed_plan>" }] },
    context.ctx,
  );
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(blockedDuringMenu, true);
  assert.ok(seen.length >= 2);
  assert.equal(seen.filter((event) => event.active).length, seen.filter((event) => !event.active).length);
  assert.equal(seen.at(-1)?.active, false);
  assert.equal(seen[0]?.label, "Plan ready");
});

test("holdWorking emits one active/inactive pair however often it is released", () => {
  const seen: [string, unknown][] = [];
  const release = holdWorking({ emit: (channel, data) => seen.push([channel, data]) }, "Planning");
  release();
  release();
  assert.deepEqual(seen, [
    [HERDR_WORKING_CHANNEL, { active: true, label: "Planning" }],
    [HERDR_WORKING_CHANNEL, { active: false }],
  ]);
  const throwing = {
    emit: () => {
      throw new Error("listener");
    },
  };
  holdWorking(throwing, "x")();
  holdWorking(undefined, "x")();
});

test("planners hold herdr working while they run, released before the result returns", async () => {
  const seen: unknown[] = [];
  let runningWhileHeld = false;
  const context = createMockContext({ mode: "print", hasUI: false });
  const result = await runPlannersWithProgress(context.ctx, {
    specs: [{ provider: "p", modelId: "m" }],
    ids: ["A"],
    isCurrent: () => true,
    events: { emit: (channel: string, data: unknown) => channel === HERDR_WORKING_CHANNEL && seen.push(data) },
    run: async () => {
      runningWhileHeld = seen.length === 1;
      return [];
    },
  } as never);
  assert.ok(result);
  assert.equal(runningWhileHeld, true);
  assert.deepEqual(seen, [{ active: true, label: "Planning" }, { active: false }]);
});
