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
