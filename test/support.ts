import { createMockPi as createBaseMockPi } from "./shared/support.js";

export {
  builtinTool,
  createCustomSelectorHarness,
  createMockContext,
  driveCustomSelector,
  extensionTool,
} from "./shared/support.js";

const PLAN_HELPERS = ["plan_mode_question", "plan_mode_complete"];

export function createMockPi(options: Parameters<typeof createBaseMockPi>[0] = {}) {
  return createBaseMockPi({
    ...options,
    activeTools: [...new Set([...(options.activeTools ?? []), ...PLAN_HELPERS])],
  });
}

const FRESH_START = "Start implementation in a fresh session";
const HERE_START = "Start implementation here";

/** Walk the ready/saved menus to a fresh-session implementation in RPC select mocks. */
export function selectFreshImplementation(options: readonly string[]): string | undefined {
  if (options.includes("Implement…")) return "Implement…";
  if (options.includes(FRESH_START)) return FRESH_START;
  if (options.includes(HERE_START)) return "Context";
  return options.find((option) => option.startsWith("Clear context"));
}

/** Walk the ready/saved menus to an in-session implementation in RPC select mocks. */
export function selectImplementHere(options: readonly string[]): string | undefined {
  if (options.includes("Implement…")) return "Implement…";
  if (options.includes(HERE_START)) return HERE_START;
  if (options.includes(FRESH_START)) return "Context";
  return options.find((option) => option.startsWith("Keep planning conversation"));
}
