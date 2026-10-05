import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runPlanCompleteHook } from "../src/plan-hook.js";
import { plannerTaskPrompt, synthesisPrompt } from "../src/planner/prompt.js";
import { buildPlannerTranscript } from "../src/planners.js";

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
    { type: "custom_message", customType: "plan-mode-transition", content: "[CONTRACT]" },
  ]);
  assert.match(transcript, /Summary of earlier conversation:\nWe discussed caching\./u);
  assert.match(transcript, /User: Add a cache layer/u);
  assert.match(transcript, /Assistant: Which store\?/u);
  assert.match(transcript, /Answers to planning questions:\nStore: Redis/u);
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

test("planner and synthesis prompts carry the task, the tools, and the other plan", () => {
  const prompt = plannerTaskPrompt({
    task: "Add caching",
    planners: 2,
    scoutLabel: "anthropic/claude-opus-5-5:high",
    tools: ["web_search", "codemode"],
    mcpAllow: ["context7/*"],
    grants: [],
  });
  assert.match(prompt, /Another model is planning the same task/u);
  assert.match(prompt, /web_search/u);
  assert.match(prompt, /context7\/\*/u);
  assert.match(prompt, /plan_subagents/u);
  assert.match(prompt, /## Task\n\nAdd caching/u);
  const alone = plannerTaskPrompt({ task: "", planners: 1, tools: [], grants: [] });
  assert.doesNotMatch(alone, /Another model/u);
  assert.match(alone, /discussed in the conversation/u);
  const merge = synthesisPrompt({ id: "A", label: "a/x", plan: "# A" }, { id: "B", label: "b/y", plan: "# B plan" });
  assert.match(merge, /<other-plan id="B">\n# B plan\n<\/other-plan>/u);
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
