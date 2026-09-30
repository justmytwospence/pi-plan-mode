import assert from "node:assert/strict";
import { defineMenu } from "@narumitw/pi-tui-kit";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { opensSubmenu, runMenuWithVimKeys } from "../src/menu-keys.js";

type Screen = "main" | "sub" | "search";
type Action = "run" | "more" | "pick";

async function openCount(tui: ReturnType<typeof createTuiHarness>, count: number) {
  const deadline = Date.now() + 2_000;
  while (tui.openCount < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tui.openCount, count);
}

function fixture() {
  const tui = createTuiHarness({ width: 60, rows: 20 });
  const ran: string[] = [];
  const menu = defineMenu<undefined, Screen, Action, never>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Main",
        items: [
          { id: "run", label: "Run now", action: "run" },
          { id: "sub", label: "Submenu", to: "sub" },
          { id: "more", label: "More options…", action: "more" },
          { id: "search", label: "Search list", to: "search" },
        ],
        hint: "close",
      }),
      sub: () => ({ kind: "detail", title: "Sub", lines: ["inside the submenu"], hint: "back" }),
      search: () => ({
        kind: "choice",
        title: "Search",
        enableSearch: true,
        action: "pick",
        items: [
          { id: "alpha", label: "alpha" },
          { id: "juliet", label: "juliet" },
        ],
        hint: "back",
      }),
    },
    actions: {
      run: async () => {
        ran.push("run");
        return { kind: "close" };
      },
      more: async () => {
        ran.push("more");
        return { kind: "stay" };
      },
      pick: async ({ itemId }) => {
        ran.push(`pick:${itemId}`);
        return { kind: "close" };
      },
    },
  });
  const ctx = { mode: "tui", hasUI: true, ui: { custom: tui.custom } } as never;
  const running = runMenuWithVimKeys(ctx, menu, { getState: () => undefined });
  const selected = () =>
    tui
      .render()
      .find((line) => line.includes("→"))
      ?.trim();
  return { tui, ran, running, selected };
}

test("j/k/n/p and ctrl+n/ctrl+p move through a menu without a search box", async () => {
  const { tui, running, selected } = fixture();
  await openCount(tui, 1);
  assert.match(selected() ?? "", /Run now/u);
  tui.send("j");
  assert.match(selected() ?? "", /Submenu/u);
  tui.send("n");
  assert.match(selected() ?? "", /More options/u);
  tui.send("k");
  assert.match(selected() ?? "", /Submenu/u);
  tui.send("p");
  assert.match(selected() ?? "", /Run now/u);
  tui.send("\u000e"); // ctrl+n
  assert.match(selected() ?? "", /Submenu/u);
  tui.send("\u0010"); // ctrl+p
  assert.match(selected() ?? "", /Run now/u);
  tui.send("h"); // back: closes the top menu
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("l opens a submenu or an …-action, never runs an action, and h goes back", async () => {
  const { tui, ran, running } = fixture();
  await openCount(tui, 1);
  tui.send("l"); // on "Run now": nothing runs, the menu reopens
  await openCount(tui, 2);
  assert.deepEqual(ran, []);
  tui.send("j");
  tui.send("l"); // Submenu
  await openCount(tui, 3);
  assert.match(tui.render().join("\n"), /inside the submenu/u);
  tui.send("h");
  await openCount(tui, 4);
  tui.send("j");
  tui.send("l"); // More options…
  await openCount(tui, 5);
  assert.deepEqual(ran, ["more"]);
  tui.press("tui.select.cancel");
  await running;
});

test("in a searchable list letters type into the search box and ctrl+n/ctrl+p still move", async () => {
  const { tui, ran, running } = fixture();
  await openCount(tui, 1);
  tui.press("tui.select.up"); // wraps to "Search list"
  tui.press("tui.select.confirm");
  await openCount(tui, 2);
  tui.send("\u000e"); // ctrl+n: down to juliet
  tui.send("\u0010"); // ctrl+p: back to alpha
  tui.send("\u000e");
  assert.match(tui.render().join("\n"), /→ juliet/u);
  assert.doesNotMatch(tui.render().join("\n"), /Search: > \w/u, "ctrl keys do not type");
  tui.send("j");
  assert.match(tui.render().join("\n"), /Search: > j/u, "letters search");
  tui.press("tui.select.confirm");
  await running;
  assert.deepEqual(ran, ["pick:juliet"]);
});

test("l may open items that lead somewhere else", () => {
  assert.equal(opensSubmenu({ label: "Export", to: "export" }), true);
  assert.equal(opensSubmenu({ label: "Settings…" }), true);
  assert.equal(opensSubmenu({ label: "Discard plan and exit" }), false);
  assert.equal(opensSubmenu(undefined), false);
});
