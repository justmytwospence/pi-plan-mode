import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveImplementationDefaults } from "../src/implementation-models.js";
import type { ImplementationMenuDefaults } from "../src/plan-action-menus.js";
import { showReadyPlanMenu } from "../src/plan-action-menus.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

const AVAILABLE_MODELS = [
  {
    provider: "provider\u001b[31m-one",
    id: "model\u202e-one",
    name: "Friendly\u001b]8;;https://unsafe.example\u0007 name\u001b]8;;\u0007",
  },
  { provider: "provider-two", id: "model-two", name: "Beta specialist" },
  { provider: "provider-three", id: "model-three", name: "Gamma" },
];

const PLAN_MODEL = { provider: "provider-three", modelId: "model-three" };

function defaults(overrides: Partial<ImplementationMenuDefaults> = {}): ImplementationMenuDefaults {
  return {
    planThinkingLevel: undefined,
    resolved: { context: "keep", modelSource: "plan", unavailable: [] },
    ...overrides,
  };
}

function menuOptions(overrides: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    isCurrent: () => true,
    implementation: defaults(),
    implementationOutcome: () => "The plan remains available until implementation ends.",
    getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
    implement: () => undefined,
    exportPlan: async () => true,
    save: () => undefined,
    stay: () => undefined,
    exit: () => undefined,
    ...overrides,
  };
}

function scriptedSelect(script: Record<string, Array<string | ((options: string[]) => string | undefined)>>) {
  const visits = new Map<string, number>();
  const dialogs: Array<{ title: string; options: string[] }> = [];
  const select = async (title: string, options: string[]) => {
    dialogs.push({ title, options });
    const key = Object.keys(script).find((prefix) => title.startsWith(prefix));
    if (!key) return undefined;
    const count = visits.get(key) ?? 0;
    visits.set(key, count + 1);
    const steps = script[key] ?? [];
    const step = steps[Math.min(count, steps.length - 1)];
    if (typeof step === "function") return step(options);
    return step === undefined ? undefined : (options.find((option) => option.startsWith(step)) ?? step);
  };
  return { select, dialogs };
}

test("the implement screen preselects the mapped model and effort and starts here by default", async () => {
  const choices: unknown[] = [];
  const { select, dialogs } = scriptedSelect({
    "Proposed plan ready": ["Implement…"],
    "Implement plan": ["Start implementation"],
  });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: AVAILABLE_MODELS[0],
    modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
    select,
  });

  await showReadyPlanMenu(
    context.ctx,
    menuOptions({
      implementation: defaults({
        planModel: PLAN_MODEL,
        resolved: {
          model: { provider: "provider-two", modelId: "model-two" },
          thinkingLevel: "high",
          context: "keep",
          modelSource: "map",
          unavailable: [],
        },
      }),
      implement: (choice: unknown) => {
        choices.push(choice);
      },
    }),
  );

  assert.deepEqual(choices, [
    { runtime: { model: { provider: "provider-two", modelId: "model-two" }, thinkingLevel: "high" }, context: "keep" },
  ]);
  const readyScreen = dialogs.find((dialog) => dialog.title.startsWith("Proposed plan ready"));
  assert.match(readyScreen?.title ?? "", /Planned with model-three \[provider-three\]/u);
  assert.match(
    readyScreen?.title ?? "",
    /Implementation default: model-two \[provider-two\] · from model map, effort high; keep planning conversation/u,
  );
  const implementScreen = dialogs.find((dialog) => dialog.title.startsWith("Implement plan"));
  assert.ok(implementScreen);
  const startIndex = implementScreen.options.findIndex((option) => option.startsWith("Start implementation here"));
  const modelIndex = implementScreen.options.findIndex((option) => option.startsWith("Model"));
  const effortIndex = implementScreen.options.findIndex((option) => option.startsWith("Effort"));
  const contextIndex = implementScreen.options.findIndex((option) => option.startsWith("Context"));
  assert.ok(startIndex === 0 && startIndex < modelIndex && modelIndex < effortIndex && effortIndex < contextIndex);
});

