import type { Theme } from "@earendil-works/pi-coding-agent";
import { rule, titleLine, type WorkflowStep } from "../ui-kit.js";

/** Every page starts the same way: a rule, then the title with the steps at the top right. */
export function pageHeader(theme: Theme, width: number, title: string, context: string, step: WorkflowStep) {
  return [rule(theme, width, "borderAccent"), titleLine(theme, width, title, context, step), rule(theme, width)];
}

/** Full-screen overlay options: the plan app covers the whole terminal. */
export const FULL_SCREEN = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
} as const;
