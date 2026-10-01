import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ImplementationModelOverride,
  resolveImplementationDefaults,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import type { ImplementationChoice, ImplementationMenuDefaults } from "./plan-action-menus.js";
import type { PlanExportDestination } from "./plan-export.js";
import type { PlanFrame } from "./plan-frame.js";
import {
  configuredImplementationContext,
  configuredImplementationModel,
  configuredImplementationModelMap,
  configuredImplementationThinkingLevel,
  type PlanModeFixedThinkingLevel,
  type PlanModeSettings,
} from "./settings.js";
import type { ImplementationRuntimeSelection, PlanModeState } from "./state.js";

type InteractiveUi = typeof import("./interactive-ui.js");

interface MenuLifecycle {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export type FreshImplementationTiming = "immediate" | "after-settled";

interface PlanActionControllerOptions {
  loadInteractiveUi(): Promise<InteractiveUi>;
  getState(): PlanModeState;
  captureLifecycle(): MenuLifecycle;
  statusText(): string;
  getThinkingLevel(): PlanModeFixedThinkingLevel | undefined;
  getSettings(): PlanModeSettings;
  implementationOutcome(): string;
  getExportDestination(ctx: ExtensionContext): PlanExportDestination;
  show(ctx: ExtensionContext): void;
  finalize(ctx: ExtensionContext): void;
  implementHere(ctx: ExtensionContext, runtime?: ImplementationRuntimeSelection): void | Promise<void>;
  implementFresh(
    ctx: ExtensionContext,
    isCurrent: () => boolean,
    runtime: ImplementationRuntimeSelection | undefined,
    timing: FreshImplementationTiming,
  ): void | Promise<void>;
  /** Plan the same task with other models and compare against the ready plan. */
  compare?(ctx: ExtensionContext): void | Promise<void>;
  /** Plan the current conversation with several models before any plan is ready. */
  planWithModels?(ctx: ExtensionContext): void | Promise<void>;
  exportPlan(ctx: ExtensionContext, path: string, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean>;
  settings(ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean>;
  save(ctx: ExtensionContext): void;
  stay(ctx: ExtensionContext): void;
  exitReady(ctx: ExtensionContext): void;
  clearSaved(ctx: ExtensionContext): void;
  /** The task and the ready plan(s), shown above the decision menus. */
  planFrame?(ctx: ExtensionContext): PlanFrame | undefined;
}

function sessionModel(ctx: ExtensionContext): ImplementationModelOverride | undefined {
  return ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined;
}

export function createPlanActionController(options: PlanActionControllerOptions) {
  const implementationDefaults = (ctx: ExtensionContext): ImplementationMenuDefaults => {
    const state = options.getState();
    const settings = options.getSettings();
    const current = sessionModel(ctx);
    const planModel = (state.enabled ? state.latestPlanModel : state.savedPlan?.model) ?? current;
    return {
      ...(planModel ? { planModel } : {}),
      planThinkingLevel: options.getThinkingLevel(),
      resolved: resolveImplementationDefaults({
        planModel,
        sessionModel: current,
        modelMap: configuredImplementationModelMap(settings),
        defaultModel: configuredImplementationModel(settings),
        defaultThinkingLevel: configuredImplementationThinkingLevel(settings),
        defaultContext: configuredImplementationContext(settings),
        available: snapshotAvailableImplementationModels(ctx),
      }),
    };
  };

  /** The choice the implementation screen preselects, used when no menu is shown. */
  const defaultChoice = (ctx: ExtensionContext): ImplementationChoice => {
    const defaults = implementationDefaults(ctx);
    const { resolved } = defaults;
    for (const model of resolved.unavailable) {
      ctx.ui.notify(
        `Configured implementation model ${model.provider}/${model.modelId} is unavailable; skipped.`,
        "warning",
      );
    }
    const model = resolved.model ?? (resolved.context === "clear" ? sessionModel(ctx) : undefined);
    const thinkingLevel =
      resolved.thinkingLevel ?? (resolved.context === "clear" ? defaults.planThinkingLevel : undefined);
    return {
      runtime: {
        ...(model ? { model: { ...model } } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
      context: resolved.context,
    };
  };

  const implementAction =
    (ctx: ExtensionContext, lifecycle: MenuLifecycle, timing: FreshImplementationTiming) =>
    (choice: ImplementationChoice, signal: AbortSignal) => {
      if (choice.context === "keep") return options.implementHere(ctx, choice.runtime);
      if (signal.aborted) return;
      const isCurrent =
        timing === "after-settled" ? lifecycle.isCurrent : () => lifecycle.isCurrent() && !signal.aborted;
      return options.implementFresh(ctx, isCurrent, choice.runtime, timing);
    };

  return {
    implementationDefaults,
    defaultChoice,
    async showSaved(ctx: ExtensionContext) {
      const lifecycle = options.captureLifecycle();
      if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
      const ui = await options.loadInteractiveUi();
      if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
      await ui.showSavedPlanMenu(ctx, {
        statusText: options.statusText(),
        implementation: implementationDefaults(ctx),
        implementationOutcome: options.implementationOutcome,
        getExportDestination: () => options.getExportDestination(ctx),
        signal: lifecycle.signal,
        isCurrent: lifecycle.isCurrent,
        show: () => options.show(ctx),
        implement: implementAction(ctx, lifecycle, "immediate"),
        exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
        settings: (signal) => options.settings(ctx, signal, lifecycle.isCurrent),
        clear: () => options.clearSaved(ctx),
      });
    },
    async showCurrent(ctx: ExtensionContext) {
      if (!ctx.hasUI) {
        ctx.ui.notify(options.statusText(), "info");
        return;
      }
      const lifecycle = options.captureLifecycle();
      if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
      const ui = await options.loadInteractiveUi();
      if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
      // Multi-model flows open their own UI, so they run after this menu closes.
      let followUp: ((ctx: ExtensionContext) => void | Promise<void>) | undefined;
      const compare = options.compare;
      const planWithModels = options.planWithModels;
      const hasReadyPlan = options.getState().latestPlan !== undefined;
      const frame = hasReadyPlan ? options.planFrame?.(ctx) : undefined;
      await ui.showPlanModeMenu(ctx, {
        statusText: options.statusText(),
        implementation: implementationDefaults(ctx),
        hasReadyPlan,
        ...(frame ? { frame } : {}),
        implementationOutcome: options.implementationOutcome,
        getExportDestination: () => options.getExportDestination(ctx),
        ...lifecycle,
        show: () => options.show(ctx),
        finalize: () => options.finalize(ctx),
        implement: implementAction(ctx, lifecycle, "immediate"),
        ...(compare
          ? {
              compare: () => {
                followUp = compare;
              },
            }
          : {}),
        ...(planWithModels
          ? {
              planWithModels: () => {
                followUp = planWithModels;
              },
            }
          : {}),
        exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
        save: () => options.save(ctx),
        stay: () => options.stay(ctx),
        exit: () => options.exitReady(ctx),
      });
      if (followUp && lifecycle.isCurrent()) await followUp(ctx);
    },
    async showReady(ctx: ExtensionContext, show: { initialScreen?: "implement" } = {}) {
      const lifecycle = options.captureLifecycle();
      if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
      const ui = await options.loadInteractiveUi();
      if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
      let compareRequested = false;
      const compare = options.compare;
      const frame = options.planFrame?.(ctx);
      await ui.showReadyPlanMenu(ctx, {
        ...lifecycle,
        ...(frame ? { frame } : {}),
        ...(show.initialScreen ? { initialScreen: show.initialScreen } : {}),
        implementation: implementationDefaults(ctx),
        implementationOutcome: options.implementationOutcome,
        getExportDestination: () => options.getExportDestination(ctx),
        implement: implementAction(ctx, lifecycle, "after-settled"),
        ...(compare
          ? {
              compare: () => {
                compareRequested = true;
              },
            }
          : {}),
        exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
        save: () => options.save(ctx),
        stay: () => undefined,
        exit: () => options.exitReady(ctx),
      });
      if (compareRequested && compare && lifecycle.isCurrent()) await compare(ctx);
    },
  };
}
