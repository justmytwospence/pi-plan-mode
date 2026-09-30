import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu } from "@narumitw/pi-tui-kit";
import { runMenuWithVimKeys } from "./menu-keys.js";
import {
  createImplementationFlow,
  type ImplementAction,
  type ImplementationMenuDefaults,
} from "./plan-action-menus.js";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface SavedPlanMenuOptions {
  statusText: string;
  implementation: ImplementationMenuDefaults;
  implementationOutcome(): string;
  getExportDestination: PlanExportDestinationProvider;
  signal: AbortSignal;
  isCurrent(): boolean;
  show(): void;
  implement: ImplementAction;
  exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
  settings(signal: AbortSignal): Promise<boolean>;
  clear(): void;
}

export async function showSavedPlanMenu(ctx: ExtensionContext, options: SavedPlanMenuOptions) {
  if (!ctx.hasUI) {
    throw new Error(`${options.statusText} Use /plan show, /plan implement, /plan export, or /plan exit.`);
  }
  type Screen = "saved" | "implement" | "models" | "thinking" | "context" | "export";
  type Action =
    | "show"
    | "start-implementation"
    | "select-model"
    | "select-thinking"
    | "select-context"
    | "export"
    | "settings"
    | "clear";
  const flow = createImplementationFlow(ctx, options.implementation, options.implement);
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "saved",
    screens: {
      saved: () => ({
        kind: "actions",
        title: "Saved plan",
        lines: [options.statusText, flow.summaryLine(), options.implementationOutcome()],
        items: [
          { id: "show", label: "Show saved plan", action: "show" },
          {
            id: "implement",
            label: "Implement…",
            description: "Choose the model, effort, and context, then start.",
            to: "implement",
          },
          { id: "export", label: "Export plan…", to: "export" },
          { id: "settings", label: "Settings…", action: "settings" },
          { id: "clear", label: "Clear saved plan", action: "clear" },
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
      ...flow.actions,
      export: async ({ value, signal }) =>
        (await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
      settings: async ({ signal }) => {
        const close = await options.settings(signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        return close ? { kind: "close" } : { kind: "stay" };
      },
      clear: async () => {
        options.clear();
        return { kind: "close" };
      },
    },
  });
  await runMenuWithVimKeys(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
}
