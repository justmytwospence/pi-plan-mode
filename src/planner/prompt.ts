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

/**
 * Sent when a run is restored (after `/reload`, a restart, or resuming the session) to a planner
 * whose turn was cut off, or had failed, so it carries on without you typing "continue".
 */
export function resumeMessage(reason: "interrupted" | "failed") {
  const why =
    reason === "interrupted"
      ? "Your previous turn was cut off because the user's pi session restarted (a reload or a restart); whatever the interrupted step was doing did not reach you."
      : "Your previous turn failed with an error (often a provider or credentials problem, which may be fixed now).";
  return `${why} Carry on from where you left off. If your plan was already complete, resubmit it with plan_mode_complete.`;
}

// --- Your main conversation --------------------------------------------------------------------
// Your main session is where you talk the plans over: each plan (and each revision) lands there in
// full, and your main agent can question a planner or record a merged plan with two tools.

/** One planner's new plan, as it lands in your main conversation. */
export interface PlanDelivery {
  id: string;
  /** e.g. `Claude Fable 5.1 xhigh` */
  model: string;
  revision: number;
  plan: string;
  task: string;
  /** What the user and the planner said since its previous delivery (no tool output). */
  conversation?: string;
  /** One line per other planner, e.g. "Planner B is still planning." */
  others: string[];
}

export function planDeliveryText(delivery: PlanDelivery) {
  const version = delivery.revision > 1 ? ` v${delivery.revision}` : "";
  const task = delivery.task.trim().split("\n")[0] || "the task discussed above";
  return [
    `Planner ${delivery.id} (${delivery.model}) submitted plan ${delivery.id}${version} for: ${task}`,
    ...(delivery.conversation?.trim()
      ? [
          "",
          `What the user and planner ${delivery.id} said since ${delivery.revision > 1 ? "its previous version" : "it started"} (tool output left out):`,
          `<conversation planner="${delivery.id}">`,
          delivery.conversation.trim(),
          "</conversation>",
        ]
      : []),
    "",
    `<plan id="${delivery.id}" version="${delivery.revision}">`,
    delivery.plan.trim(),
    "</plan>",
    ...(delivery.others.length ? ["", ...delivery.others] : []),
  ].join("\n");
}

/** A planner failed: your main agent hears it too, so it does not wait for that plan. */
export function planFailureText(id: string, model: string, error: string) {
  return `Planner ${id} (${model}) failed: ${error}. The user can retry it from /plan (talk to it, or reload once the cause is fixed).`;
}

/** How a question from your main agent reaches a planner. */
export function consultMessage(message: string) {
  return `[From the user's main agent, which is talking the plans over with the user. Answer it directly; resubmit your plan with plan_mode_complete only if your answer changes it.]\n\n${message.trim()}`;
}

/** What Write plan M (or Revise plan M, once there is one) asks your main agent to do. */
export function writeMergedRequest(revise: boolean) {
  return revise
    ? "Revise plan M: fold in what we have discussed since you recorded it, and record the complete revised plan with plan_submit_merged."
    : "Write plan M: merge the planners' plans and what we have decided here into one complete implementation plan. Where they disagree, pick one approach and say why. Record it with plan_submit_merged.";
}

/** Guidance for your main agent while a planning run is active (its tools' guidelines). */
export const MAIN_AGENT_GUIDELINES = [
  "Planners (A, and B when two are planning) are writing implementation plans in the background, read-only. Each plan and each revision arrives in this conversation as a message with the plan in full; the user may also talk to the planners directly in /plan.",
  "While planning is underway, do not edit files or run anything that changes state unless the user explicitly asks; talk the plans over with the user instead.",
  "To find out more about a plan or what a planner learned, ask it with plan_ask_planner rather than re-investigating from scratch.",
  "Call plan_submit_merged only when the user asks for the merged (or adjusted) plan, with the complete plan as Markdown, not a diff. It becomes plan M, which the user implements or exports from /plan, or asks you to implement here.",
];
