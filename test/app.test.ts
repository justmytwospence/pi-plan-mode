import assert from "node:assert/strict";
import { test } from "vitest";
import { LanesPage, type MergerPane } from "../src/app/lanes-page.js";
import { OptionsPage } from "../src/app/options-page.js";
import type { PlannerAgent } from "../src/planner/agent.js";
import { PlannerTrace } from "../src/planner-trace.js";
import { SubagentTracker } from "../src/subagent-progress.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as never;
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", tab: "\t" };
const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);

test("the options page cycles the highlighted value with ←/→ and ctrl+h/ctrl+l, and edits text rows", () => {
  let level = 0;
  let task = "";
  let next = 0;
  let back = 0;
  const levels = ["low", "medium", "high"];
  const page = new OptionsPage(theme, {
    title: "Plan",
    step: "Settings",
    rows: [
      {
        id: "task",
        label: "Task",
        value: () => task,
        text: { get: () => task, set: (value) => (task = value) },
        description: "What to plan.",
      },
      {
        id: "effort",
        label: "Effort",
        value: () => levels[level] ?? "",
        cycle: (direction) => {
          level = (level + direction + levels.length) % levels.length;
        },
        description: "How hard.",
      },
    ],
    next: { label: "next", run: () => next++ },
    back: { label: "close", run: () => back++ },
    rowsAvailable: () => 20,
    requestRender: () => undefined,
  });
  page.handleInput(KEY.down);
  page.handleInput(KEY.right);
  page.handleInput(ctrl("l"));
  assert.equal(level, 2);
  page.handleInput(ctrl("h"));
  page.handleInput(KEY.left);
  assert.equal(level, 0);
  const lines = page.render(80);
  assert.equal(lines.length, 20, "the page fills the screen");
  assert.ok(lines.some((line) => line.includes("‹ low ›")));
  assert.ok(lines.some((line) => line.includes("Settings")));

  page.handleInput(KEY.up);
  page.handleInput(KEY.enter);
  assert.equal(page.typing, true);
  for (const char of "add a cache") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.equal(task, "add a cache");
  page.handleInput(KEY.tab);
  assert.equal(next, 1);
  page.handleInput(KEY.escape);
  assert.equal(back, 1);
});

function fakeAgent(id: string, extra: Partial<PlannerAgent> = {}): PlannerAgent {
  const trace = new PlannerTrace();
  trace.note("started");
  return {
    id,
    name: `Model ${id}`,
    spec: { provider: "p", modelId: id, thinkingLevel: "high" },
    trace,
    subagents: new SubagentTracker(id),
    status: "idle",
    working: false,
    stats: { startedAt: 0, endedAt: 1000, toolCalls: 0, subagentTasks: 0, totalTokens: 0, costUsd: 0 },
    revision: 0,
    lastReply: "",
    pending: undefined,
    plan: undefined,
    answer: () => undefined,
    ...extra,
  } as unknown as PlannerAgent;
}

function lanesPage(agents: PlannerAgent[], merger?: () => MergerPane | undefined) {
  const said: [string, string][] = [];
  const actions: string[] = [];
  let hidden = 0;
  const page = new LanesPage(theme, {
    title: "Plan",
    task: () => "add a cache",
    agents: () => agents,
    ...(merger ? { merger } : {}),
    sayToMerger: (text) => said.push(["M", text]),
    actions: () => [
      { id: "implement:A", label: "Implement A…", description: "implement" },
      { id: "export:A", label: "Export A…", description: "export", input: { placeholder: "path", initial: "PLAN.md" } },
    ],
    onAction: (id, text) => actions.push(text === undefined ? id : `${id}=${text}`),
    say: (agent, text) => said.push([agent.id, text]),
    hide: () => hidden++,
    stopAll: () => undefined,
    rowsAvailable: () => 30,
    requestRender: () => undefined,
  });
  return { page, said, actions, hidden: () => hidden };
}

test("lanes sit side by side, and what you type goes to the focused planner", () => {
  const a = fakeAgent("A", { plan: "# Plan A\n\nDo it.", revision: 1 } as never);
  const b = fakeAgent("B", { status: "working", working: true } as never);
  const { page, said } = lanesPage([a, b]);
  const lines = page.render(120);
  assert.equal(lines.length, 30);
  assert.ok(lines.some((line) => line.includes("A · Model A high") && line.includes("B · Model B high")));
  assert.ok(lines.some((line) => line.includes("# Plan A") || line.includes("Plan A")));
  assert.equal(page.step(), "Planning", "someone is still working");
  for (const char of "use sh") page.handleInput(char);
  page.handleInput(KEY.enter);
  page.handleInput(KEY.tab);
  for (const char of "faster") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [
    ["A", "use sh"],
    ["B", "faster"],
  ]);
});

