import assert from "node:assert/strict";
import { defineMenu } from "@narumitw/pi-tui-kit";
import { test } from "vitest";
import { runMenuWithVimKeys } from "../src/menu-keys.js";
import { withPlanFrame } from "../src/plan-frame.js";
import planMode from "../src/plan-mode.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

const STEPS = Array.from({ length: 50 }, (_unused, index) => `${index + 1}. step ${index + 1}`).join("\n");

test("a framed menu shows the task, the plans side by side, then the menu; plans scroll and switch", async () => {
  let rendered = "";
  const pressed: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown, options?: unknown) => {
      assert.ok(options, "the framed menu opens full screen");
      const harness = createCustomSelectorHarness(factory, 120, undefined, 40);
      const screen = () => harness.render().join("\n");
      rendered = screen();
      harness.handleInput("\u001b[6~"); // PgDn scrolls the focused plan (A)
      pressed.push(screen());
      harness.handleInput("\t"); // focus B
      harness.handleInput("\u001b[6~");
      pressed.push(screen());
      harness.handleInput("tui.select.confirm"); // the menu still gets Enter
      return harness.resultPromise;
    },
  });
  let chosen = "";
  const menu = defineMenu<undefined, "main", "pick", never>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "What next?",
        items: [
          { id: "go", label: "Go", action: "pick" },
          { id: "stop", label: "Stop", action: "pick" },
        ],
        hint: "close",
      }),
    },
    actions: {
      pick: async ({ itemId }) => {
        chosen = itemId ?? "";
        return { kind: "close" };
      },
    },
  });
  const framed = withPlanFrame(context.ctx as never, {
    title: "Compare plans",
    task: "Add caching to the catalog",
    plans: [
      { id: "A", title: "A · Model A", plan: `Plan A\n${STEPS}` },
      { id: "B", title: "B · Model B", plan: `Plan B\n${STEPS}` },
    ],
  });
  await runMenuWithVimKeys(framed, menu, { getState: () => undefined });

  assert.match(rendered, /Compare plans +PgUp\/PgDn scroll · tab next plan/u);
  assert.match(rendered, /Task +Add caching to the catalog/u);
  assert.match(rendered, /── A · Model A ─+ \d+ more ↓ ── │ ── B · Model B ─+ \d+ more ↓ ──/u);
  assert.match(rendered, /Plan A +│ Plan B/u);
  assert.match(rendered, /What next\?[\s\S]*→ Go[\s\S]*Stop/u);
  const [afterA, afterB] = pressed;
  assert.doesNotMatch(afterA ?? "", /Plan A +│/u, "PgDn scrolled A");
  assert.match(afterA ?? "", /│ Plan B/u, "B did not move");
  assert.doesNotMatch(afterB ?? "", /│ Plan B/u, "after tab, PgDn scrolls B");
  assert.equal(chosen, "go");
});

test("plain /plan's ready menu shows your prompt and the plan above the options", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi);
  let rendered = "";
  const branch: unknown[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    custom: async (factory: unknown, options?: unknown) => {
      const harness = createCustomSelectorHarness(factory, 120, undefined, 40);
      if (options) rendered = harness.render().join("\n");
      harness.handleInput("\u001b");
      return harness.resultPromise;
    },
  });
  await mock.commands.get("plan")?.handler("start", context.ctx);
  // The session as Pi records it: the Plan contract, then your prompt.
  for (const sent of mock.sentMessages) {
    branch.push({ type: "custom_message", ...(sent.message as object) });
  }
  branch.push({ type: "message", message: { role: "user", content: "Add caching to the catalog" } });
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await complete("c", { plan: `# Cache it\n\n${STEPS}` }, undefined, undefined, context.ctx);
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);

  assert.match(rendered, /^ Proposed plan +PgUp\/PgDn scroll the plan/mu);
  assert.match(rendered, /Task +Add caching to the catalog/u);
  assert.match(rendered, /Proposed plan ready\. What next\?/u);
  assert.match(rendered, /── Plan ─+ \d+ more ↓ ──/u);
  assert.match(rendered, /Cache it/u);
  assert.match(rendered, /→ Implement…[\s\S]*Discard plan and exit/u);
});
