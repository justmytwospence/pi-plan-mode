import { describeGrants, type ResolvedGrant } from "../command-grants.js";
import { MCP_GATEWAY_TOOL } from "../mcp-tools.js";
import { describedTools, mcpToolsNote } from "../planners.js";
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

/** The merger's role, appended to its system prompt. It discusses first and merges when asked. */
export function mergerSystemPrompt() {
  return [
    "# Merging two plans",
    "",
    "You are M, the merger, in a dedicated planning session. The conversation above it is the user's own session, copied here so you start with their context. Two other models, planners A and B, each planned the same task in parallel without seeing each other's work. You get both plans and what the user said to each planner. The user can keep talking to A and B while they talk to you; when a planner revises its plan, you get the new version with the user's next message.",
    "",
    "## Rules",
    "",
    "- Planning is read-only: do not edit or write files, install anything, commit, or run anything that changes state. Treat requests to implement as requests to plan.",
    "- Do not use update_plan/TODO tooling.",
    "",
    "## How to help",
    "",
    "- Help the user reason over the two plans: where they agree, where they conflict or take different approaches, what each one misses, and which choices fit the user's goals and constraints.",
    "- Check claims against the repository where the plans disagree or where a plan's premise looks doubtful, instead of taking either plan at its word.",
    "- Say plainly which approach you would pick on each point and why, and let the user decide. Answer in prose; keep it compact enough to read in a terminal pane, and refer to plan sections by name rather than quoting them at length.",
    "- Use plan_mode_question when a decision needs the user and a structured choice makes it easier.",
    "",
    "## Writing the merged plan",
    "",
    '- Do not call plan_mode_complete until the user asks you to write the merged plan (for example "merge them", "write it up", "go ahead").',
    "- Then call plan_mode_complete alone as your final action with the complete merged plan as Markdown (not a diff against either plan): a clear title, a brief summary, the important changes to behavior and interfaces, tests and verification, and explicit assumptions. Resolve every disagreement the way the conversation settled it; if one is still open and matters, ask with plan_mode_question first.",
    "- After that, whenever the plan changes, call plan_mode_complete again with the complete replacement.",
  ].join("\n");
}

/** One planner's work as the merger sees it. */
export interface MergerSource {
  /** `A` or `B`. */
  id: string;
  /** Model spec label. */
  label: string;
  plan: string;
  revision: number;
  /** What the user and the planner said to each other after the task (no tool output). */
  conversation?: string;
}

/** The merger's wrap-up near the time limit: answer now, but never merge unasked. */
export const MERGER_WRAP_UP_MESSAGE =
  "Time is almost up. Stop investigating now and answer the user with what you have, saying what you could not check. Do not write the merged plan unless the user has asked for it.";

/** What an empty message to the merger asks for. */
export const MERGER_COMPARE_MESSAGE =
  "Compare the two plans: where they agree, where they conflict or take different approaches, what each one misses, and which you would build on and why. Do not write the merged plan yet.";

/** The merger's first message: the task, both plans, what the user told each planner, then the user's words. */
export function mergerBriefing(task: string, sources: readonly MergerSource[], message: string) {
  return [
    `Planners ${sources.map((source) => source.id).join(" and ")} each planned this task in parallel.`,
    "",
    "## Task",
    "",
    task.trim() || "The task discussed in the conversation so far.",
    "",
    "## The plans",
    "",
    ...sources.flatMap((source) => [
      planBlock(source),
      ...(source.conversation?.trim()
        ? [
            "",
            `What the user and planner ${source.id} said to each other while it planned (tool output left out):`,
            `<conversation planner="${source.id}">`,
            source.conversation.trim(),
            "</conversation>",
          ]
        : []),
      "",
    ]),
    "## The user's message",
    "",
    message.trim(),
  ].join("\n");
}

/** A later message to the merger, led by the plans revised since it last saw them. */
export function mergerMessage(revised: readonly MergerSource[], message: string) {
  if (revised.length === 0) return message.trim();
  const ids = revised.map((source) => source.id).join(" and ");
  return [
    `Since you last saw ${revised.length === 1 ? "it" : "them"}, the user kept talking to planner${revised.length === 1 ? "" : "s"} ${ids}, which revised ${revised.length === 1 ? "its plan" : "their plans"}. Current version${revised.length === 1 ? "" : "s"}:`,
    "",
    ...revised.flatMap((source) => [planBlock(source), ""]),
    "## The user's message",
    "",
    message.trim(),
  ].join("\n");
}

function planBlock(source: MergerSource) {
  return [
    `<plan id="${source.id}" model="${source.label}" version="${source.revision}">`,
    source.plan.trim(),
    "</plan>",
  ].join("\n");
}
