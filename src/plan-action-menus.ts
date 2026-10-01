import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import {
  type AvailableImplementationModel,
  findAvailableImplementationModel,
  type ImplementationContextChoice,
  type ImplementationModelOverride,
  type ResolvedImplementationDefaults,
  sameModel,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { runMenuWithVimKeys } from "./menu-keys.js";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";
import { type PlanFrame, withPlanFrame } from "./plan-frame.js";
import { IMPLEMENTATION_THINKING_LEVELS, type PlanModeFixedThinkingLevel } from "./settings.js";
import type { ImplementationRuntimeSelection } from "./state.js";

interface MenuLifecycle {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export interface ImplementationChoice {
  runtime: ImplementationRuntimeSelection;
  context: ImplementationContextChoice;
}

/** Everything the implementation screen needs to preselect and explain its defaults. */
export interface ImplementationMenuDefaults {
  /** Model that authored the plan, when known. */
  planModel?: ImplementationModelOverride;
  planThinkingLevel: PlanModeFixedThinkingLevel | undefined;
  resolved: ResolvedImplementationDefaults;
}

export type ImplementAction = (choice: ImplementationChoice, signal: AbortSignal) => void | Promise<void>;

const THINKING_LEVEL_DESCRIPTIONS: Record<PlanModeFixedThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

const CONTEXT_LABELS: Record<ImplementationContextChoice, string> = {
  keep: "Keep planning conversation",
  clear: "Clear context (fresh session with only the plan)",
};

interface PlanMenuOptions extends MenuLifecycle {
  statusText: string;
  implementation: ImplementationMenuDefaults;
  hasReadyPlan: boolean;
  implementationOutcome(): string;
  getExportDestination: PlanExportDestinationProvider;
  show(): void;
  finalize(): void;
  implement: ImplementAction;
  compare?(): void | Promise<void>;
  planWithModels?(): void | Promise<void>;
  exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
  save(): void;
  stay(): void;
  exit(): void;
  /** The task and ready plan(s), shown above the menu while you decide (TUI). */
  frame?: PlanFrame;
}

type ImplementationScreen = "implement" | "models" | "thinking" | "context";
type ImplementationActionId = "start-implementation" | "select-model" | "select-thinking" | "select-context";

export async function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions) {
  type Screen = "main" | ImplementationScreen | "export";
  type Action =
    | "show"
    | "finalize"
    | "compare"
    | "plan-with-models"
    | ImplementationActionId
    | "export"
    | "save"
    | "stay"
    | "exit";
  const flow = createImplementationFlow(ctx, options.implementation, options.implement);
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Plan mode",
        lines: [
          options.statusText,
          ...(options.hasReadyPlan ? [flow.summaryLine(), options.implementationOutcome()] : []),
        ],
        items: options.hasReadyPlan
          ? [
              { id: "show", label: "Show latest proposed plan", action: "show" },
              {
                id: "implement",
                label: "Implement…",
                description: "Choose the model, effort, and context, then start.",
                to: "implement",
              },
              ...(options.compare
                ? [
                    {
                      id: "compare",
                      label: "Compare with other models…",
                      description: "Plan the same task with other models in parallel, then pick or synthesize.",
                      action: "compare" as const,
                    },
                  ]
                : []),
              { id: "export", label: "Export plan…", to: "export" },
              { id: "save", label: "Save for later", action: "save" },
              { id: "stay", label: "Stay in Plan mode", action: "stay" },
              { id: "exit", label: "Discard plan and exit", action: "exit" },
            ]
          : [
              { id: "finalize", label: "Request final plan", action: "finalize" },
              ...(options.planWithModels
                ? [
                    {
                      id: "plan-with-models",
                      label: "Plan with multiple models…",
                      description: "Run independent planners in parallel on this conversation.",
                      action: "plan-with-models" as const,
                    },
                  ]
                : []),
              { id: "stay", label: "Stay in Plan mode", action: "stay" },
              { id: "exit", label: "Exit Plan mode", action: "exit" },
            ],
        hint: "close",
      }),
      ...flow.screens,
      export: () => planExportInputScreen(options.getExportDestination),
    },
    actions: {
      show: async () => {
        options.show();
        return { kind: "close" };
      },
      finalize: async () => {
        options.finalize();
        return { kind: "close" };
      },
      compare: async () => {
        await options.compare?.();
        return { kind: "close" };
      },
      "plan-with-models": async () => {
        await options.planWithModels?.();
        return { kind: "close" };
      },
      ...flow.actions,
      export: async ({ value, signal }) =>
        (await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
      save: async () => {
        options.save();
        return { kind: "close" };
      },
      stay: async () => {
        options.stay();
        return { kind: "close" };
      },
      exit: async () => {
        options.exit();
        return { kind: "close" };
      },
    },
  });
  await runMenuWithVimKeys(options.frame ? withPlanFrame(ctx, options.frame) : ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
}

