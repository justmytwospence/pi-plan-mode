import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import {
  type CandidateSet,
  formatSynthesisPrompt,
  latestCandidateSet,
  normalizeCandidateSet,
  PLANNER_TALK_MESSAGE_TYPE,
  type PlanCandidate,
} from "../src/multi-plan.js";
import { type PlannerTurnResult, plannerArgs, runPlanner } from "../src/planner-process.js";
import { PlannerTalk, type TalkMessageDetails } from "../src/planner-talk.js";
import { PlannerTrace } from "../src/planner-trace.js";
import type { TracePane } from "../src/trace-view.js";

const access = {
  shell: true,
  subagents: false,
  extensions: [],
  tools: [],
  scoutExtensions: [],
  scoutTools: [],
};

function planner(id: string, extra: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    id,
    label: `openai-codex/gpt-6-${id.toLowerCase()}:low`,
    origin: "planner",
    model: { provider: "openai-codex", modelId: `gpt-6-${id.toLowerCase()}` },
    thinkingLevel: "low",
    status: "done",
    plan: `# Plan ${id}\n1. step`,
    revision: 1,
    session: { dir: "/tmp/sessions", id: `plan1-${id}` },
    launch: { access },
    durationMs: 1_000,
    toolCalls: 2,
    totalTokens: 100,
    costUsd: 0.01,
    ...extra,
  };
}

test("planners keep their session on disk only when asked, so later turns can resume it", () => {
  const base = { spec: { provider: "p", modelId: "m" }, extensionPath: "/ext", loadUserExtensions: false };
  assert.ok(plannerArgs(base).includes("--no-session"));
  const args = plannerArgs({ ...base, session: { dir: "/tmp/s", id: "plan1-A" } });
  assert.ok(!args.includes("--no-session"));
  assert.deepEqual(args.slice(args.indexOf("--session-dir"), args.indexOf("--session-dir") + 4), [
    "--session-dir",
    "/tmp/s",
    "--session-id",
    "plan1-A",
  ]);
});

test("candidate sets keep planner sessions, launch settings, revisions, and the conversation", () => {
  const set = normalizeCandidateSet({
    version: 1,
    task: "t",
    createdAt: 1,
    candidates: [
      {
        ...planner("A"),
        revision: 2,
        thread: [
          { role: "user", text: "Why X?", at: 1 },
          { role: "planner", text: "Because Y.", at: 2, revision: 2 },
          { role: "bogus", text: "dropped", at: 3 },
        ],
      },
      { ...planner("B"), session: { dir: 1 }, launch: { access: { shell: "yes" } } },
    ],
  });
  const [a, b] = set?.candidates ?? [];
  assert.deepEqual(a?.session, { dir: "/tmp/sessions", id: "plan1-A" });
  assert.deepEqual(a?.launch, { access });
  assert.equal(a?.revision, 2);
  assert.equal(a?.thread?.length, 2);
  assert.equal(b?.session, undefined, "malformed sessions are dropped");
  assert.equal(b?.launch, undefined);
});

test("a merge passes on what you discussed with each planner", () => {
  const prompt = formatSynthesisPrompt(
    [
      planner("A", {
        revision: 3,
        thread: [
          { role: "user", text: "Drop the migration step.", at: 1 },
          { role: "planner", text: "Dropped it.", at: 2, revision: 3 },
        ],
      }),
      planner("B"),
    ],
    "Prefer A",
  );
  assert.match(prompt, /<candidate id="A" source="[^"]+" revision="3">/u);
  assert.match(
    prompt,
    /<discussion>[\s\S]*User: Drop the migration step\.\n\nPlanner: Dropped it\.[\s\S]*<\/discussion>/u,
  );
  assert.doesNotMatch(prompt.split('<candidate id="B"')[1] ?? "", /<discussion>/u);
});

class RpcChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  records: Record<string, unknown>[] = [];
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
    });
    this.stdin.on("finish", () => setTimeout(() => this.exit(0), 1));
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

function followUp(script: (child: RpcChild) => void, trace = new PlannerTrace()) {
  let child: RpcChild | undefined;
  const result = runPlanner({
    id: "A",
    spec: { provider: "p", modelId: "m" },
    cwd: process.cwd(),
    prompt: "Why X?",
    timeoutMs: 5_000,
    extensionPath: "/ext",
    loadUserExtensions: false,
    session: { dir: "/tmp/s", id: "plan1-A" },
    followUp: true,
    trace,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    spawnProcess: (() => {
      child = new RpcChild();
      const current = child;
      setTimeout(() => script(current), 0);
      return current;
    }) as never,
    piCommand: { command: "pi", args: [] },
  });
  return { result, child: () => child };
}

const reply = (text: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { totalTokens: 50 } },
});

