// Your main conversation during a planning run, and M, the pane that shows it on the planning
// screen. Each plan (and each revision) lands in your main conversation in full as a message; your
// main agent can question a planner or record the merged plan with two tools that are active only
// while a run is; and the M pane is your main agent itself: what you type there goes to it, and the
// pane shows its replies as they stream.
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import type { ModelSpec } from "./implementation-models.js";
import type { PlannerAgent, PlannerStats, PlannerStatus } from "./planner/agent.js";
import { consultMessage, MAIN_AGENT_GUIDELINES } from "./planner/prompt.js";
import { describeToolArgs, PlannerTrace } from "./planner-trace.js";
import { SubagentTracker } from "./subagent-progress.js";

export const PLAN_MESSAGE_TYPE = "plan-mode-plan";
export const ASK_PLANNER_TOOL = "plan_ask_planner";
export const SUBMIT_MERGED_TOOL = "plan_submit_merged";
export const MAIN_TOOLS = [ASK_PLANNER_TOOL, SUBMIT_MERGED_TOOL] as const;
const MAX_PLAN_CHARS = 50_000;

/** What a pushed message carries besides its text, for the renderer. */
export interface PlanMessageDetails {
  kind: "plan" | "failure";
  id: string;
  model: string;
  revision?: number;
  lines?: number;
}

/** The merged plan your main agent recorded: plan M. */
export interface MergedPlan {
  plan: string;
  revision: number;
  /** The model that wrote it, e.g. `Claude Opus 5.5`. */
  name: string;
}

export interface MainChatBridge {
  /** The active run's planners; undefined when there is no run. */
  planners(): readonly PlannerAgent[] | undefined;
  /** Record (or replace) plan M. */
  submitMerged(plan: string, ctx: ExtensionContext): MergedPlan | undefined;
}

export function registerMainChat(pi: ExtensionAPI, bridge: MainChatBridge) {
  pi.registerMessageRenderer<PlanMessageDetails>(PLAN_MESSAGE_TYPE, (message, options, theme) =>
    renderPlanMessage(message, options.expanded, theme),
  );

  pi.registerTool({
    name: ASK_PLANNER_TOOL,
    label: "Ask planner",
    description:
      "Ask one of the planners working on the current /plan run a question about its plan or what it found, and wait for its answer. The planner keeps its full research context. If the answer changes its plan, it resubmits it and the new version arrives in this conversation.",
    promptSnippet: "Ask a /plan planner (A or B) about its plan or research",
    promptGuidelines: MAIN_AGENT_GUIDELINES,
    defaultActive: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["planner", "message"],
      properties: {
        planner: { type: "string", description: "The planner's id: A or B." },
        message: { type: "string", minLength: 1, description: "What to ask or tell it." },
      },
    } as never,
    async execute(_id, params: unknown, signal, _onUpdate, ctx) {
      const input = params as { planner?: unknown; message?: unknown };
      const id = String(input.planner ?? "")
        .trim()
        .toUpperCase();
      const message = typeof input.message === "string" ? input.message.trim() : "";
      const planners = bridge.planners();
      if (!planners) return text("No /plan run is active.");
      const planner = planners.find((candidate) => candidate.id === id);
      if (!planner) return text(`There is no planner ${id || "(none)"}; this run has ${ids(planners)}.`);
      if (!message) return text("Say what to ask the planner.");
      if (planner.status === "asking") {
        return text(`Planner ${id} is waiting for the user to answer its questions in /plan; ask again after that.`);
      }
      if (planner.working) {
        return text(
          `Planner ${id} is still working (${planner.stats.lastActivity ?? "working"}); its plan will arrive in this conversation when it is ready. Ask again then.`,
        );
      }
      const result = await planner.consult(consultMessage(message), ctx, "main agent", signal ?? undefined, message);
      if (signal?.aborted) return text(`Stopped waiting; planner ${id} may still answer in its lane.`);
      if (result.error) return text(`Planner ${id} failed: ${result.error}`);
      const reply = result.reply.trim() || "(it answered with no text)";
      return text(
        `Planner ${id} answered:\n\n${reply}${result.revised ? `\n\n(It resubmitted its plan as v${planner.revision}; the new version arrives in this conversation.)` : ""}`,
      );
    },
  });

  pi.registerTool({
    name: SUBMIT_MERGED_TOOL,
    label: "Submit merged plan",
    description:
      "Record the merged (or adjusted) plan for the current /plan run as plan M, which the user can implement or export from /plan. Call it only when the user asks for it, with the complete plan as Markdown; calling it again replaces the plan with a new version.",
    promptSnippet: "Record the merged plan for the current /plan run (only when the user asks)",
    promptGuidelines: MAIN_AGENT_GUIDELINES,
    defaultActive: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["plan"],
      properties: {
        plan: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PLAN_CHARS,
          description: "The complete merged implementation plan in Markdown.",
        },
      },
    } as never,
    async execute(_id, params: unknown, _signal, _onUpdate, ctx) {
      const plan =
        typeof (params as { plan?: unknown }).plan === "string" ? (params as { plan: string }).plan.trim() : "";
      if (!plan) return text("The plan is empty.");
      const merged = bridge.submitMerged(plan, ctx);
      if (!merged) return text("No /plan run is active, so there is nothing to record the plan in.");
      return text(
        `Recorded as plan M${merged.revision > 1 ? ` v${merged.revision}` : ""}. The user can implement or export it from /plan, or ask you to implement it here.`,
      );
    },
  });
}