interface ReadyPlanMenuOptions extends MenuLifecycle {
  implementation: ImplementationMenuDefaults;
  implementationOutcome(): string;
  getExportDestination: PlanExportDestinationProvider;
  implement: ImplementAction;
  compare?(): void | Promise<void>;
  exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
  save(): void;
  stay(): void;
  exit(): void;
  /** The task and plan(s), shown above the menu while you decide (TUI). */
  frame?: PlanFrame;
  /** Open straight on the Implement screen (a plan was just chosen to implement). */
  initialScreen?: "implement";
}

export async function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions) {
  type Screen = "ready" | ImplementationScreen | "export";
  type Action = ImplementationActionId | "compare" | "export" | "save" | "stay" | "exit";
  const flow = createImplementationFlow(ctx, options.implementation, options.implement);
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: options.initialScreen ?? "ready",
    screens: {
      ready: () => ({
        kind: "actions",
        title: "Proposed plan ready. What next?",
        lines: [flow.summaryLine(), options.implementationOutcome()],
        items: [
          {
            id: "implement",
            label: "Implement…",
            description: "Choose the model, effort, and context, then start.",
            to: "implement",
          },
          ...(options.compare
            ? [
                {
                  id: "compare",
                  label: "Compare with other models…",
                  description: "Plan the same task with other models in parallel, then pick or synthesize.",
                  action: "compare" as const,
                },
              ]
            : []),
          { id: "export", label: "Export plan…", to: "export" },
          { id: "save", label: "Save for later", action: "save" },
          { id: "stay", label: "Stay in Plan mode", action: "stay" },
          { id: "exit", label: "Discard plan and exit", action: "exit" },
        ],
        hint: "close",
      }),
      ...flow.screens,
      export: () => planExportInputScreen(options.getExportDestination),
    },
    actions: {
      ...flow.actions,
      compare: async () => {
        await options.compare?.();
        return { kind: "close" };
      },
      export: async ({ value, signal }) =>
        (await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
      save: async () => {
        options.save();
        return { kind: "close" };
      },
      stay: async () => {
        options.stay();
        return { kind: "close" };
      },
      exit: async () => {
        options.exit();
        return { kind: "close" };
      },
    },
  });
  const framed = options.frame ? withPlanFrame(ctx, options.frame) : ctx;
  const runOptions = { getState: () => undefined, signal: options.signal, isCurrent: options.isCurrent };
  const result = await runMenuWithVimKeys(framed, menu, runOptions);
  // Opened on the Implement screen: going back from it lands on the ready menu, not outside.
  if (options.initialScreen && result.kind === "closed" && result.reason === "back" && options.isCurrent()) {
    await runMenuWithVimKeys(framed, { ...menu, start: "ready" }, runOptions);
  }
}

interface ModelChoice {
  itemId: string;
  model: ImplementationModelOverride;
  modelInfo: AvailableImplementationModel;
  label: string;
  summary: string;
  details?: readonly string[];
  searchText: string;
  isSessionModel: boolean;
}

/**
 * The shared "Implement" screens: start, model, thinking level, and context. Defaults come from
 * the plan-model map, then the configured default model, then the current session model.
 */