test("a later turn returns the planner's reply without nudging it to resubmit its plan", async () => {
  const trace = new PlannerTrace();
  trace.note("earlier turn", "info");
  const run = followUp((child) => {
    child.send(reply("Because Y. Keep the plan as is."));
    child.send({ type: "agent_settled" });
  }, trace);
  const result = await run.result;
  assert.equal(result.status, "done");
  assert.equal(result.reply, "Because Y. Keep the plan as is.");
  assert.equal(result.planSubmitted, false);
  assert.equal(result.plan, undefined);
  assert.deepEqual(
    run.child()?.records.map((record) => record.type),
    ["prompt"],
    "no nudge",
  );
  assert.equal(trace.entries[0]?.kind, "note", "the trace continues");
  assert.match(JSON.stringify(trace.entries.at(-1)), /Replied\./u);
});

test("a later turn that resubmits the plan returns the revision", async () => {
  const run = followUp((child) => {
    child.send(reply("Dropped the migration step."));
    child.send({
      type: "tool_execution_start",
      toolCallId: "c",
      toolName: "plan_mode_complete",
      args: { plan: "# Plan A\n1. revised" },
    });
    child.send({ type: "agent_settled" });
  });
  const result = await run.result;
  assert.equal(result.status, "done");
  assert.equal(result.planSubmitted, true);
  assert.equal(result.plan, "# Plan A\n1. revised");
  assert.equal(result.reply, "Dropped the migration step.");
});

function talkHarness(
  runs: Array<(options: Record<string, unknown>) => Promise<PlannerTurnResult>>,
  events?: { emit(channel: string, data: unknown): void },
) {
  let set: CandidateSet = { version: 1, task: "t", createdAt: 1, candidates: [planner("A"), planner("B")] };
  const messages: Array<{ content: string; details: TalkMessageDetails }> = [];
  const notifications: string[] = [];
  const widgets: unknown[] = [];
  const editor: string[] = [];
  const panes = new Map<string, TracePane>();
  const calls: Record<string, unknown>[] = [];
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    mode: "rpc",
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (_key: string, content: unknown) => widgets.push(content),
      setEditorText: (text: string) => editor.push(text),
    },
  } as never;
  const talk = new PlannerTalk({
    pi: {
      sendMessage: ((message: { content: string; details: TalkMessageDetails }) => messages.push(message)) as never,
      appendEntry: (() => undefined) as never,
    },
    extensionPath: "/ext",
    loadUserExtensions: () => false,
    timeoutMs: () => 60_000,
    latestSet: () => set,
    saveSet: (next) => {
      set = next;
    },
    describeModel: (_ctx, spec) => ({ name: `Model ${spec}` }),
    pane: (_ctx, _set, candidate) => {
      let pane = panes.get(candidate.id);
      if (!pane) {
        pane = { id: candidate.id, model: candidate.label, trace: new PlannerTrace() };
        panes.set(candidate.id, pane);
      }
      return pane;
    },
    ...(events ? { events } : {}),
    runPlanner: (options) => {
      calls.push(options as never);
      const next = runs.shift();
      if (!next) throw new Error("unexpected run");
      return next(options as never);
    },
  });
  return { talk, ctx, messages, notifications, widgets, editor, calls, panes, set: () => set };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("talk mode sends your message to the planner's session and records its reply and revised plan", async () => {
  let finish: (result: PlannerTurnResult) => void = () => undefined;
  const harness = talkHarness([
    () => new Promise((resolve) => (finish = resolve)),
    async () => ({ ...planner("A"), status: "done", reply: "Sure, noted.", planSubmitted: false, durationMs: 10 }),
  ]);
  const { talk, ctx } = harness;
  assert.equal(talk.start(ctx, harness.set(), "A"), true);
  assert.equal(talk.active, true);
  assert.match(harness.notifications.at(-1) ?? "", /Now talking to planner A/u);

  talk.send(ctx, "Drop the migration step, please.");
  const options = harness.calls[0] ?? {};
  assert.equal(options.followUp, true);
  assert.deepEqual(options.session, { dir: "/tmp/sessions", id: "plan1-A" });
  assert.deepEqual(options.spec, { provider: "openai-codex", modelId: "gpt-6-a", thinkingLevel: "low" });
  assert.match(String(options.prompt), /talking with you directly[\s\S]*Drop the migration step, please\./u);
  assert.equal(harness.messages[0]?.details.role, "user");
  assert.equal(harness.messages[0]?.content, "Drop the migration step, please.");
  assert.equal(harness.set().candidates[0]?.thread?.[0]?.text, "Drop the migration step, please.");
  assert.match(JSON.stringify(harness.panes.get("A")?.trace.entries), /You: Drop the migration step/u);

  // One message at a time per planner: a second one goes back into the editor.
  talk.send(ctx, "And another thing");
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.editor, ["And another thing"]);
  assert.match(harness.notifications.at(-1) ?? "", /A is still replying/u);

  finish({
    ...planner("A"),
    status: "done",
    reply: "Dropped it.",
    plan: "# Plan A\n1. revised",
    planSubmitted: true,
    durationMs: 500,
    toolCalls: 3,
    totalTokens: 40,
    costUsd: 0.02,
  });
  await settle();
  const a = harness.set().candidates[0];
  assert.equal(a?.plan, "# Plan A\n1. revised");
  assert.equal(a?.revision, 2);
  assert.equal(a?.toolCalls, 5);
  assert.equal(a?.totalTokens, 140);
  assert.deepEqual(
    a?.thread?.map((entry) => [entry.role, entry.text, entry.revision]),
    [
      ["user", "Drop the migration step, please.", undefined],
      ["planner", "Dropped it.", 2],
    ],
  );
  const replyMessage = harness.messages.at(-1);
  assert.equal(replyMessage?.details.role, "planner");
  assert.equal(replyMessage?.details.revision, 2);
  assert.equal(replyMessage?.details.plan, "# Plan A\n1. revised");

  // A reply without a new plan keeps the revision.
  talk.send(ctx, "Thanks");
  await settle();
  assert.equal(harness.set().candidates[0]?.revision, 2);
  assert.equal(harness.messages.at(-1)?.content, "Sure, noted.");
  assert.equal(harness.messages.at(-1)?.details.revision, undefined);

  talk.stop(ctx);
  assert.equal(talk.active, false);
});