/** Turn the main agent's run tools on while a run is active, and off again after. */
export function setMainToolsActive(pi: ExtensionAPI, active: boolean) {
  let current: string[];
  try {
    current = pi.getActiveTools();
  } catch {
    return;
  }
  const others = current.filter((name) => !(MAIN_TOOLS as readonly string[]).includes(name));
  const next = active ? [...others, ...MAIN_TOOLS] : others;
  if (next.length === current.length && next.every((name) => current.includes(name))) return;
  try {
    pi.setActiveTools(next);
  } catch {
    // A session without tool control keeps what it has.
  }
}

/** How many of your conversation's latest messages the M pane starts with. */
const SEEDED_MESSAGES = 12;

/**
 * Your main agent, as the M pane shows it: the same fields a planner's lane reads, fed by your main
 * session's events. Its plan is plan M, the merged plan it recorded.
 */
export class MainAgentView {
  readonly id = "M";
  readonly trace = new PlannerTrace();
  readonly subagents = new SubagentTracker("M");
  readonly pending = undefined;
  status: PlannerStatus = "idle";
  stats: PlannerStats = { startedAt: Date.now(), toolCalls: 0, subagentTasks: 0, totalTokens: 0, costUsd: 0 };
  error: string | undefined;

  constructor(
    private readonly source: {
      /** Your session's model, e.g. `GPT-6 Astra`, and its spec with the current effort. */
      model(): { name: string; spec: ModelSpec };
      merged(): MergedPlan | undefined;
      onChange(): void;
    },
  ) {
    this.stats.endedAt = this.stats.startedAt;
  }

  get name() {
    return this.source.model().name;
  }

  get spec() {
    return this.source.model().spec;
  }

  get plan() {
    return this.source.merged()?.plan;
  }

  get revision() {
    return this.source.merged()?.revision ?? 0;
  }

  get working() {
    return this.status === "working";
  }

  /** Your main agent asks you its questions in your main conversation, not here. */
  answer() {}

  /** Start over with the latest messages of a session (a new or resumed one). */
  reset(entries: readonly unknown[]) {
    this.trace.entries.length = 0;
    this.status = "idle";
    this.error = undefined;
    this.stats = { startedAt: Date.now(), toolCalls: 0, subagentTasks: 0, totalTokens: 0, costUsd: 0 };
    this.stats.endedAt = this.stats.startedAt;
    const messages = entries
      .flatMap((entry) => {
        const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
        return (entry as { type?: string }).type === "message" && message ? [message] : [];
      })
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-SEEDED_MESSAGES);
    for (const message of messages) {
      const text = contentText(message.content).trim();
      if (!text) continue;
      if (message.role === "user") this.trace.user(text);
      else this.trace.text(text);
    }
    this.source.onChange();
  }

  /** One of your main session's events. */
  apply(event: Record<string, unknown>) {
    switch (event.type) {
      case "agent_start":
        this.status = "working";
        this.error = undefined;
        this.stats = { ...this.stats, startedAt: Date.now(), endedAt: undefined, lastActivity: "thinking" };
        break;
      case "agent_end":
        this.status = "idle";
        this.stats.endedAt = Date.now();
        this.stats.lastActivity = "waiting for you";
        break;
      case "tool_execution_start":
        this.stats.toolCalls += 1;
        this.stats.lastActivity = describeToolArgs(String(event.toolName ?? "tool"), event.args);
        break;
      case "message_update": {
        const update = event.assistantMessageEvent as { type?: string } | undefined;
        if (update?.type === "text_delta") this.stats.lastActivity = "writing";
        else if (update?.type === "thinking_delta") this.stats.lastActivity = "thinking";
        break;
      }
      case "message_end": {
        const message = event.message as { role?: string; content?: unknown; usage?: unknown } | undefined;
        if (message?.role === "user") {
          const text = contentText(message.content).trim();
          if (text) this.trace.user(text);
        } else if (message?.role === "assistant") {
          const usage = message.usage as { totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
          if (typeof usage?.totalTokens === "number") this.stats.totalTokens += usage.totalTokens;
          if (typeof usage?.cost?.total === "number") this.stats.costUsd += usage.cost.total;
        }
        break;
      }
      default:
        break;
    }
    this.trace.apply(event);
    this.source.onChange();
  }
}

function renderPlanMessage(
  message: { content: unknown; details?: PlanMessageDetails },
  expanded: boolean,
  theme: Theme,
) {
  const details = message.details;
  const body = contentText(message.content);
  if (details?.kind === "failure") return new Text(theme.fg("error", `✗ ${body}`), 0, 0);
  const version = details?.revision && details.revision > 1 ? ` v${details.revision}` : "";
  const head = theme.fg(
    "accent",
    theme.bold(`▸ Plan ${details?.id ?? "?"}${version} from planner ${details?.id ?? "?"} · ${details?.model ?? ""}`),
  );
  if (!expanded) {
    const size = details?.lines ? `${details.lines} lines` : "";
    return new Text(`${head}  ${theme.fg("dim", `${size}${size ? " · " : ""}ctrl+o to expand`)}`, 0, 0);
  }
  return {
    render: (width: number) => [head, ...new Markdown(body, 0, 0, getMarkdownTheme()).render(width)],
    invalidate() {},
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}

function ids(planners: readonly PlannerAgent[]) {
  return planners.map((planner) => planner.id).join(" and ");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
