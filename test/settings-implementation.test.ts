import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  normalizePlanModeSettings,
  type PlanModeSettings,
  readPlanModeSettings,
  updatePlanModeSettings,
} from "../src/settings.js";
import { showPlanModeSettings } from "../src/settings-menu.js";
import { builtinTool, createMockContext } from "./shared/support.js";

const AVAILABLE_MODELS = [
  { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" },
  { provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet" },
  { provider: "openai-codex", id: "gpt-6-sol", name: "Sol" },
];

test("new settings normalize the model map, context, planners, timeout, and hook command", () => {
  const settings = normalizePlanModeSettings({
    implementationModelMap: {
      "anthropic/claude-opus-5-5": "anthropic/claude-sonnet-5:high",
      "openai-codex/gpt-6-astra": "openai-codex/gpt-6-sol",
    },
    defaultImplementationContext: "clear",
    planners: ["anthropic/claude-opus-5-5:xhigh", "openai-codex/gpt-6-sol", "openai-codex/gpt-6-sol"],
    plannerTimeoutSeconds: 600,
    plannerLoadExtensions: true,
    planCompleteCommand: ["bash", "~/.claude/hooks/save-plan-to-obsidian.sh"],
  });
  assert.deepEqual(settings, {
    thinkingLevel: "inherit",
    implementationModelMap: {
      "anthropic/claude-opus-5-5": { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" },
      "openai-codex/gpt-6-astra": { provider: "openai-codex", modelId: "gpt-6-sol" },
    },
    defaultImplementationContext: "clear",
    planners: [
      { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "xhigh" },
      { provider: "openai-codex", modelId: "gpt-6-sol" },
    ],
    plannerTimeoutSeconds: 600,
    plannerLoadExtensions: true,
    planCompleteCommand: ["bash", "~/.claude/hooks/save-plan-to-obsidian.sh"],
  });
  for (const invalid of [
    { implementationModelMap: { "no-slash": "anthropic/claude-sonnet-5" } },
    { implementationModelMap: { "anthropic/claude-opus-5-5:high": "anthropic/claude-sonnet-5" } },
    { implementationModelMap: { "anthropic/claude-opus-5-5": 3 } },
    { defaultImplementationContext: "later" },
    { planners: "anthropic/claude-opus-5-5" },
    { planners: ["bad"] },
    { plannerTimeoutSeconds: 0 },
    { plannerLoadExtensions: "yes" },
    { planCompleteCommand: [] },
    { planCompleteCommand: "bash hook.sh" },
  ]) {
    assert.equal(normalizePlanModeSettings(invalid), undefined, JSON.stringify(invalid));
  }
});

test("updates serialize the model map and planners as model spec strings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-new-"));
  const settingsPath = join(directory, "pi-plan-mode.json");
  try {
    await updatePlanModeSettings(
      {
        implementationModelMap: {
          "anthropic/claude-opus-5-5": { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" },
        },
        planners: [{ provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "xhigh" }],
        defaultImplementationContext: "clear",
      },
      { settingsPath },
    );
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      implementationModelMap: { "anthropic/claude-opus-5-5": "anthropic/claude-sonnet-5:high" },
      planners: ["openai-codex/gpt-6-sol:xhigh"],
      defaultImplementationContext: "clear",
    });
    await updatePlanModeSettings(
      { implementationModelMap: {}, planners: null, defaultImplementationContext: null },
      { settingsPath },
    );
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a symlinked settings file is read through and updated in place, keeping the link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-link-"));
  const target = join(directory, "dotfiles-pi-plan-mode.json");
  const settingsPath = join(directory, "pi-plan-mode.json");
  try {
    await writeFile(target, '{"thinkingLevel":"low"}\n');
    await symlink(target, settingsPath);
    const loaded = await readPlanModeSettings(settingsPath);
    assert.equal(loaded.kind === "loaded" ? loaded.settings.thinkingLevel : undefined, "low");

    await updatePlanModeSettings({ thinkingLevel: "high" }, { settingsPath });
    assert.equal((await lstat(settingsPath)).isSymbolicLink(), true);
    assert.equal(await readlink(settingsPath), target);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { thinkingLevel: "high" });

    await rm(target);
    const dangling = await readPlanModeSettings(settingsPath);
    assert.equal(dangling.kind, "invalid");
    await assert.rejects(updatePlanModeSettings({ thinkingLevel: "low" }, { settingsPath }), /symlink/u);
    assert.equal((await lstat(settingsPath)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the settings menu adds, edits the effort of, and removes a model-map entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-map-"));
  const settingsPath = join(directory, "pi-plan-mode.json");
  const saved: PlanModeSettings[] = [];
  const script = [
    { title: "Plan Mode Settings", choose: "Implementation model map" },
    { title: "Implementation model map", choose: "Add mapping…" },
    { title: "Planning model", choose: "claude-opus-5-5 [anthropic]" },
    { title: "Implement plans from", choose: "claude-sonnet-5 [anthropic]" },
    { title: "Implementation effort for this mapping", choose: "high" },
    { title: "Implementation model map", choose: "anthropic/claude-opus-5-5 → anthropic/claude-sonnet-5" },
    { title: "Implement plans from", choose: "Remove mapping" },
    { title: "Implementation model map", choose: undefined },
  ];
  let step = 0;
  const context = createMockContext({
    cwd: directory,
    mode: "rpc",
    hasUI: true,
    modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
    select: async (title: string, options: string[]) => {
      const expected = script[step];
      assert.ok(expected, `unexpected dialog ${title}`);
      assert.ok(title.startsWith(expected.title), `step ${step}: ${title}`);
      step += 1;
      if (expected.choose === undefined) return undefined;
      const option = options.find((candidate) => candidate.startsWith(expected.choose as string));
      assert.ok(option, `step ${step - 1}: ${expected.choose} not in ${options.join(" | ")}`);
      return option;
    },
  });
  try {
    await showPlanModeSettings(context.ctx, {
      settingsPath,
      tools: [builtinTool("read")] as ToolInfo[],
      signal: new AbortController().signal,
      isCurrent: () => true,
      onSaved: (settings) => saved.push(settings),
    });
    assert.equal(step, script.length);
    assert.deepEqual(saved[0]?.implementationModelMap, {
      "anthropic/claude-opus-5-5": { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" },
    });
    assert.equal(saved.at(-1)?.implementationModelMap, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
