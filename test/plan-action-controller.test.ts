import assert from "node:assert/strict";
import { test } from "vitest";
import { createPlanActionController } from "../src/plan-action-controller.js";
import { createMockContext } from "./shared/support.js";

test("stale Plan actions do not load interactive UI", async () => {
  let interactiveLoads = 0;
  const controller = createPlanActionController({
    loadInteractiveUi: async () => {
      interactiveLoads += 1;
      return {} as never;
    },
    getState: () => ({ enabled: false, awaitingAction: false }),
    captureLifecycle: () => ({
      signal: new AbortController().signal,
      isCurrent: () => false,
    }),
    statusText: () => "off",
    getThinkingLevel: () => "medium",
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
  });
  const context = createMockContext({ hasUI: true });

  await controller.showSaved(context.ctx);
  await controller.showCurrent(context.ctx);
  await controller.showReady(context.ctx);

  assert.equal(interactiveLoads, 0);
});

test("only ready-plan fresh actions survive normal menu disposal for deferred handoff", async () => {
  const timings: string[] = [];
  const currents: Array<() => boolean> = [];
  const invokeFresh = async (menuOptions: Record<string, unknown>, kind: "saved" | "current" | "ready") => {
    const controller = new AbortController();
    void kind;
    await (
      menuOptions.implement as (choice: { runtime: object; context: "clear" }, signal: AbortSignal) => Promise<void>
    )({ runtime: {}, context: "clear" }, controller.signal);
    controller.abort(new DOMException("Menu closed", "AbortError"));
  };
  const controller = createPlanActionController({
    loadInteractiveUi: async () =>
      ({
        showSavedPlanMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "saved"),
        showPlanModeMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "current"),
        showReadyPlanMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "ready"),
      }) as never,
    getState: () => ({
      enabled: true,
      awaitingAction: true,
      latestPlan: "# Plan",
      latestPlanSource: "plan_mode_complete",
    }),
    captureLifecycle: () => ({
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    statusText: () => "ready",
    getThinkingLevel: () => "medium",
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: (_ctx, isCurrent, _runtime, timing) => {
      timings.push(timing);
      currents.push(isCurrent);
    },
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
  });
  const context = createMockContext({
    hasUI: true,
    model: { provider: "planning-provider", id: "planning-model" },
    modelRegistry: { getAvailable: () => [] },
  });

  await controller.showSaved(context.ctx);
  await controller.showCurrent(context.ctx);
  await controller.showReady(context.ctx);

  assert.deepEqual(timings, ["immediate", "immediate", "after-settled"]);
  assert.deepEqual(
    currents.map((isCurrent) => isCurrent()),
    [false, false, true],
  );
});

test("saved-plan defaults use the plan model map, then the default model, and skip missing models", async () => {
  const target = { provider: "target-provider", id: "target-model" };
  const mapped = { provider: "mapped-provider", id: "mapped-model" };
  const scenarios = [
    { name: "mapped", availableModels: [target, mapped], expected: mapped, source: "map", warns: false },
    { name: "map target missing", availableModels: [target], expected: target, source: "default", warns: true },
    { name: "nothing available", availableModels: [], expected: undefined, source: "plan", warns: true },
  ];
  for (const scenario of scenarios) {
    let implementation: { resolved: Record<string, unknown> } | undefined;
    const controller = createPlanActionController({
      loadInteractiveUi: async () =>
        ({
          showSavedPlanMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
            implementation = menuOptions.implementation as typeof implementation;
          },
        }) as never,
      getState: () => ({
        enabled: false,
        awaitingAction: false,
        savedPlan: {
          plan: "# Plan",
          source: "plan_mode_complete",
          model: { provider: "author-provider", modelId: "author-model" },
        },
      }),
      captureLifecycle: () => ({
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
      statusText: () => "saved",
      getThinkingLevel: () => "medium",
      getSettings: () => ({
        thinkingLevel: "inherit",
        defaultImplementationModel: { provider: target.provider, modelId: target.id },
        defaultImplementationThinkingLevel: "high",
        implementationModelMap: {
          "author-provider/author-model": { provider: mapped.provider, modelId: mapped.id, thinkingLevel: "low" },
        },
      }),
      implementationOutcome: () => "",
      getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
      show: () => undefined,
      finalize: () => undefined,
      implementHere: () => undefined,
      implementFresh: () => undefined,
      exportPlan: async () => false,
      settings: async () => false,
      save: () => undefined,
      stay: () => undefined,
      exitReady: () => undefined,
      clearSaved: () => undefined,
    });
    const context = createMockContext({
      hasUI: true,
      model: { provider: "planning-provider", id: "planning-model" },
      modelRegistry: { getAvailable: () => scenario.availableModels },
    });

    await controller.showSaved(context.ctx);

    assert.equal(implementation?.resolved.modelSource, scenario.source, scenario.name);
    assert.deepEqual(
      implementation?.resolved.model,
      scenario.expected ? { provider: scenario.expected.provider, modelId: scenario.expected.id } : undefined,
      scenario.name,
    );
    assert.equal(implementation?.resolved.thinkingLevel, scenario.source === "map" ? "low" : "high", scenario.name);
    const unavailable = (implementation?.resolved.unavailable ?? []) as unknown[];
    assert.equal(unavailable.length > 0, scenario.warns, scenario.name);
  }
});
