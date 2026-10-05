import { type ChildProcess, spawn } from "node:child_process";
import { formatModelSpec, type ModelSpec } from "./implementation-models.js";
import { MCP_GATEWAY_TOOL } from "./mcp-tools.js";
import { piSpawnCommand } from "./pi-command.js";
import {
  describedTools,
  EXTRA_TOOLS_ENV,
  MCP_ALLOW_ENV,
  mcpToolsNote,
  PLANNER_ENV,
  SCOUT_EXTENSIONS_ENV,
  SCOUT_MCP_ALLOW_ENV,
  SCOUT_TOOLS_ENV,
} from "./planners.js";

export const PLAN_SUBAGENTS_TOOL_NAME = "plan_subagents";
export const SCOUT_MODEL_ENV = "PI_PLAN_MODE_SCOUT_MODEL";
export const MAX_SCOUT_TASKS = 6;
const SCOUT_TOOLS = ["read", "grep", "find", "ls"];
const SCOUT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REPORT_CHARS = 12_000;
const KILL_GRACE_MS = 3_000;

export const PLAN_SUBAGENTS_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SCOUT_TASKS,
      description: "Independent investigations to run in parallel, one read-only subagent each.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          label: { type: "string", maxLength: 80, description: "Short name for the investigation." },
          task: {
            type: "string",
            minLength: 1,
            maxLength: 8_000,
            description: "What to investigate and what the report must contain. The subagent sees nothing else.",
          },
        },
      },
    },
  },
} as const;

export interface ScoutTask {
  label: string;
  task: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface ScoutResult {
  label: string;
  status: "done" | "failed" | "timeout" | "cancelled";
  report: string;
  usage: Usage;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(total: Usage, value: unknown) {
  if (!isRecord(value)) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const amount = value[key];
    if (typeof amount === "number" && Number.isFinite(amount)) total[key] += amount;
  }
  if (isRecord(value.cost)) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      const amount = value.cost[key];
      if (typeof amount === "number" && Number.isFinite(amount)) total.cost[key] += amount;
    }
  }
}

export function normalizeScoutTasks(params: unknown): { ok: true; tasks: ScoutTask[] } | { ok: false; error: string } {
  if (!isRecord(params) || !Array.isArray(params.tasks)) return { ok: false, error: "tasks must be an array" };
  if (params.tasks.length === 0 || params.tasks.length > MAX_SCOUT_TASKS) {
    return { ok: false, error: `tasks must contain 1-${MAX_SCOUT_TASKS} items` };
  }
  const tasks: ScoutTask[] = [];
  for (const [index, item] of params.tasks.entries()) {
    if (!isRecord(item) || typeof item.task !== "string" || !item.task.trim()) {
      return { ok: false, error: `tasks[${index}].task must be a non-empty string` };
    }
    const label =
      typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 80) : `task ${index + 1}`;
    tasks.push({ label, task: item.task.trim().slice(0, 8_000) });
  }
  return { ok: true, tasks };
}

export function scoutPrompt(task: string, allExtraTools: readonly string[] = [], mcpAllow?: readonly string[]) {
  const extraTools = describedTools(allExtraTools);
  return [
    "You are a read-only scout working for a planner. Investigate the codebase to answer the task below, then reply with a concise, factual report: what you found, with file paths, line references, and source URLs, and anything you could not determine.",
    extraTools.length > 0
      ? `You can read and search files, and research beyond the repository with ${extraTools.join(", ")}. You cannot run commands or edit files. Do not propose an implementation plan unless the task asks for options.`
      : "You can only read and search files. Do not propose an implementation plan unless the task asks for options.",
    ...(extraTools.includes(MCP_GATEWAY_TOOL) && mcpAllow
      ? [mcpToolsNote(mcpAllow, "you may call these MCP tools")]
      : []),
    "",
    "## Task",
    "",
    task,
  ].join("\n");
}