test("model, effort, and context overrides apply once and sanitize model metadata", async () => {
  const choices: unknown[] = [];
  const { select, dialogs } = scriptedSelect({
    "Proposed plan ready": ["Implement…"],
    "Implement plan": ["Model", "Effort", "Context", "Start implementation"],
    "Implementation model": [(options) => options.find((option) => option.includes("model-one [provider-one]"))],
    "Implementation effort": ["max"],
    "Implementation context": ["Clear context"],
  });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: AVAILABLE_MODELS[1],
    modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
    select,
  });

  await showReadyPlanMenu(
    context.ctx,
    menuOptions({
      implement: (choice: unknown) => {
        choices.push(choice);
      },
    }),
  );

  assert.deepEqual(choices, [
    {
      runtime: { model: { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" }, thinkingLevel: "max" },
      context: "clear",
    },
  ]);
  const rendered = dialogs.flatMap((dialog) => [dialog.title, ...dialog.options]).join("\n");
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("\u202e"), false);
  assert.match(rendered, /Start implementation in a fresh session/u);
});

test("keeping the current model sends no model override; a fresh session pins the session runtime", async () => {
  for (const [contextChoice, expected] of [
    ["Keep planning conversation", { runtime: {}, context: "keep" }],
    [
      "Clear context",
      {
        runtime: { model: { provider: "provider-two", modelId: "model-two" }, thinkingLevel: "medium" },
        context: "clear",
      },
    ],
  ] as const) {
    const choices: unknown[] = [];
    const { select } = scriptedSelect({
      "Proposed plan ready": ["Implement…"],
      "Implement plan": ["Model", "Context", "Start implementation"],
      "Implementation model": ["Current model"],
      "Implementation context": [contextChoice],
    });
    const context = createMockContext({
      mode: "rpc",
      hasUI: true,
      model: AVAILABLE_MODELS[1],
      modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
      select,
    });
    await showReadyPlanMenu(
      context.ctx,
      menuOptions({
        implementation: defaults({
          planThinkingLevel: "medium",
          resolved: {
            model: { provider: "provider-three", modelId: "model-three" },
            context: "keep",
            modelSource: "map",
            unavailable: [],
          },
        }),
        implement: (choice: unknown) => {
          choices.push(choice);
        },
      }),
    );
    assert.deepEqual(choices, [expected], contextChoice);
  }
});

test("a mapped default that disappears before start falls back to the current model", async () => {
  let reads = 0;
  const choices: unknown[] = [];
  const { select } = scriptedSelect({
    "Proposed plan ready": ["Implement…"],
    "Implement plan": ["Start implementation"],
  });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: AVAILABLE_MODELS[0],
    modelRegistry: {
      getAvailable: () => {
        reads += 1;
        return reads === 1 ? AVAILABLE_MODELS : [AVAILABLE_MODELS[0]];
      },
    },
    select,
  });

  await showReadyPlanMenu(
    context.ctx,
    menuOptions({
      implementation: defaults({
        resolved: {
          model: { provider: "provider-two", modelId: "model-two" },
          thinkingLevel: "high",
          context: "keep",
          modelSource: "map",
          unavailable: [],
        },
      }),
      implement: (choice: unknown) => {
        choices.push(choice);
      },
    }),
  );

  assert.deepEqual(choices, [{ runtime: { thinkingLevel: "high" }, context: "keep" }]);
  assert.match(context.notifications.at(-1)?.message ?? "", /no longer available.*current model/iu);
});

test("the model picker honors the session model scope", async () => {
  let modelOptions: string[] = [];
  const { select } = scriptedSelect({
    "Proposed plan ready": ["Implement…"],
    "Implement plan": ["Model", "Start implementation"],
    "Implementation model": [
      (options) => {
        modelOptions = options;
        return options.find((option) => option.includes("model-two [provider-two]"));
      },
    ],
  });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    scopedModels: [{ model: AVAILABLE_MODELS[1] }],
    modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
    select,
  });

  await showReadyPlanMenu(context.ctx, menuOptions());

  assert.ok(modelOptions.some((option) => option.startsWith("Current model")));
  assert.ok(modelOptions.some((option) => option.includes("model-two [provider-two]")));
  assert.equal(
    modelOptions.some((option) => option.includes("model-one [provider-one]")),
    false,
  );
});

