import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import plan, { type PlanDependencies } from "./plan.js";
import { mcpAllowFromEnv } from "./planners.js";
import { installScoutGuard } from "./scout-guard.js";

export default function planMode(pi: ExtensionAPI, dependencies: PlanDependencies = {}) {
  // Scouts load this package only to enforce their MCP allowlist.
  const scoutAllow = mcpAllowFromEnv();
  if (scoutAllow) {
    installScoutGuard(pi, scoutAllow);
    return;
  }
  plan(pi, dependencies);
}