export function scoutArgs(
  spec: ModelSpec,
  task: string,
  extras: {
    extensions?: readonly string[];
    tools?: readonly string[];
    guardExtensionPath?: string;
    mcpAllow?: readonly string[];
  } = {},
) {
  return [
    "--mode",
    "json",
    "--no-session",
    "--model",
    formatModelSpec(spec),
    "--tools",
    [...SCOUT_TOOLS, ...(extras.tools ?? [])].join(","),
    "--no-extensions",
    // This extension rides along only to enforce the MCP allowlist inside the scout.
    ...(extras.guardExtensionPath ? ["--extension", extras.guardExtensionPath] : []),
    ...(extras.extensions ?? []).flatMap((extension) => ["--extension", extension]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--",
    scoutPrompt(task, extras.tools, extras.mcpAllow),
  ];
}

export interface RunScoutOptions {
  spec: ModelSpec;
  task: ScoutTask;
  cwd: string;
  /** Extra extensions and read-only tools (e.g. web research) for the scout. */
  extensions?: readonly string[];
  tools?: readonly string[];
  /** MCP tools the scout may call; loads `guardExtensionPath` to enforce it. */
  mcpAllow?: readonly string[];
  guardExtensionPath?: string;
  /** Receives every JSON record the scout emits, for live monitoring. */
  onRecord?(record: Record<string, unknown>): void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives every spawned child so the caller can kill stragglers on shutdown. */
  track?(child: ChildProcess): () => void;
  spawnProcess?: typeof spawn;
  piCommand?: { command: string; args: string[] };
}

/** Run one read-only scout (`read`, `grep`, `find`, `ls` only; no extensions). Never rejects. */
export function runScout(options: RunScoutOptions): Promise<ScoutResult> {
  const usage = emptyUsage();
  return new Promise((resolve) => {
    let lastText = "";
    let error: string | undefined;
    let buffer = "";
    let settled = false;
    let terminal: "timeout" | "cancelled" | undefined;
    let child: ChildProcess | undefined;
    let untrack: (() => void) | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      untrack?.();
      const report = lastText.trim();
      const status = terminal ?? (report && !error ? "done" : "failed");
      resolve({
        label: options.task.label,
        status,
        report:
          status === "done"
            ? truncate(report, MAX_REPORT_CHARS)
            : (error ??
              (terminal === "timeout" ? "Timed out." : terminal === "cancelled" ? "Cancelled." : "No report.")),
        usage,
      });
    };
    const kill = (reason: "timeout" | "cancelled") => {
      if (settled || terminal) return;
      terminal = reason;
      try {
        child?.kill("SIGTERM");
      } catch {
        // Gone.
      }
      setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Gone.
        }
      }, KILL_GRACE_MS).unref?.();
    };
    const onAbort = () => kill("cancelled");
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs ?? SCOUT_TIMEOUT_MS);
    timer.unref?.();

    const pi = options.piCommand ?? piSpawnCommand();
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: "1" };
    delete env[PLANNER_ENV];
    delete env[SCOUT_MODEL_ENV];
    delete env[EXTRA_TOOLS_ENV];
    delete env[SCOUT_EXTENSIONS_ENV];
    delete env[SCOUT_TOOLS_ENV];
    delete env[SCOUT_MCP_ALLOW_ENV];
    delete env[MCP_ALLOW_ENV];
    if (options.mcpAllow) env[MCP_ALLOW_ENV] = JSON.stringify(options.mcpAllow);
    try {
      child = (options.spawnProcess ?? spawn)(
        pi.command,
        [
          ...pi.args,
          ...scoutArgs(options.spec, options.task.task, {
            ...(options.extensions ? { extensions: options.extensions } : {}),
            ...(options.tools ? { tools: options.tools } : {}),
            ...(options.mcpAllow ? { mcpAllow: options.mcpAllow } : {}),
            ...(options.mcpAllow && options.guardExtensionPath
              ? { guardExtensionPath: options.guardExtensionPath }
              : {}),
          }),
        ],
        {
          cwd: options.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (spawnError: unknown) {
      error = `Could not start Pi: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`;
      finish();
      return;
    }
    untrack = options.track?.(child);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(event)) continue;
        try {
          options.onRecord?.(event);
        } catch {
          // Monitoring must never break a scout.
        }
        if (event.type !== "message_end" || !isRecord(event.message)) continue;
        if (event.message.role !== "assistant") continue;
        addUsage(usage, event.message.usage);
        const text = textOf(event.message.content);
        if (text) lastText = text;
        if (event.message.stopReason === "error") {
          error = typeof event.message.errorMessage === "string" ? event.message.errorMessage : "Model error.";
        }
      }
    });
    child.stderr?.resume();
    child.on("error", (spawnError) => {
      error = `Could not start Pi: ${spawnError.message}`;
      finish();
    });
    child.on("close", () => finish());
  });
}

export function formatScoutResults(spec: ModelSpec, results: readonly ScoutResult[]) {
  return [
    `Ran ${results.length} read-only subagent${results.length === 1 ? "" : "s"} on ${formatModelSpec(spec)}.`,
    ...results.map((result, index) =>
      [
        `## ${index + 1}. ${result.label}${result.status === "done" ? "" : ` (${result.status})`}`,
        "",
        result.report,
      ].join("\n"),
    ),
  ].join("\n\n");
}

function textOf(content: unknown) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