export function createImplementationFlow(
  ctx: ExtensionContext,
  defaults: ImplementationMenuDefaults,
  implement: ImplementAction,
) {
  const models = snapshotAvailableModels(ctx);
  const sessionModel = ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined;
  const sessionModelSummary = ctx.model
    ? `${safeModelMetadata(ctx.model.id, "unknown model")} [${safeModelMetadata(ctx.model.provider, "unknown provider")}]`
    : undefined;
  const resolved = defaults.resolved;
  const defaultModelChoice = resolved.model
    ? models.find((choice) => sameModel(choice.model, resolved.model))
    : undefined;
  let selectedModel: ModelChoice | undefined = defaultModelChoice?.isSessionModel ? undefined : defaultModelChoice;
  let selectedModelUsesDefault = selectedModel !== undefined;
  let selectedThinkingLevel: PlanModeFixedThinkingLevel | undefined = resolved.thinkingLevel;
  let selectedContext: ImplementationContextChoice = resolved.context;
  const planThinkingLevel = defaults.planThinkingLevel;

  const sessionModelLabel = sessionModelSummary ? `${sessionModelSummary} · current model` : "Current model";
  const modelDescription = () => {
    const summary = selectedModel?.summary ?? sessionModelLabel;
    return selectedModelUsesDefault && resolved.modelSource === "map"
      ? `${summary} · from model map`
      : selectedModelUsesDefault && resolved.modelSource === "default"
        ? `${summary} · default`
        : selectedModelUsesDefault && resolved.modelSource === "plan"
          ? `${summary} · planning model`
          : summary;
  };
  const summaryLine = () => {
    const planned = defaults.planModel ? `Planned with ${safeModelReference(defaults.planModel)}.` : "";
    const effort = selectedThinkingLevel ?? planThinkingLevel;
    return [
      planned,
      `Implementation default: ${modelDescription()}${effort ? `, effort ${effort}` : ""}; ${CONTEXT_LABELS[selectedContext].toLowerCase()}.`,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const screens = {
    implement: () => ({
      kind: "actions" as const,
      title: "Implement plan",
      lines: [
        ...(defaults.planModel ? [`Planned with ${safeModelReference(defaults.planModel)}.`] : []),
        ...resolved.unavailable.map(
          (model) => `Configured implementation model ${safeModelReference(model)} is unavailable; skipped.`,
        ),
      ],
      items: [
        {
          id: "start-implementation",
          label: selectedContext === "clear" ? "Start implementation in a fresh session" : "Start implementation here",
          description:
            selectedContext === "clear"
              ? "Create a linked session that receives only the approved plan."
              : "Continue in this session with the planning conversation.",
          action: "start-implementation" as const,
          busyLabel: "Starting implementation…",
        },
        {
          id: "implementation-model",
          label: "Model",
          description: modelDescription(),
          to: "models" as const,
        },
        {
          id: "implementation-thinking",
          label: "Effort",
          description:
            selectedThinkingLevel ?? (planThinkingLevel ? `${planThinkingLevel} · same as plan` : "Same as plan"),
          to: "thinking" as const,
        },
        {
          id: "implementation-context",
          label: "Context",
          description: CONTEXT_LABELS[selectedContext],
          to: "context" as const,
        },
      ],
    }),
    models: () => ({
      kind: "choice" as const,
      title: "Implementation model",
      items: [
        {
          id: "session-model",
          label: "Current model",
          ...(sessionModelSummary ? { description: sessionModelSummary } : {}),
        },
        ...models.map((choice) => ({
          id: choice.itemId,
          label: `${choice.label}${defaultModelChoice === choice && resolved.modelSource === "map" ? " · mapped default" : ""}`,
          details: choice.details,
          searchText: choice.searchText,
        })),
      ],
      action: "select-model" as const,
      initialItemId: selectedModel?.itemId ?? "session-model",
      enableSearch: true,
      viewportSize: 10,
    }),
    thinking: () => ({
      kind: "choice" as const,
      title: "Implementation effort (thinking level)",
      items: [
        { id: "same-as-plan", label: "Same as plan" },
        ...IMPLEMENTATION_THINKING_LEVELS.map((level) => ({
          id: level,
          label: `${level === planThinkingLevel ? "✓ " : ""}${level}`,
          description: THINKING_LEVEL_DESCRIPTIONS[level],
        })),
      ],
      action: "select-thinking" as const,
      initialItemId: selectedThinkingLevel ?? "same-as-plan",
      viewportSize: IMPLEMENTATION_THINKING_LEVELS.length + 1,
    }),
    context: () => ({
      kind: "choice" as const,
      title: "Implementation context",
      items: [
        {
          id: "keep",
          label: CONTEXT_LABELS.keep,
          description: "The implementer sees the whole planning conversation and tool results.",
        },
        {
          id: "clear",
          label: CONTEXT_LABELS.clear,
          description: "A new linked session starts with only the approved plan.",
        },
      ],
      action: "select-context" as const,
      initialItemId: selectedContext,
    }),
  };

  const start = (signal: AbortSignal) => {
    if (
      selectedModelUsesDefault &&
      selectedModel &&
      !findAvailableImplementationModel(snapshotAvailableImplementationModels(ctx), selectedModel.model)
    ) {
      ctx.ui.notify(
        `Implementation model ${safeModelReference(selectedModel.model)} is no longer available; using the current model.`,
        "warning",
      );
      selectedModel = undefined;
      selectedModelUsesDefault = false;
    }
    const model = selectedModel?.model ?? (selectedContext === "clear" ? sessionModel : undefined);
    const thinkingLevel = selectedThinkingLevel ?? (selectedContext === "clear" ? planThinkingLevel : undefined);
    return implement(
      {
        runtime: {
          ...(model ? { model: { ...model } } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
        context: selectedContext,
      },
      signal,
    );
  };

  const actions = {
    "start-implementation": async ({ signal }: { signal: AbortSignal }) => {
      await start(signal);
      return { kind: "close" as const };
    },
    "select-model": async ({ itemId }: { itemId?: string }) => {
      const choice = models.find((candidate) => candidate.itemId === itemId);
      selectedModel = itemId === "session-model" || choice?.isSessionModel ? undefined : choice;
      selectedModelUsesDefault = false;
      return { kind: "back" as const };
    },
    "select-thinking": async ({ itemId }: { itemId?: string }) => {
      selectedThinkingLevel = IMPLEMENTATION_THINKING_LEVELS.find((level) => level === itemId);
      return { kind: "back" as const };
    },
    "select-context": async ({ itemId }: { itemId?: string }) => {
      if (itemId === "keep" || itemId === "clear") selectedContext = itemId;
      return { kind: "back" as const };
    },
  };

  return { screens, actions, start, summaryLine };
}

function snapshotAvailableModels(ctx: ExtensionContext): ModelChoice[] {
  return snapshotAvailableImplementationModels(ctx)
    .map((model, index) => {
      const provider = safeModelMetadata(model.provider, "unknown provider");
      const modelId = safeModelMetadata(model.id, "unknown model");
      const name = safeModelMetadata(model.name, "");
      const isSessionModel = ctx.model?.provider === model.provider && ctx.model.id === model.id;
      const summary = `${modelId} [${provider}]`;
      return {
        itemId: `model-${index}`,
        model: { provider: model.provider, modelId: model.id },
        modelInfo: model,
        label: `${isSessionModel ? "✓ " : ""}${summary}${isSessionModel ? " · current" : ""}`,
        summary,
        ...(name ? { details: [`Model Name: ${name}`] } : {}),
        searchText: [provider, modelId, name].filter(Boolean).join(" "),
        isSessionModel,
      };
    })
    .sort((left, right) => Number(right.isSessionModel) - Number(left.isSessionModel));
}

export function safeModelReference(model: ImplementationModelOverride | undefined) {
  if (!model) return "configured model";
  return `${safeModelMetadata(model.modelId, "unknown model")} [${safeModelMetadata(model.provider, "unknown provider")}]`;
}

function safeModelMetadata(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const safe = sanitizeTerminalText(value).trim() || fallback;
  return [...safe].slice(0, 512).join("");
}
