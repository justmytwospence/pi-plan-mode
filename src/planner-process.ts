import { type ChildProcess, spawn } from "node:child_process";
import { formatModelSpec, type ModelSpec } from "./implementation-models.js";
import { parseProposedPlan } from "./message-transform.js";
import {
  DEFAULT_PLANNER_ACCESS,
  EXTRA_TOOLS_ENV,
  MCP_ALLOW_ENV,
  PLANNER_ENV,
  type PlanCandidate,
  type PlannerAccess,
  SCOUT_EXTENSIONS_ENV,
  SCOUT_MCP_ALLOW_ENV,
  SCOUT_TOOLS_ENV,
} from "./multi-plan.js";
import { piSpawnCommand } from "./pi-command.js";
import { describeToolArgs, PlannerTrace } from "./planner-trace.js";
import { PLAN_SUBAGENTS_TOOL_NAME, SCOUT_MODEL_ENV } from "./scout-process.js";
import { SubagentTracker, type SubagentView } from "./subagent-progress.js";

export { piSpawnCommand } from "./pi-command.js";

const PLANNER_TOOLS = ["read", "grep", "find", "ls", "plan_mode_question", "plan_mode_complete"];
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 2_000;
const MIN_PROSE_PLAN_CHARS = 200;
/** Fraction of the time limit after which the planner is asked to wrap up. */
export const SOFT_DEADLINE_FRACTION = 0.8;
export const WRAP_UP_MESSAGE =
  "Time is almost up. Stop investigating now and call plan_mode_complete alone with your best complete plan. Record anything you could not verify as explicit assumptions or open questions in the plan.";
export const NUDGE_MESSAGE =
  "You stopped without submitting a plan. Call plan_mode_complete now, alone, with your complete plan based on what you found. Record anything unresolved as explicit assumptions.";

export interface PlannerProgress {
  spec: ModelSpec;
  state: "starting" | "running" | "done" | "failed" | "cancelled" | "timeout";
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  subagentTasks: number;
  lastActivity?: string;
  totalTokens: number;
  costUsd: number;
  /** Set once the planner has been asked to wrap up at the soft deadline. */
  wrappingUp?: boolean;
}

export interface PlannerRunOptions {
  id: string;
  spec: ModelSpec;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** Absolute path of this extension's entry point, loaded into the planner with `-e`. */
  extensionPath: string;
  loadUserExtensions: boolean;
  /** Model for the planner's read-only subagents; enables the plan_subagents tool. */
  scoutSpec?: ModelSpec;
  /** Shell, subagents, and extra extensions and tools for this run (defaults: shell and subagents only). */
  access?: PlannerAccess;
  signal: AbortSignal;
  onProgress(progress: PlannerProgress): void;
  /** Receives the live trace (the same object on every call) whenever it changes. */
  onTrace?(trace: PlannerTrace): void;
  /** Receives the planner's subagents (same objects, growing list) whenever any of them changes. */
  onSubagents?(subagents: readonly SubagentView[]): void;
  /** Test seam: replaces `child_process.spawn`. */
  spawnProcess?: typeof spawn;
  /** Test seam: replaces how the Pi CLI is invoked. */
  piCommand?: { command: string; args: string[] };
}

export function plannerArgs(
  options: Pick<PlannerRunOptions, "spec" | "extensionPath" | "loadUserExtensions" | "scoutSpec" | "access">,
) {
  const access = options.access ?? DEFAULT_PLANNER_ACCESS;
  const tools = [
    "read",
    ...(access.shell ? ["bash"] : []),
    ...PLANNER_TOOLS.slice(1),
    ...access.tools,
    ...(options.scoutSpec && access.subagents ? [PLAN_SUBAGENTS_TOOL_NAME] : []),
  ];
  return [
    "--mode",
    "rpc",
    "--no-session",
    "--model",
    formatModelSpec(options.spec),
    "--tools",
    tools.join(","),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...(options.loadUserExtensions
      ? []
      : [
          "--no-extensions",
          "--extension",
          options.extensionPath,
          ...access.extensions.flatMap((extension) => ["--extension", extension]),
        ]),
  ];
}

export function plannerEnv(options: Pick<PlannerRunOptions, "scoutSpec" | "access">): NodeJS.ProcessEnv {
  const access = options.access ?? DEFAULT_PLANNER_ACCESS;
  return {
    ...process.env,
    [PLANNER_ENV]: "1",
    PI_SKIP_VERSION_CHECK: "1",
    ...(options.scoutSpec && access.subagents ? { [SCOUT_MODEL_ENV]: formatModelSpec(options.scoutSpec) } : {}),
    [EXTRA_TOOLS_ENV]: access.tools.join(","),
    [SCOUT_EXTENSIONS_ENV]: JSON.stringify(access.scoutExtensions),
    [SCOUT_TOOLS_ENV]: access.scoutTools.join(","),
    ...(access.mcpAllow ? { [MCP_ALLOW_ENV]: JSON.stringify(access.mcpAllow) } : {}),
    ...(access.scoutMcpAllow ? { [SCOUT_MCP_ALLOW_ENV]: JSON.stringify(access.scoutMcpAllow) } : {}),
  };
}

