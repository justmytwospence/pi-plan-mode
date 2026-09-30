import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { defineMenu, type RunMenuResult, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import {
  type AvailableImplementationModel,
  findAvailableImplementationModel,
  formatModelKey,
  formatModelSpec,
  type ImplementationModelOverride,
  type ModelSpec,
  type ModelSpecThinkingLevel,
  parseModelSpec,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { retentionLabel } from "./implementation-retention.js";
import { runMenuWithVimKeys } from "./menu-keys.js";
import { planExportDestination } from "./plan-export.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import {
  configuredImplementationContext,
  configuredImplementationModel,
  configuredImplementationModelMap,
  configuredImplementationPlanRetention,
  configuredImplementationThinkingLevel,
  configuredPlanExportPath,
  configuredPlanModeToggleShortcut,
  configuredPlanners,
  IMPLEMENTATION_PLAN_RETENTIONS,
  IMPLEMENTATION_THINKING_LEVELS,
  normalizeKeyId,
  PLAN_MODE_THINKING_LEVELS,
  type PlanModeSettings,
  type PlanModeSettingsLoadResult,
  type PlanModeSettingsPatch,
  planModeSettingsPath,
  readPlanModeSettings,
  type UpdatePlanModeSettingsOptions,
  updatePlanModeSettings,
} from "./settings.js";
import { canSelectToolInPlanMode } from "./tool-policy.js";
import { defaultPlanModeToolNames, toolPolicyLabel } from "./tool-selection.js";

interface SettingsMenuState {
  kind: "valid" | "invalid";
  settings: PlanModeSettings;
  notice?: string;
  reason?: string;
}

export interface PlanModeSettingsMenuOptions {
  tools: readonly ToolInfo[];
  activeToolNames?: readonly string[];
  signal: AbortSignal;
  isCurrent(): boolean;
  settingsPath?: string;
  legacySettingsPath?: string;
  startupToggleShortcut?: PlanModeSettings["toggleShortcut"];
  readSettings?: (settingsPath?: string) => Promise<PlanModeSettingsLoadResult>;
  updateSettings?: (patch: PlanModeSettingsPatch, options?: UpdatePlanModeSettingsOptions) => Promise<PlanModeSettings>;
  onSaved(settings: PlanModeSettings): void;
}

type Screen =
  | "settings"
  | "tools"
  | "implementation-model"
  | "model-map"
  | "map-source"
  | "map-target"
  | "map-effort"
  | "planners"
  | "export"
  | "shortcut";
type Action =
  | "set-context"
  | "open-model-map"
  | "edit-mapping"
  | "select-map-source"
  | "select-map-target"
  | "select-map-effort"
  | "open-planners"
  | "toggle-planner"
  | "reset-planners"
  | "set-thinking"
  | "open-tools"
  | "toggle-tool"
  | "reset-tools"
  | "set-retention"
  | "open-implementation-model"
  | "set-implementation-model"
  | "set-implementation-thinking"
  | "open-export"
  | "set-export"
  | "open-shortcut"
  | "set-shortcut";

export async function showPlanModeSettings(
  ctx: ExtensionContext,
  options: PlanModeSettingsMenuOptions,
): Promise<RunMenuResult> {
  const settingsPath = options.settingsPath ?? planModeSettingsPath();
  const readSettings = options.readSettings ?? readPlanModeSettings;
  const updateSettings = options.updateSettings ?? updatePlanModeSettings;
  const activeToolNames = new Set(options.activeToolNames ?? options.tools.map((tool) => tool.name));
  const tools = options.tools.filter(
    (tool) => tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME,
  );
  const toolItemIds = new Map(tools.map((tool, index) => [tool.name, `plan-settings-tool:${index}`]));
  const toolsByItemId = new Map(tools.map((tool) => [toolItemIds.get(tool.name) as string, tool]));
  const implementationModels = snapshotAvailableImplementationModels(ctx);
  const modelItemIds = new Map(implementationModels.map((model, index) => [model, `plan-settings-model:${index}`]));
  const modelsByItemId = new Map(implementationModels.map((model) => [modelItemIds.get(model) as string, model]));
  let draftSource: ImplementationModelOverride | undefined;
  let draftTarget: ImplementationModelOverride | undefined;

  const loadState = async (): Promise<SettingsMenuState> => {
    const loaded = await readSettings(options.settingsPath);
    if (loaded.kind === "invalid") {
      return {
        kind: "invalid",
        settings: { thinkingLevel: "inherit" },
        notice: loaded.notice,
        reason: loaded.reason,
      };
    }
    return {
      kind: "valid",
      settings: loaded.kind === "loaded" ? loaded.settings : { thinkingLevel: "inherit" },
      notice: loaded.notice,
    };
  };

  const menu = defineMenu<SettingsMenuState, Screen, Action, ExtensionContext>({
    start: "settings",
    screens: {
      settings: ({ state }) =>
        state.kind === "invalid"
          ? invalidScreen(settingsPath, state)
          : {
              kind: "settings",
              title: "Plan Mode Settings",
              lines: settingsLines(settingsPath, state.notice),
              items: [
                {
                  id: "thinkingLevel",
                  label: "Plan thinking",
                  description: "Set the thinking level when the next Plan workflow starts.",
                  currentValue: state.settings.thinkingLevel,
                  values: PLAN_MODE_THINKING_LEVELS,
                  action: "set-thinking",
                },
                {
                  id: "defaultPlanTools",
                  label: "Plan policy tools",
                  description: "Choose active tools or retain names to resolve before the first request.",
                  currentValue: defaultToolsValue(state.settings.defaultPlanTools),
                  action: "open-tools",
                },
                {
                  id: "implementationPlanRetention",
                  label: "Plan reinjection",
                  description:
                    "Choose how long Plan mode restores the exact plan when ordinary context no longer contains it.",
                  currentValue: retentionLabel(configuredImplementationPlanRetention(state.settings)),
                  values: IMPLEMENTATION_PLAN_RETENTIONS.map(retentionLabel),
                  action: "set-retention",
                },
                {
                  id: "defaultImplementationModel",
                  label: "Default implementation model",
                  description: "Preselected when the planning model has no map entry.",
                  currentValue: implementationModelValue(state.settings, implementationModels),
                  action: "open-implementation-model",
                },
                {
                  id: "defaultImplementationThinkingLevel",
                  label: "Default implementation effort",
                  description: "Preselected effort when the map entry does not set one.",
                  currentValue: configuredImplementationThinkingLevel(state.settings) ?? "same as plan",
                  values: ["same as plan", ...IMPLEMENTATION_THINKING_LEVELS],
                  action: "set-implementation-thinking",
                },
                {
                  id: "defaultPlanExportPath",
                  label: "Export destination",
                  description: "Set the destination used when an export omits its path.",
                  currentValue: safeTerminalText(configuredPlanExportPath(state.settings)),
                  action: "open-export",
                },
                {
                  id: "toggleShortcut",
                  label: "Plan mode shortcut",
                  description:
                    "Saved TUI shortcut. Changes require /reload or restarting Pi; the current binding stays unchanged.",
                  currentValue: configuredPlanModeToggleShortcut(state.settings) ?? "none",
                  action: "open-shortcut",
                },
                {
                  id: "implementationModelMap",
                  label: "Implementation model map",
                  description: "Per planning model, the model and effort preselected when implementation starts.",
                  currentValue: modelMapValue(state.settings),
                  action: "open-model-map",
                },
                {
                  id: "defaultImplementationContext",
                  label: "Implementation context",
                  description: "Keep the planning conversation or start a fresh session with only the plan.",
                  currentValue: configuredImplementationContext(state.settings),
                  values: ["keep", "clear"],
                  action: "set-context",
                },
                {
                  id: "planners",
                  label: "Planner models",
                  description: "Models preselected for /plan multi and Compare with other models.",
                  currentValue: plannersValue(state.settings),
                  action: "open-planners",
                },
              ],
            },
      tools: ({ state }) => ({
        kind: "multiSelect",
        title: "Default Plan policy allowlist",
        lines: [
          "Changes apply when a later Plan workflow starts; model-visible tools stay unchanged.",
          "Retained inactive names resolve before that workflow's first request.",
          "Plan mode never activates tools, and non-built-ins run at user risk.",
        ],
        enableSearch: true,
        viewportSize: 10,
        items: defaultToolItems(tools, state.settings.defaultPlanTools, activeToolNames, toolItemIds),
        action: "toggle-tool",
        actions: [
          {
            id: "reset-tools",
            label: "Use automatic safe built-ins",
            action: "reset-tools",
          },
        ],
        hint: "back",
      }),
      "implementation-model": ({ state }) => ({
        kind: "choice",
        title: "Default implementation model",
        lines: ["Same as plan is the default and fallback when a configured model is unavailable."],
        items: implementationModelItems(implementationModels, modelItemIds),
        action: "set-implementation-model",
        initialItemId: implementationModelItemId(
          configuredImplementationModel(state.settings),
          implementationModels,
          modelItemIds,
        ),
        enableSearch: true,
        viewportSize: 10,
        hint: "back",
      }),
      "model-map": ({ state }) => {
        const entries = Object.entries(configuredImplementationModelMap(state.settings));
        return {
          kind: "actions",
          title: "Implementation model map",
          lines: [
            "When a plan was written by the model on the left, implementation preselects the model and effort on the right.",
            "You can still override both on the Implement screen.",
          ],
          items: [
            ...entries.map(([source, target], index) => ({
              id: `plan-settings-map:${index}`,
              label: `${safeTerminalText(source)} → ${safeTerminalText(formatModelKey(target))}`,
              description: target.thinkingLevel ? `effort ${target.thinkingLevel}` : "effort: default",
              action: "edit-mapping" as const,
            })),
            { id: "add-mapping", label: "Add mapping…", action: "edit-mapping" as const },
          ],
          hint: "back",
        };
      },
      "map-source": () => ({
        kind: "choice",
        title: "Planning model",
        lines: ["Choose the model whose plans this mapping applies to."],
        items: implementationModelChoiceItems(implementationModels, modelItemIds),
        action: "select-map-source",
        enableSearch: true,
        viewportSize: 10,
        hint: "back",
      }),
      "map-target": ({ state }) => {
        const existing = draftSource
          ? configuredImplementationModelMap(state.settings)[formatModelKey(draftSource)]
          : undefined;
        return {
          kind: "choice",
          title: `Implement plans from ${draftSource ? safeModelReference(draftSource) : "this model"} with`,
          items: [
            ...(existing ? [{ id: "remove-mapping", label: "Remove mapping" }] : []),
            ...implementationModelChoiceItems(implementationModels, modelItemIds),
          ],
          action: "select-map-target",
          initialItemId: implementationModelItemId(existing, implementationModels, modelItemIds),
          enableSearch: true,
          viewportSize: 10,
          hint: "back",
        };
      },
      "map-effort": ({ state }) => {
        const existing = draftSource
          ? configuredImplementationModelMap(state.settings)[formatModelKey(draftSource)]
          : undefined;
        return {
          kind: "choice",
          title: "Implementation effort for this mapping",
          items: [
            { id: "effort-default", label: "Default", description: "Use the default implementation effort." },
            ...IMPLEMENTATION_THINKING_LEVELS.map((level) => ({ id: level, label: level })),
          ],
          action: "select-map-effort",
          initialItemId: existing?.thinkingLevel ?? "effort-default",
          hint: "back",
        };
      },
      planners: ({ state }) => {
        const configured = configuredPlanners(state.settings);
        const configuredKeys = new Set(configured.map(formatModelSpec));
        const extra = configured.filter(
          (spec) => spec.thinkingLevel || !findAvailableImplementationModel(implementationModels, spec),
        );
        return {
          kind: "multiSelect",
          title: "Planner models",
          lines: [
            "Preselected when /plan multi or Compare with other models starts; you can change them per run.",
            "Add an effort suffix in the settings file, e.g. anthropic/claude-opus-5-5:xhigh.",
          ],
          enableSearch: true,
          viewportSize: 10,
          items: [
            ...extra.map((spec) => ({
              id: `planner-spec:${formatModelSpec(spec)}`,
              label: safeTerminalText(formatModelSpec(spec)),
              selected: true,
            })),
            ...implementationModels.map((model) => {
              const key = formatModelKey({ provider: model.provider, modelId: model.id });
              return {
                id: `planner-spec:${key}`,
                label: safeModelReference({ provider: model.provider, modelId: model.id }),
                searchText: key,
                selected: configuredKeys.has(key),
              };
            }),
          ],
          action: "toggle-planner",
          actions: [{ id: "reset-planners", label: "Clear planner defaults", action: "reset-planners" }],
          hint: "back",
        };
      },
      export: ({ state }) => {
        const configured = configuredPlanExportPath(state.settings);
        const destination = planExportDestination(configured, ctx.cwd);
        return {
          kind: "input",
          title: "Export destination",
          lines: [
            `Configured: ${destination.configuredPath}`,
            `Resolves here to: ${destination.resolvedPath}`,
            "Submit an empty value to reset to PLAN.md. Changes affect the next export.",
          ],
          placeholder: configured,
          action: "set-export",
          hint: "back",
        };
      },
      shortcut: ({ state }) => ({
        kind: "input",
        title: "Plan mode shortcut",
        lines: [
          `Configured: ${configuredPlanModeToggleShortcut(state.settings) ?? "none"}`,
          `Loaded at startup: ${safeTerminalText(options.startupToggleShortcut ?? "none")}`,
          "TUI only. Use Pi key identifiers; Pi may reject conflicting shortcuts.",
          "Submit an empty value to remove the saved shortcut.",
          "Run /reload or restart Pi to apply changes; the current binding stays unchanged until then.",
        ],
        placeholder: configuredPlanModeToggleShortcut(state.settings) ?? "",
        action: "set-shortcut",
        hint: "back",
      }),
    },
    actions: {
      "set-context": async ({ ctx: actionCtx, value, signal }) => {
        if (value !== "keep" && value !== "clear") return { kind: "rejected" };
        return savePatch(
          actionCtx,
          { defaultImplementationContext: value },
          signal,
          value === "clear"
            ? "Implementation context: clear (fresh session with only the plan)."
            : "Implementation context: keep the planning conversation.",
        );
      },
      "open-model-map": async () => ({ kind: "to", screen: "model-map" }),
      "edit-mapping": async ({ state, itemId }) => {
        const index = itemId?.startsWith("plan-settings-map:") ? Number(itemId.slice("plan-settings-map:".length)) : -1;
        const entry = Object.keys(configuredImplementationModelMap(state.settings))[index];
        draftTarget = undefined;
        if (!entry) {
          draftSource = undefined;
          return { kind: "to", screen: "map-source" };
        }
        draftSource = parseModelSpec(entry);
        return draftSource ? { kind: "to", screen: "map-target" } : { kind: "rejected" };
      },
      "select-map-source": async ({ itemId }) => {
        const model = itemId ? modelsByItemId.get(itemId) : undefined;
        if (!model) return { kind: "rejected" };
        draftSource = { provider: model.provider, modelId: model.id };
        return { kind: "to", screen: "map-target" };
      },
      "select-map-target": async ({ ctx: actionCtx, state, itemId, signal }) => {
        if (!draftSource) return { kind: "rejected" };
        if (itemId === "remove-mapping") {
          const next = { ...configuredImplementationModelMap(state.settings) };
          delete next[formatModelKey(draftSource)];
          const result = await savePatch(
            actionCtx,
            { implementationModelMap: next },
            signal,
            `Removed the implementation mapping for ${safeModelReference(draftSource)}.`,
          );
          return result.kind === "stay" ? { kind: "to", screen: "model-map" } : result;
        }
        const model = itemId ? modelsByItemId.get(itemId) : undefined;
        if (!model) return { kind: "rejected" };
        draftTarget = { provider: model.provider, modelId: model.id };
        return { kind: "to", screen: "map-effort" };
      },
      "select-map-effort": async ({ ctx: actionCtx, state, itemId, signal }) => {
        if (!draftSource || !draftTarget) return { kind: "rejected" };
        const thinkingLevel = IMPLEMENTATION_THINKING_LEVELS.find((level) => level === itemId) as
          | ModelSpecThinkingLevel
          | undefined;
        const target: ModelSpec = { ...draftTarget, ...(thinkingLevel ? { thinkingLevel } : {}) };
        const next = { ...configuredImplementationModelMap(state.settings), [formatModelKey(draftSource)]: target };
        const result = await savePatch(
          actionCtx,
          { implementationModelMap: next },
          signal,
          `Plans from ${safeModelReference(draftSource)} now implement with ${safeModelReference(target)}${thinkingLevel ? ` at ${thinkingLevel}` : ""}.`,
        );
        return result.kind === "stay" ? { kind: "to", screen: "model-map" } : result;
      },
      "open-planners": async () => ({ kind: "to", screen: "planners" }),
      "toggle-planner": async ({ ctx: actionCtx, state, itemId, selected, signal }) => {
        const spec = itemId?.startsWith("planner-spec:")
          ? parseModelSpec(itemId.slice("planner-spec:".length))
          : undefined;
        if (!spec) return { kind: "rejected" };
        const key = formatModelSpec(spec);
        const current = configuredPlanners(state.settings).filter((existing) => formatModelSpec(existing) !== key);
        const next = selected ? [...current, spec] : current;
        return savePatch(
          actionCtx,
          { planners: next },
          signal,
          `Planner models: ${next.length === 0 ? "none preselected" : next.map(formatModelSpec).join(", ")}.`,
        );
      },
      "reset-planners": async ({ ctx: actionCtx, state, signal }) => {
        if (configuredPlanners(state.settings).length === 0) return { kind: "stay" };
        return savePatch(actionCtx, { planners: null }, signal, "Planner models: none preselected.");
      },
      "set-thinking": async ({ ctx: actionCtx, value, signal }) => {
        if (!PLAN_MODE_THINKING_LEVELS.includes(value as (typeof PLAN_MODE_THINKING_LEVELS)[number])) {
          return { kind: "rejected" };
        }
        return savePatch(
          actionCtx,
          { thinkingLevel: value as PlanModeSettings["thinkingLevel"] },
          signal,
          `Plan mode thinking level: ${value}. Applies to the next Plan workflow.`,
        );
      },
      "open-tools": async () => ({ kind: "to", screen: "tools" }),
      "set-retention": async ({ ctx: actionCtx, value, signal }) => {
        const implementationPlanRetention = retentionFromLabel(value);
        if (!implementationPlanRetention) return { kind: "rejected" };
        return savePatch(
          actionCtx,
          { implementationPlanRetention },
          signal,
          `Plan reinjection: ${retentionLabel(implementationPlanRetention)}. Applies to the next Implement action.`,
        );
      },
      "open-implementation-model": async () => ({
        kind: "to",
        screen: "implementation-model",
      }),
      "set-implementation-model": async ({ ctx: actionCtx, itemId, signal }) => {
        const model = itemId ? modelsByItemId.get(itemId) : undefined;
        if (itemId !== "same-as-plan" && !model) return { kind: "rejected" };
        const defaultImplementationModel = model ? { provider: model.provider, modelId: model.id } : null;
        const result = await savePatch(
          actionCtx,
          { defaultImplementationModel },
          signal,
          model
            ? `Default implementation model: ${safeModelReference({ provider: model.provider, modelId: model.id })}.`
            : "Default implementation model: same as plan.",
        );
        return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
      },
      "set-implementation-thinking": async ({ ctx: actionCtx, value, signal }) => {
        if (value === "same as plan") {
          return savePatch(
            actionCtx,
            { defaultImplementationThinkingLevel: null },
            signal,
            "Default implementation effort: same as plan.",
          );
        }
        if (!IMPLEMENTATION_THINKING_LEVELS.includes(value as (typeof IMPLEMENTATION_THINKING_LEVELS)[number])) {
          return { kind: "rejected" };
        }
        return savePatch(
          actionCtx,
          {
            defaultImplementationThinkingLevel: value as PlanModeSettings["defaultImplementationThinkingLevel"],
          },
          signal,
          `Default implementation effort: ${value}.`,
        );
      },
      "open-export": async () => ({ kind: "to", screen: "export" }),
      "set-export": async ({ ctx: actionCtx, value, signal }) => {
        const defaultPlanExportPath = value?.trim() || null;
        const result = await savePatch(
          actionCtx,
          { defaultPlanExportPath },
          signal,
          defaultPlanExportPath
            ? `Default Plan export destination: ${safeTerminalText(defaultPlanExportPath)}.`
            : "Default Plan export destination reset to PLAN.md.",
        );
        return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
      },
      "open-shortcut": async () => ({ kind: "to", screen: "shortcut" }),
      "set-shortcut": async ({ ctx: actionCtx, value, signal }) => {
        const raw = value?.trim() || null;
        if (raw && !normalizeKeyId(raw)) {
          actionCtx.ui.notify(
            `Invalid key identifier: ${safeTerminalText(raw)}. Use Pi key identifiers like ctrl+alt+p.`,
            "warning",
          );
          return { kind: "stay" as const };
        }
        const toggleShortcut = raw as PlanModeSettingsPatch["toggleShortcut"];
        const result = await savePatch(
          actionCtx,
          { toggleShortcut },
          signal,
          toggleShortcut
            ? `Plan mode shortcut saved: ${safeTerminalText(toggleShortcut)}. Run /reload or restart Pi to apply; the current binding is unchanged.`
            : "Plan mode shortcut removal saved. Run /reload or restart Pi to apply; the current binding is unchanged.",
        );
        return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
      },
      "toggle-tool": async ({ ctx: actionCtx, state, itemId, selected, signal }) => {
        const tool = itemId ? toolsByItemId.get(itemId) : undefined;
        if (!tool || !activeToolNames.has(tool.name) || !canSelectToolInPlanMode(tool)) {
          return { kind: "rejected" };
        }
        const names = explicitToolNames(tools, state.settings.defaultPlanTools);
        const next = selected ? Array.from(new Set([...names, tool.name])) : names.filter((name) => name !== tool.name);
        return savePatch(
          actionCtx,
          { defaultPlanTools: next },
          signal,
          `Default Plan policy: ${next.length === 0 ? "no optional tools" : `${next.length} allowed`}.`,
        );
      },
      "reset-tools": async ({ ctx: actionCtx, state, signal }) => {
        if (state.settings.defaultPlanTools === undefined) return { kind: "stay" };
        return savePatch(
          actionCtx,
          { defaultPlanTools: null },
          signal,
          "Default Plan-mode tools: automatic safe built-ins.",
        );
      },
    },
  });

  return runMenuWithVimKeys(ctx, menu, {
    getState: loadState,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });

  async function savePatch(
    actionCtx: ExtensionContext,
    patch: PlanModeSettingsPatch,
    signal: AbortSignal,
    successMessage: string,
  ) {
    if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
    try {
      const saved = await updateSettings(patch, {
        settingsPath: options.settingsPath,
        legacySettingsPath: options.legacySettingsPath,
        signal,
      });
      if (options.isCurrent()) options.onSaved(saved);
      if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
      actionCtx.ui.notify(successMessage, "info");
      return { kind: "stay" as const };
    } catch (error) {
      if (!signal.aborted && options.isCurrent()) {
        actionCtx.ui.notify(
          `Could not save Plan mode settings; the previous value remains: ${safeTerminalText(formatError(error))}`,
          "error",
        );
      }
      return { kind: "rejected" as const };
    }
  }
}

function settingsLines(settingsPath: string, notice: string | undefined) {
  return [
    `User settings · ${safeTerminalText(settingsPath)}`,
    "Plan defaults apply to the next workflow; reinjection and export choices apply to their next action.",
    ...(notice ? [safeTerminalText(notice)] : []),
  ];
}

function invalidScreen(settingsPath: string, state: SettingsMenuState) {
  return {
    kind: "detail" as const,
    title: "Plan Mode Settings · Read only",
    lines: [
      `Invalid settings file. Fix ${safeTerminalText(settingsPath)} before saving.`,
      safeTerminalText(state.reason ?? "The settings file is invalid."),
      ...(state.notice ? [safeTerminalText(state.notice)] : []),
    ],
    hint: "back" as const,
  };
}

function retentionFromLabel(value: string | undefined) {
  return IMPLEMENTATION_PLAN_RETENTIONS.find((retention) => retentionLabel(retention) === value);
}

function implementationModelValue(settings: PlanModeSettings, models: readonly AvailableImplementationModel[]) {
  const configured = configuredImplementationModel(settings);
  if (!configured) return "same as plan";
  return findAvailableImplementationModel(models, configured)
    ? safeModelReference(configured)
    : `same as plan · ${safeModelReference(configured)} unavailable`;
}

function modelMapValue(settings: PlanModeSettings) {
  const count = Object.keys(configuredImplementationModelMap(settings)).length;
  return count === 0 ? "none" : `${count} mapping${count === 1 ? "" : "s"}`;
}

function plannersValue(settings: PlanModeSettings) {
  const planners = configuredPlanners(settings);
  return planners.length === 0 ? "none" : `${planners.length} selected`;
}

function implementationModelChoiceItems(
  models: readonly AvailableImplementationModel[],
  itemIds: ReadonlyMap<AvailableImplementationModel, string>,
) {
  return implementationModelItems(models, itemIds).filter((item) => item.id !== "same-as-plan");
}

function implementationModelItems(
  models: readonly AvailableImplementationModel[],
  itemIds: ReadonlyMap<AvailableImplementationModel, string>,
) {
  return [
    {
      id: "same-as-plan",
      label: "Same as plan",
      description: "Use the planning session model.",
    },
    ...models.map((model) => {
      const reference = safeModelReference({ provider: model.provider, modelId: model.id });
      const name = safeModelMetadata(model.name, "");
      return {
        id: itemIds.get(model) as string,
        label: reference,
        ...(name ? { details: [`Model Name: ${name}`] } : {}),
        searchText: [reference, name].filter(Boolean).join(" "),
      };
    }),
  ];
}

function implementationModelItemId(
  configured: ImplementationModelOverride | undefined,
  models: readonly AvailableImplementationModel[],
  itemIds: ReadonlyMap<AvailableImplementationModel, string>,
) {
  const model = findAvailableImplementationModel(models, configured);
  return model ? itemIds.get(model) : "same-as-plan";
}

function safeModelReference(model: ImplementationModelOverride) {
  return `${safeModelMetadata(model.modelId, "unknown model")} [${safeModelMetadata(model.provider, "unknown provider")}]`;
}

function safeModelMetadata(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const safe = sanitizeTerminalText(value).trim() || fallback;
  return [...safe].slice(0, 512).join("");
}

function defaultToolsValue(configured: string[] | undefined) {
  if (configured === undefined) return "Automatic safe built-ins";
  if (configured.length === 0) return "No optional tools";
  return `${configured.length} selected`;
}

function defaultToolItems(
  tools: readonly ToolInfo[],
  configured: string[] | undefined,
  activeToolNames: ReadonlySet<string>,
  toolItemIds: ReadonlyMap<string, string>,
) {
  const selected = new Set(explicitToolNames(tools, configured));
  const availableNames = new Set(tools.map((tool) => tool.name));
  const items = tools.map((tool) => {
    const active = activeToolNames.has(tool.name);
    const selectable = active && canSelectToolInPlanMode(tool);
    const policy = active
      ? toolPolicyLabel(tool)
      : selected.has(tool.name)
        ? "not active yet; retained for first-request resolution"
        : "not active in this Pi session";
    const description = tool.description ?? "No description available";
    return {
      id: toolItemIds.get(tool.name) as string,
      label: tool.name,
      description: `${policy} · ${description}`,
      searchText: `${policy} ${description}`,
      selected: selected.has(tool.name),
      disabled: !selectable,
      disabledReason: !active
        ? selected.has(tool.name)
          ? "Not active yet; retained and resolved before the first request"
          : "Not active in Pi; Plan mode will not activate it"
        : selectable
          ? undefined
          : "Blocked by Plan-mode policy",
    };
  });
  for (const [index, name] of (configured ?? []).entries()) {
    if (availableNames.has(name)) continue;
    const label = terminalToolName(name);
    items.push({
      id: `plan-settings-pending:${index}`,
      label,
      description: "pending registration · Retained and resolved before the first request",
      searchText: `${label} pending registration retained settings first request`,
      selected: true,
      disabled: true,
      disabledReason: "Not registered yet; reset defaults to remove retained names",
    });
  }
  return items;
}

function explicitToolNames(tools: readonly ToolInfo[], configured: string[] | undefined) {
  return configured === undefined ? defaultPlanModeToolNames([...tools], undefined) : [...configured];
}

function terminalToolName(value: string) {
  const safe = safeTerminalText(value) || "(unnamed tool)";
  return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
}

function safeTerminalText(value: string) {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .trim();
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