test("the effort screen lists every thinking level with its description", async () => {
  let screen = 0;
  let effortScreen = "";
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    model: AVAILABLE_MODELS[0],
    modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 90);
      screen += 1;
      if (screen === 1) {
        harness.handleInput("tui.select.confirm");
      } else if (screen === 2) {
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
      } else {
        effortScreen = harness.render().join("\n");
        harness.handleInput("\u0003");
      }
      return harness.resultPromise;
    },
  });

  await showReadyPlanMenu(context.ctx, menuOptions({ implementation: defaults({ planThinkingLevel: "medium" }) }));

  assert.match(effortScreen, /Implementation effort/u);
  assert.match(effortScreen, /→ Same as plan/u);
  assert.match(effortScreen, /off\s+No reasoning/u);
  assert.match(effortScreen, /✓ medium\s+Moderate reasoning \(~8k tokens\)/u);
  assert.match(effortScreen, /xhigh\s+Extra-high reasoning \(~32k tokens\)/u);
  assert.match(effortScreen, /max\s+Maximum reasoning/u);
});

test("the ready menu offers comparison only when a compare action exists", async () => {
  for (const withCompare of [false, true]) {
    let readyOptions: string[] = [];
    let compared = 0;
    const context = createMockContext({
      mode: "rpc",
      hasUI: true,
      modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
      select: async (title: string, options: string[]) => {
        if (!title.startsWith("Proposed plan ready")) return undefined;
        readyOptions = options;
        return withCompare ? "Compare with other models…" : undefined;
      },
    });
    await showReadyPlanMenu(
      context.ctx,
      menuOptions(
        withCompare
          ? {
              compare: () => {
                compared += 1;
              },
            }
          : {},
      ),
    );
    assert.equal(
      readyOptions.some((option) => option.startsWith("Compare with other models")),
      withCompare,
    );
    assert.equal(compared, withCompare ? 1 : 0);
  }
});

test("implementation defaults prefer the model map, then the default model, then the planning model", () => {
  const available = AVAILABLE_MODELS;
  const session = { provider: "provider-two", modelId: "model-two" };
  const planModel = { provider: "provider-three", modelId: "model-three" };
  const map = {
    "provider-three/model-three": { provider: "provider-two", modelId: "model-two", thinkingLevel: "low" as const },
  };

  const mapped = resolveImplementationDefaults({
    planModel,
    sessionModel: { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" },
    modelMap: map,
    defaultModel: undefined,
    defaultThinkingLevel: "high",
    defaultContext: undefined,
    available,
  });
  assert.deepEqual(mapped, {
    model: { provider: "provider-two", modelId: "model-two" },
    thinkingLevel: "low",
    context: "keep",
    modelSource: "map",
    unavailable: [],
  });

  const sameAsSession = resolveImplementationDefaults({
    planModel,
    sessionModel: session,
    modelMap: map,
    defaultModel: undefined,
    defaultThinkingLevel: undefined,
    defaultContext: "clear",
    available,
  });
  assert.deepEqual(sameAsSession, { thinkingLevel: "low", context: "clear", modelSource: "map", unavailable: [] });

  const fallback = resolveImplementationDefaults({
    planModel,
    sessionModel: session,
    modelMap: { "provider-three/model-three": { provider: "gone", modelId: "missing" } },
    defaultModel: { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" },
    defaultThinkingLevel: "medium",
    defaultContext: undefined,
    available,
  });
  assert.equal(fallback.modelSource, "default");
  assert.deepEqual(fallback.model, { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" });
  assert.equal(fallback.thinkingLevel, "medium");
  assert.deepEqual(fallback.unavailable, [{ provider: "gone", modelId: "missing" }]);

  const plan = resolveImplementationDefaults({
    planModel,
    sessionModel: session,
    modelMap: undefined,
    defaultModel: undefined,
    defaultThinkingLevel: undefined,
    defaultContext: undefined,
    available,
  });
  assert.deepEqual(plan, { model: planModel, context: "keep", modelSource: "plan", unavailable: [] });
});