test("talk mode refuses the session's own plan and planners from older runs", () => {
  const harness = talkHarness([]);
  const set: CandidateSet = {
    version: 1,
    task: "t",
    createdAt: 1,
    candidates: [
      { ...planner("A"), origin: "session", label: "Current plan" },
      { ...planner("B"), session: undefined },
    ],
  };
  assert.equal(harness.talk.start(harness.ctx, set, "A"), false);
  assert.match(harness.notifications.at(-1) ?? "", /this session's own plan/u);
  assert.equal(harness.talk.start(harness.ctx, set, "B"), false);
  assert.match(harness.notifications.at(-1) ?? "", /cannot be resumed/u);
  assert.equal(harness.talk.active, false);
});

test("latest candidate set wins, so talk updates are what /plan compare reopens", () => {
  const first = { version: 1, task: "t", createdAt: 1, candidates: [planner("A")] };
  const second = { ...first, candidates: [planner("A", { revision: 2 })] };
  const entries = [
    { type: "custom", customType: "plan-mode-candidates", data: first },
    { type: "custom", customType: "plan-mode-candidates", data: second },
  ];
  assert.equal(latestCandidateSet(entries)?.candidates[0]?.revision, 2);
  assert.equal(PLANNER_TALK_MESSAGE_TYPE, "plan-mode-planner-talk");
});

test("the comparison screen shows revisions and your turns, and r talks to the highlighted planner", async () => {
  const { CompareView } = await import("../src/compare-view.js");
  const plain = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
  } as never;
  const results: unknown[] = [];
  const view = new CompareView(plain, {
    task: "t",
    candidates: [
      planner("A", {
        revision: 2,
        thread: [
          { role: "user", text: "q", at: 1 },
          { role: "planner", text: "a", at: 2, revision: 2 },
        ],
      }),
      { ...planner("B"), origin: "session", label: "Current plan" },
    ],
    describe: (candidate) => ({ name: `Model ${candidate.id}` }),
    hasTraces: false,
    renderMarkdown: (text) => text.split("\n"),
    rows: () => 30,
    requestRender: () => undefined,
    onDone: (result) => results.push(result),
  });
  const screen = view.render(150).join("\n");
  assert.match(screen, /✓ A v2 +Model A/u);
  assert.match(screen, /you talked 1×/u);
  assert.match(screen, /Plan A v2 · Model A/u);
  assert.match(screen, /r talk to A/u);
  view.handleInput("\u001b[B"); // B: this session's own plan
  view.handleInput("r");
  assert.match(view.render(150).join("\n"), /B is this session's own plan/u);
  view.handleInput("\u001b[A");
  view.handleInput("r");
  assert.deepEqual(results, [{ kind: "talk", id: "A" }]);
});

test("a replying planner holds herdr working until its reply lands", async () => {
  const seen: [string, unknown][] = [];
  let finish: (result: PlannerTurnResult) => void = () => undefined;
  const harness = talkHarness([() => new Promise((resolve) => (finish = resolve))], {
    emit: (channel, data) => seen.push([channel, data]),
  });
  const { talk, ctx } = harness;
  talk.start(ctx, harness.set(), "A");
  talk.send(ctx, "Why X?");
  assert.deepEqual(seen, [["herdr:working", { active: true, label: "A is replying" }]]);
  finish({ ...planner("A"), status: "done", reply: "Because Y.", planSubmitted: false, durationMs: 10 });
  await settle();
  assert.deepEqual(seen.at(-1), ["herdr:working", { active: false }]);
  assert.equal(seen.length, 2);
});
