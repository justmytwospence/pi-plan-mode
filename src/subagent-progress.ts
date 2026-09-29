/**
 * Subagent (scout) activity travels from a planner subprocess to the main session inside the
 * plan_subagents tool's partial results (RPC `tool_execution_update`), batched, and is rebuilt
 * there into one trace and stats per subagent.
 */
import { describeToolArgs, PlannerTrace } from "./planner-trace.js";

export const SUBAGENT_PROGRESS_KIND = "plan-subagents-progress";
const FLUSH_MS = 200;
const MAX_RESULT_TEXT = 600;

export type AgentState = "starting" | "running" | "done" | "failed" | "cancelled" | "timeout";

/** Stats shown for any agent, planner or subagent. */
export interface AgentStats {
  state: AgentState;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  subagentTasks: number;
  totalTokens: number;
  costUsd: number;
  lastActivity?: string;
  wrappingUp?: boolean;
}

export interface SubagentMeta {
  index: number;
  label: string;
  model: string;
  task: string;
  state: AgentState;
  startedAt: number;
  endedAt?: number;
}

export interface SubagentProgressDetails {
  kind: typeof SUBAGENT_PROGRESS_KIND;
  version: 1;
  scouts: SubagentMeta[];
  events: Array<{ scout: number; record: Record<string, unknown> }>;
}

/** Keep only what traces and stats use, so progress updates stay small. */
export function compactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (record.type) {
    case "message_update": {
      const update = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
      if (!update) return undefined;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        return { type: "message_update", assistantMessageEvent: { type: update.type, delta: update.delta } };
      }
      if (update.type === "text_end" || update.type === "thinking_end") {
        return { type: "message_update", assistantMessageEvent: { type: update.type } };
      }
      return undefined;
    }
    case "message_end": {
      const message = isRecord(record.message) ? record.message : undefined;
      if (message?.role !== "assistant") return undefined;
      return {
        type: "message_end",
        message: {
          role: "assistant",
          usage: message.usage,
          stopReason: message.stopReason,
          ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
        },
      };
    }
    case "tool_execution_start":
      return { type: record.type, toolCallId: record.toolCallId, toolName: record.toolName, args: record.args };
    case "tool_execution_end": {
      const result = isRecord(record.result) ? record.result : undefined;
      const text = Array.isArray(result?.content)
        ? result.content
            .flatMap((block) =>
              isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
            )
            .join("\n")
        : "";
      return {
        type: record.type,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        isError: record.isError,
        result: { content: [{ type: "text", text: text.slice(0, MAX_RESULT_TEXT) }] },
      };
    }
    case "auto_retry_start":
    case "compaction_start":
      return record;
    default:
      return undefined;
  }
}

/** Planner side: batch scout records and send them through the tool's `onUpdate`. */
export function createSubagentReporter(
  scouts: SubagentMeta[],
  send: (details: SubagentProgressDetails, summary: string) => void,
) {
  let events: SubagentProgressDetails["events"] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const done = scouts.filter((scout) => scout.state !== "running" && scout.state !== "starting").length;
    const batch = events;
    events = [];
    try {
      send(
        { kind: SUBAGENT_PROGRESS_KIND, version: 1, scouts: scouts.map((scout) => ({ ...scout })), events: batch },
        `${done}/${scouts.length} subagents finished`,
      );
    } catch {
      // Progress is best effort.
    }
  };
  const schedule = () => {
    if (!timer) {
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref?.();
    }
  };
  return {
    record(scout: number, record: Record<string, unknown>) {
      const compact = compactRecord(record);
      if (!compact) return;
      events.push({ scout, record: compact });
      schedule();
    },
    update() {
      schedule();
    },
    /** Send everything now (scout start and finish, and the end of the tool call). */
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}

/** Main-session view of one subagent. */
export interface SubagentView {
  id: string;
  label: string;
  model: string;
  task: string;
  trace: PlannerTrace;
  stats: AgentStats;
}

/** Main side: rebuild subagent traces and stats from a planner's progress updates. */
export class SubagentTracker {
  readonly agents: SubagentView[] = [];
  private readonly byKey = new Map<string, SubagentView>();

  constructor(private readonly plannerId: string) {}

  /** Apply one `tool_execution_update` partial result; returns true when anything changed. */
  apply(toolCallId: string, details: unknown): boolean {
    if (!isProgressDetails(details)) return false;
    for (const scout of details.scouts) {
      const view = this.view(toolCallId, scout);
      view.label = scout.label;
      view.model = scout.model;
      view.task = scout.task;
      view.stats.state = scout.state;
      view.stats.startedAt = scout.startedAt;
      if (scout.endedAt !== undefined) view.stats.endedAt = scout.endedAt;
    }
    for (const { scout, record } of details.events) {
      const meta = details.scouts.find((candidate) => candidate.index === scout);
      if (!meta) continue;
      const view = this.view(toolCallId, meta);
      view.trace.apply(record);
      applyStats(view.stats, record);
    }
    return details.scouts.length > 0 || details.events.length > 0;
  }

  /** The plan_subagents call ended: anything still running there is over. */
  finish(toolCallId: string, cancelled: boolean) {
    for (const [key, view] of this.byKey) {
      if (!key.startsWith(`${toolCallId}:`)) continue;
      if (view.stats.state === "running" || view.stats.state === "starting") {
        view.stats.state = cancelled ? "cancelled" : "failed";
        view.stats.endedAt = Date.now();
      }
    }
  }

  private view(toolCallId: string, scout: SubagentMeta): SubagentView {
    const key = `${toolCallId}:${scout.index}`;
    let view = this.byKey.get(key);
    if (!view) {
      view = {
        id: `${this.plannerId}${this.agents.length + 1}`,
        label: scout.label,
        model: scout.model,
        task: scout.task,
        trace: new PlannerTrace(),
        stats: {
          state: scout.state,
          startedAt: scout.startedAt,
          toolCalls: 0,
          subagentTasks: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      };
      this.byKey.set(key, view);
      this.agents.push(view);
    }
    return view;
  }
}

function applyStats(stats: AgentStats, record: Record<string, unknown>) {
  if (record.type === "tool_execution_start") {
    stats.toolCalls += 1;
    stats.lastActivity = describeToolArgs(typeof record.toolName === "string" ? record.toolName : "tool", record.args);
  } else if (record.type === "message_end" && isRecord(record.message) && isRecord(record.message.usage)) {
    const usage = record.message.usage;
    stats.totalTokens += typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
    const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
    stats.costUsd += typeof cost === "number" ? cost : 0;
  } else if (record.type === "message_update") {
    const update = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
    if (update?.type === "thinking_delta") stats.lastActivity = "thinking";
    else if (update?.type === "text_delta") stats.lastActivity = "writing";
  }
}

function isProgressDetails(value: unknown): value is SubagentProgressDetails {
  return (
    isRecord(value) &&
    value.kind === SUBAGENT_PROGRESS_KIND &&
    value.version === 1 &&
    Array.isArray(value.scouts) &&
    Array.isArray(value.events)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