test("a pending question is answered in its lane, by picking or typing", () => {
  const answers: unknown[] = [];
  const a = fakeAgent("A", {
    status: "asking",
    working: true,
    pending: {
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
        {
          id: "tests",
          header: "Tests",
          question: "Tests?",
          options: [
            { label: "Yes", description: "y" },
            { label: "No", description: "n" },
          ],
        },
      ],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  const { page } = lanesPage([a]);
  assert.ok(page.render(100).some((line) => line.includes("? Language (1/2)")));
  page.handleInput(KEY.down);
  page.handleInput(KEY.enter);
  for (const char of "only unit tests") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.deepEqual(answers, [
    [
      { id: "lang", header: "Language", question: "Which?", answer: "Node", wasCustom: false, optionIndex: 2 },
      { id: "tests", header: "Tests", question: "Tests?", answer: "only unit tests", wasCustom: true },
    ],
  ]);
});

test("Tab reaches the actions; an action with input asks for it; Esc offers Hide", () => {
  const a = fakeAgent("A", { plan: "# Plan", revision: 1 } as never);
  const { page, actions, hidden } = lanesPage([a]);
  page.handleInput(KEY.tab);
  page.handleInput(KEY.enter);
  page.handleInput(KEY.right);
  page.handleInput(KEY.enter);
  page.handleInput(KEY.enter);
  assert.deepEqual(actions, ["implement:A", "export:A=PLAN.md"]);
  page.handleInput(KEY.escape);
  assert.ok(page.render(100).some((line) => line.includes("Hide (keep the plans)")));
  page.handleInput(KEY.enter);
  assert.equal(hidden(), 1);
});

test("with two planners, M's pane sits below the lanes: Tab reaches it, and it grows while focused", () => {
  const a = fakeAgent("A", { plan: "# Plan A", revision: 1 } as never);
  const b = fakeAgent("B", { status: "working", working: true } as never);
  const pane: MergerPane = { agent: undefined, name: "Model M high", ready: false };
  const { page, said } = lanesPage([a, b], () => pane);
  const mergerHeight = (lines: string[]) => {
    const top = lines.findIndex((line) => line.includes("M · merger · Model M high"));
    const bottom = lines.findIndex((line, index) => index > top && line.startsWith("› "));
    return bottom - top + 1;
  };
  let lines = page.render(120);
  assert.equal(lines.length, 30);
  assert.ok(lines.some((line) => line.includes("waiting for both plans")));
  assert.equal(mergerHeight(lines), 6, "collapsed while you are in a lane");

  page.handleInput(KEY.tab);
  page.handleInput(KEY.tab);
  lines = page.render(120);
  assert.equal(lines.length, 30);
  assert.ok(mergerHeight(lines) > 6, "grows while focused");
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [], "nothing to merge until both plans are in");

  pane.ready = true;
  assert.ok(page.render(120).some((line) => line.includes("⏎ compare")));
  page.handleInput(KEY.enter);
  for (const char of "which is safer?") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [
    ["M", ""],
    ["M", "which is safer?"],
  ]);

  // Once M has started it is a lane of its own: its questions, its plan, ctrl+o for its chat.
  const answers: unknown[] = [];
  pane.agent = fakeAgent("M", {
    status: "asking",
    working: true,
    pending: {
      questions: [{ id: "q", header: "Store", question: "Which?", options: [{ label: "Redis", description: "r" }] }],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  assert.ok(page.render(120).some((line) => line.includes("? Store")));
  page.handleInput(KEY.enter);
  assert.equal(answers.length, 1);
  Object.assign(pane.agent, { status: "idle", working: false, pending: undefined, plan: "# Merged", revision: 1 });
  lines = page.render(120);
  assert.ok(lines.some((line) => line.includes("# Merged") || line.includes("Merged")));
  assert.ok(lines.some((line) => line.includes("^o chat")));
  page.handleInput(KEY.tab);
  assert.ok(
    page.render(120).some((line) => line.includes("Implement A…")),
    "Tab goes on to the actions",
  );
});

test("with one planner there is no merger pane", () => {
  const { page } = lanesPage([fakeAgent("A", { plan: "# Plan", revision: 1 } as never)], () => undefined);
  assert.ok(!page.render(100).some((line) => line.includes("merger")));
  page.handleInput(KEY.tab);
  assert.ok(
    page.render(100).some((line) => line.includes("do it")),
    "Tab goes straight to the actions",
  );
});

test("the top of the planning screen shows each planner's live stats, and M's once it has started", () => {
  const a = fakeAgent("A", {
    status: "working",
    working: true,
    stats: {
      startedAt: Date.now() - 134_000,
      toolCalls: 38,
      subagentTasks: 4,
      totalTokens: 182_000,
      costUsd: 1.24,
      lastActivity: "read src/plan.ts",
    },
  } as never);
  const b = fakeAgent("B", { plan: "# Plan B", revision: 2 } as never);
  const pane: MergerPane = { agent: undefined, name: "Model M high", ready: true };
  const { page } = lanesPage([a, b], () => pane);
  let lines = page.render(140);
  const row = (id: string) => lines.find((line) => line.includes(` ${id} Model ${id} high`)) ?? "";
  assert.match(row("A"), /2m 14s\s+38 tools\s+4 subagents\s+182k tok\s+\$1\.24\s+read src\/plan\.ts/u);
  assert.match(row("B"), /✓ B Model B high\s+1s.*plan ready \(v2\)/u);
  assert.equal(row("M"), "", "no row for M before it starts");
  assert.equal(lines.length, 30);

  pane.agent = fakeAgent("M", { status: "asking", working: true } as never);
  lines = page.render(140);
  assert.match(lines.find((line) => line.includes("? M merger")) ?? "", /\? M merger · Model M high.*asking you/u);
  assert.equal(lines.length, 30);
});