/**
 * Run one read-only planner as a `pi --mode rpc` subprocess in Plan mode and collect the plan it
 * submits with plan_mode_complete. RPC keeps a channel open so the planner can be asked to wrap up
 * at the soft deadline and nudged once if it stops without a plan. Never rejects.
 */
export function runPlanner(options: PlannerRunOptions): Promise<PlanCandidate> {
  const startedAt = Date.now();
  const trace = new PlannerTrace();
  const subagents = new SubagentTracker(options.id);
  const progress: PlannerProgress = {
    spec: options.spec,
    state: "starting",
    startedAt,
    toolCalls: 0,
    subagentTasks: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const label = formatModelSpec(options.spec);
  const base: Pick<PlanCandidate, "id" | "label" | "origin" | "model" | "thinkingLevel"> = {
    id: options.id,
    label,
    origin: "planner",
    model: { provider: options.spec.provider, modelId: options.spec.modelId },
    ...(options.spec.thinkingLevel ? { thinkingLevel: options.spec.thinkingLevel } : {}),
  };

  return new Promise((resolve) => {
    let plan: string | undefined;
    let lastAssistantText = "";
    let assistantError: string | undefined;
    let stderrTail = "";
    let stdoutBuffer = "";
    let settled = false;
    let terminalState: "cancelled" | "timeout" | undefined;
    let nudged = false;
    let closing = false;
    let child: ChildProcess;

    const report = () => {
      try {
        options.onProgress({ ...progress });
      } catch {
        // Progress rendering must never break a planner run.
      }
    };
    const reportSubagents = () => {
      try {
        options.onSubagents?.(subagents.agents);
      } catch {
        // Monitoring must never break a planner run.
      }
    };
    const reportTrace = () => {
      try {
        options.onTrace?.(trace);
      } catch {
        // Trace rendering must never break a planner run.
      }
    };
    const send = (record: Record<string, unknown>) => {
      try {
        if (child?.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(record)}\n`);
      } catch {
        // The planner may already be exiting.
      }
    };
    const closeInput = () => {
      if (closing) return;
      closing = true;
      try {
        child?.stdin?.end();
      } catch {
        // Already closed.
      }
      // An orderly RPC shutdown follows stdin closing; make sure the process does exit.
      setTimeout(() => {
        if (!settled) child?.kill("SIGTERM");
      }, KILL_GRACE_MS).unref?.();
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(softDeadline);
      options.signal.removeEventListener("abort", onAbort);
      let status: PlanCandidate["status"];
      let finalPlan = plan;
      let planFromText = false;
      let error: string | undefined;
      if (!finalPlan) {
        const parsed = parseProposedPlan(lastAssistantText);
        if (parsed.kind === "valid") finalPlan = parsed.plan;
        else if (lastAssistantText.trim().length >= MIN_PROSE_PLAN_CHARS && !assistantError) {
          finalPlan = lastAssistantText.trim();
          planFromText = true;
        }
      }
      if (finalPlan) {
        status = "done";
      } else if (terminalState) {
        status = terminalState;
        error =
          terminalState === "timeout" ? `Timed out after ${Math.round(options.timeoutMs / 1000)}s.` : "Cancelled.";
      } else {
        status = "failed";
        error =
          assistantError ??
          (stderrTail.trim()
            ? stderrTail.trim().split("\n").slice(-3).join(" ")
            : `Planner exited with code ${exitCode ?? "unknown"} without submitting a plan.`);
      }
      progress.state = status;
      progress.endedAt = Date.now();
      for (const agent of subagents.agents) {
        if (agent.stats.state === "running" || agent.stats.state === "starting") {
          agent.stats.state = terminalState ?? "failed";
          agent.stats.endedAt = progress.endedAt;
        }
      }
      reportSubagents();
      trace.note(
        status === "done" ? "Plan submitted." : `Stopped: ${error ?? status}`,
        status === "done" ? "info" : "warning",
      );
      report();
      reportTrace();
      resolve({
        ...base,
        status,
        ...(finalPlan ? { plan: finalPlan } : {}),
        ...(planFromText ? { planFromText } : {}),
        ...(error ? { error } : {}),
        durationMs: Date.now() - startedAt,
        toolCalls: progress.toolCalls,
        ...(progress.subagentTasks ? { subagentTasks: progress.subagentTasks } : {}),
        totalTokens: progress.totalTokens,
        costUsd: progress.costUsd,
      });
    };

    const kill = (state: "cancelled" | "timeout") => {
      if (settled || terminalState) return;
      terminalState = state;
      try {
        child?.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS).unref?.();
    };
    const onAbort = () => kill("cancelled");
    const timeout = setTimeout(() => kill("timeout"), options.timeoutMs);
    timeout.unref?.();
    const softDeadline = setTimeout(
      () => {
        if (settled || plan || closing) return;
        progress.wrappingUp = true;
        progress.lastActivity = "asked to wrap up";
        trace.note("Soft deadline reached: asked the planner to submit its best plan now.", "warning");
        send({ type: "steer", message: WRAP_UP_MESSAGE });
        report();
        reportTrace();
      },
      Math.max(1, Math.floor(options.timeoutMs * SOFT_DEADLINE_FRACTION)),
    );
    softDeadline.unref?.();

    const handleRecord = (record: Record<string, unknown>) => {
      if (record.type === "extension_ui_request") {
        // Planners run unattended: decline every dialog so nothing blocks waiting for a person.
        const method = record.method;
        if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
          send({ type: "extension_ui_response", id: record.id, cancelled: true });
        }
        return;
      }
      if (record.type === "tool_execution_update" && record.toolName === PLAN_SUBAGENTS_TOOL_NAME) {
        const partial = isRecord(record.partialResult) ? record.partialResult : undefined;
        const callId = typeof record.toolCallId === "string" ? record.toolCallId : "call";
        if (subagents.apply(callId, partial?.details)) reportSubagents();
        return;
      }
      if (record.type === "response") {
        if (record.success === false && record.command === "prompt") {
          assistantError = typeof record.error === "string" ? record.error : "The planner rejected the prompt.";
          closeInput();
        }
        return;
      }
      trace.apply(record);
      let changed = true;
      if (record.type === "tool_execution_start") {
        const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
        progress.toolCalls += 1;
        progress.lastActivity = describeToolArgs(toolName, record.args);
        if (toolName === PLAN_SUBAGENTS_TOOL_NAME && isRecord(record.args) && Array.isArray(record.args.tasks)) {
          progress.subagentTasks += record.args.tasks.length;
        }
        if (toolName === "plan_mode_complete" && isRecord(record.args) && typeof record.args.plan === "string") {
          plan = record.args.plan.trim() || plan;
          progress.lastActivity = "submitted plan";
        }
      } else if (record.type === "tool_execution_end") {
        if (record.toolName === PLAN_SUBAGENTS_TOOL_NAME && typeof record.toolCallId === "string") {
          subagents.finish(record.toolCallId, terminalState === "cancelled");
          reportSubagents();
        }
        // Nested model work (plan_subagents) reports its usage on the tool result.
        const result = isRecord(record.result) ? record.result : undefined;
        if (result && isRecord(result.usage)) addUsage(progress, result.usage);
        if (record.toolName === "plan_mode_complete" && record.isError === true) {
          plan = undefined;
          progress.lastActivity = "plan rejected; revising";
        }
      } else if (record.type === "message_end" && isRecord(record.message) && record.message.role === "assistant") {
        const message = record.message;
        if (isRecord(message.usage)) addUsage(progress, message.usage);
        const text = assistantText(message.content);
        if (text) lastAssistantText = text;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          assistantError =
            typeof message.errorMessage === "string" ? message.errorMessage : `Model ${message.stopReason}.`;
        } else {
          assistantError = undefined;
        }
      } else if (record.type === "agent_settled") {
        if (plan || terminalState) {
          closeInput();
        } else if (!nudged && !assistantError) {
          nudged = true;
          trace.note("Stopped without a plan: asked it to submit one.", "warning");
          progress.lastActivity = "asked to submit its plan";
          send({ type: "prompt", message: NUDGE_MESSAGE });
        } else {
          closeInput();
        }
      } else if (record.type === "message_update") {
        const update = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
        const activity =
          update?.type === "thinking_delta" ? "thinking" : update?.type === "text_delta" ? "writing" : undefined;
        if (activity && !progress.wrappingUp && progress.lastActivity !== activity) {
          progress.lastActivity = activity;
          report();
        }
      } else {
        changed = record.type === "auto_retry_start" || record.type === "compaction_start";
      }
      if (changed) {
        report();
        reportTrace();
      }
    };

    const spawnProcess = options.spawnProcess ?? spawn;
    const pi = options.piCommand ?? piSpawnCommand();
    try {
      child = spawnProcess(pi.command, [...pi.args, ...plannerArgs(options)], {
        cwd: options.cwd,
        env: plannerEnv(options),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      assistantError = `Could not start Pi: ${error instanceof Error ? error.message : String(error)}`;
      finish(null);
      return;
    }
    progress.state = "running";
    report();
    reportTrace();
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        if (!line.trim()) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (isRecord(record)) handleRecord(record);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error) => {
      assistantError = `Could not start Pi: ${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    send({ id: "prompt", type: "prompt", message: options.prompt });
  });
}

function addUsage(progress: PlannerProgress, usage: Record<string, unknown>) {
  progress.totalTokens += typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
  progress.costUsd += typeof cost === "number" ? cost : 0;
}

function assistantText(content: unknown) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
