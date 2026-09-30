import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu } from "@narumitw/pi-tui-kit";
import { runMenuWithVimKeys } from "./menu-keys.js";

interface PlanLaunchMenuOptions {
  statusText: string;
  /** What the Plan policy will allow, read each time the menu is shown. */
  toolSummary(): string;
  signal: AbortSignal;
  isCurrent(): boolean;
  start(signal: AbortSignal): void;
  /** The tools screen; true when it started Plan mode. */
  chooseTools(signal: AbortSignal): Promise<boolean>;
  settings(signal: AbortSignal): Promise<boolean>;
}

export async function showPlanLaunchMenu(ctx: ExtensionContext, options: PlanLaunchMenuOptions) {
  type Screen = "main" | "help";
  type Action = "start" | "choose-tools" | "settings";
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Plan mode",
        lines: [options.statusText, options.toolSummary()],
        items: [
          { id: "start", label: "Start Plan mode", action: "start" },
          { id: "tools", label: "Choose tools, then start…", action: "choose-tools" },
          { id: "settings", label: "Settings…", action: "settings" },
          { id: "help", label: "How Plan mode works", to: "help" },
        ],
        hint: "close",
      }),
      help: () => ({
        kind: "detail",
        title: "How Plan mode works",
        lines: [
          "Plan mode uses read-only exploration to understand the project before implementation.",
          "The agent can ask important decision questions, then returns a complete implementation-ready plan.",
          "File mutation stays blocked until you explicitly choose to implement the completed plan.",
        ],
        hint: "back",
      }),
    },
    actions: {
      start: async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        options.start(signal);
        return { kind: "close" };
      },
      "choose-tools": async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        const started = await options.chooseTools(signal);
        if (signal.aborted || !options.isCurrent()) return started ? { kind: "close" } : { kind: "rejected" };
        return started ? { kind: "close" } : { kind: "stay" };
      },
      settings: async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        const close = await options.settings(signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        return close ? { kind: "close" } : { kind: "stay" };
      },
    },
  });
  await runMenuWithVimKeys(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
}
