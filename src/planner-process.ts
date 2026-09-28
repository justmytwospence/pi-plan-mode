import { type ChildProcess, spawn } from "node:child_process";
import { formatModelSpec, type ModelSpec } from "./implementation-models.js";
import { parseProposedPlan } from "./message-transform.js";
import { PLANNER_ENV, type PlanCandidate } from "./multi-plan.js";
import { piSpawnCommand } from "./pi-command.js";
import { PLAN_SUBAGENTS_TOOL_NAME, SCOUT_MODEL_ENV } from "./scout-process.js";

export { piSpawnCommand } from "./pi-command.js";

const PLANNER_TOOLS = ["read", "bash", "grep", "find", "ls", "plan_mode_question", "plan_mode_complete"];
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 2_000;
const MIN_PROSE_PLAN_CHARS = 200;

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
  signal: AbortSignal;
  onProgress(progress: PlannerProgress): void;
  /** Test seam: replaces `child_process.spawn`. */
  spawnProcess?: typeof spawn;
  /** Test seam: replaces how the Pi CLI is invoked. */
  piCommand?: { command: string; args: string[] };
}

export function plannerArgs(
  options: Pick<PlannerRunOptions, "spec" | "prompt" | "extensionPath" | "loadUserExtensions" | "scoutSpec">,
) {
  return [
    "--mode",
    "json",
    "--no-session",
    "--model",
    formatModelSpec(options.spec),
    "--tools",
    [...PLANNER_TOOLS, ...(options.scoutSpec ? [PLAN_SUBAGENTS_TOOL_NAME] : [])].join(","),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...(options.loadUserExtensions ? [] : ["--no-extensions", "--extension", options.extensionPath]),
    "--",
    options.prompt,
  ];
}

/**
 * Run one read-only planner as a `pi --mode json` subprocess in Plan mode and collect the plan it
 * submits with plan_mode_complete. Resolves with a candidate in every case; never rejects.
 */
export function runPlanner(options: PlannerRunOptions): Promise<PlanCandidate> {
  const startedAt = Date.now();
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
    let child: ChildProcess;

    const report = () => {
      try {
        options.onProgress({ ...progress });
      } catch {
        // Progress rendering must never break a planner run.
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      let status: PlanCandidate["status"];
      let finalPlan = plan;
      let planFromText = false;
      let error: string | undefined;
      if (terminalState) {
        status = terminalState;
        error =
          terminalState === "timeout" ? `Timed out after ${Math.round(options.timeoutMs / 1000)}s.` : "Cancelled.";
      } else {
        if (!finalPlan) {
          const parsed = parseProposedPlan(lastAssistantText);
          if (parsed.kind === "valid") finalPlan = parsed.plan;
          else if (lastAssistantText.trim().length >= MIN_PROSE_PLAN_CHARS && !assistantError) {
            finalPlan = lastAssistantText.trim();
            planFromText = true;
          }
        }
        status = finalPlan ? "done" : "failed";
        if (!finalPlan) {
          error =
            assistantError ??
            (stderrTail.trim()
              ? stderrTail.trim().split("\n").slice(-3).join(" ")
              : `Planner exited with code ${exitCode ?? "unknown"} without submitting a plan.`);
        }
      }
      progress.state = status;
      progress.endedAt = Date.now();
      report();
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
      const force = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
      force.unref?.();
    };
    const onAbort = () => kill("cancelled");
    const timeout = setTimeout(() => kill("timeout"), options.timeoutMs);
    timeout.unref?.();

    const handleEvent = (event: Record<string, unknown>) => {
      if (event.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        progress.toolCalls += 1;
        progress.lastActivity = describeToolCall(toolName, event.args);
        if (toolName === PLAN_SUBAGENTS_TOOL_NAME && isRecord(event.args) && Array.isArray(event.args.tasks)) {
          progress.subagentTasks += event.args.tasks.length;
        }
        if (toolName === "plan_mode_complete" && isRecord(event.args) && typeof event.args.plan === "string") {
          plan = event.args.plan.trim() || plan;
          progress.lastActivity = "submitted plan";
        }
        report();
      } else if (event.type === "tool_execution_end") {
        // Nested model work (plan_subagents) reports its usage on the tool result.
        const result = isRecord(event.result) ? event.result : undefined;
        if (result && isRecord(result.usage)) {
          const usage = result.usage;
          progress.totalTokens += typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
          const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
          progress.costUsd += typeof cost === "number" ? cost : 0;
          report();
        }
        if (event.toolName === "plan_mode_complete" && event.isError === true) {
          plan = undefined;
          progress.lastActivity = "plan rejected; revising";
          report();
        }
      } else if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
        const message = event.message;
        const usage = isRecord(message.usage) ? message.usage : undefined;
        if (usage) {
          progress.totalTokens += typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
          const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
          progress.costUsd += typeof cost === "number" ? cost : 0;
        }
        const text = assistantText(message.content);
        if (text) lastAssistantText = text;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          assistantError =
            typeof message.errorMessage === "string" ? message.errorMessage : `Model ${message.stopReason}.`;
        }
        report();
      }
    };

    const spawnProcess = options.spawnProcess ?? spawn;
    const pi = options.piCommand ?? piSpawnCommand();
    try {
      child = spawnProcess(pi.command, [...pi.args, ...plannerArgs(options)], {
        cwd: options.cwd,
        env: {
          ...process.env,
          [PLANNER_ENV]: "1",
          PI_SKIP_VERSION_CHECK: "1",
          ...(options.scoutSpec ? { [SCOUT_MODEL_ENV]: formatModelSpec(options.scoutSpec) } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      assistantError = `Could not start Pi: ${error instanceof Error ? error.message : String(error)}`;
      finish(null);
      return;
    }
    progress.state = "running";
    report();
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as unknown;
          if (isRecord(event)) handleEvent(event);
        } catch {
          // Ignore non-JSON lines; stdout is reserved for JSONL but be tolerant.
        }
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
  });
}

function describeToolCall(toolName: string, args: unknown) {
  if (!isRecord(args)) return toolName;
  if (Array.isArray(args.tasks)) return `${toolName} ×${args.tasks.length}`;
  const detail =
    typeof args.path === "string"
      ? args.path
      : typeof args.pattern === "string"
        ? args.pattern
        : typeof args.command === "string"
          ? args.command
          : undefined;
  if (!detail) return toolName;
  const oneLine = detail.replace(/\s+/gu, " ").trim();
  return `${toolName} ${oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine}`;
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
