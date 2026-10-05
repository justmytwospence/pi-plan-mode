import { describeGrants, type ResolvedGrant } from "../command-grants.js";
import { MCP_GATEWAY_TOOL } from "../mcp-tools.js";
import { describedTools, mcpToolsNote, type PlanCandidate } from "../planners.js";
import { buildPlanModePrompt } from "../prompt.js";

/** The planner's role, appended to its system prompt. */
export function plannerSystemPrompt() {
  return [
    buildPlanModePrompt(),
    "",
    "## Planning screen",
    "",
    "You are a planner in a dedicated planning session. The conversation above it is the user's own session, copied here so you start with their context; you cannot change their files or their session. The user watches your work live and can talk to you at any time: their messages arrive as ordinary user messages, sometimes while you are working.",
    "Ask with plan_mode_question when a product decision, preference, or tradeoff needs the user (they answer on the planning screen). Submit with plan_mode_complete; resubmit the complete revised plan whenever the plan changes.",
  ].join("\n");
}

export interface PlannerTaskInput {
  task: string;
  /** How many planners work on this task (1 or 2). */
  planners: number;
  scoutLabel?: string;
  tools: readonly string[];
  mcpAllow?: readonly string[];
  grants: readonly ResolvedGrant[];
}

/** The first message a planner gets: the task, and what it may use. */
export function plannerTaskPrompt(input: PlannerTaskInput) {
  const research = describedTools(input.tools);
  return [
    ...(input.planners > 1
      ? [
          "Another model is planning the same task in parallel without seeing your work; the user will compare the plans, combine them, or pick one.",
        ]
      : []),
    ...(research.length > 0
      ? [
          `Research beyond the repository whenever outside knowledge matters (library and API docs, versions, known issues, prior art) with ${research.join(", ")}.`,
        ]
      : []),
    ...(input.tools.includes(MCP_GATEWAY_TOOL) && input.mcpAllow
      ? [mcpToolsNote(input.mcpAllow, "you may call only these MCP tools")]
      : []),
    ...(input.grants.length > 0
      ? [
          `Besides read-only commands, bash may run these granted commands (one command per call; a quoted heredoc may feed it input): ${describeGrants(input.grants)}. Use them to inspect, not to change anything; any skill that explains them is loaded.`,
        ]
      : []),
    ...(input.scoutLabel
      ? [
          `For broad or independent investigations, delegate to read-only subagents with plan_subagents (they run on ${input.scoutLabel}; give each a self-contained task and run independent ones in one call). Verify anything decisive yourself, and write the plan yourself.`,
        ]
      : []),
    "",
    "## Task",
    "",
    input.task.trim() || "Plan the task discussed in the conversation so far.",
  ].join("\n");
}

/** Ask a planner to merge its plan with the other planner's. */
export function synthesisPrompt(own: PlanCandidate, other: PlanCandidate) {
  return [
    `The user wants one plan. Below is the plan another model (${other.label}) wrote for the same task in parallel. Merge it with your own plan ${own.id}: keep the strongest base, graft in the better ideas from the other, and check claims where the two disagree against the repository. Resolve every disagreement explicitly, using plan_mode_question when one needs the user's decision.`,
    "Then call plan_mode_complete with the complete merged plan (not a diff).",
    "",
    `<other-plan id="${other.id}">`,
    other.plan?.trim() ?? "",
    "</other-plan>",
  ].join("\n");
}
