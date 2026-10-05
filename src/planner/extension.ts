// The read-only policy and tools of one planner session. Each planner is an in-process Pi session
// (see session.ts) that loads this extension: it may only read, search and run reviewed shell
// commands; it asks you questions through the planning screen; and it submits its plan with
// plan_mode_complete. Nothing here runs in your main session.
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionFactory, ToolInfo } from "@earendil-works/pi-coding-agent";
import { commandGrantAllows } from "../command-grants.js";
import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_PARAMS,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planModeCompleted,
} from "../completion-tool.js";
import { formatModelSpec, type ModelSpec } from "../implementation-models.js";
import {
  checkMcpResourceCall,
  checkMcpTool,
  isMcpToolName,
  MCP_RESOURCE_TOOLS,
  type McpGuardVerdict,
  mcpToolIdentity,
} from "../mcp-tools.js";
import {
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  type PlanModeQuestion,
  type PlanModeQuestionAnswer,
  planModeQuestionAnswered,
  planModeQuestionCancelled,
} from "../question-tool.js";
import {
  addUsage,
  emptyUsage,
  formatScoutResults,
  normalizeScoutTasks,
  PLAN_SUBAGENTS_PARAMS,
  PLAN_SUBAGENTS_TOOL_NAME,
  runScout,
} from "../scout-process.js";
import { createSubagentReporter, type SubagentMeta } from "../subagent-progress.js";
import {
  findBlockedCommandSegment,
  findBlockedPowerShellCommandSegment,
  readCommand,
  type SafeSubcommands,
} from "../tool-policy.js";

const BLOCKED_TOOLS = new Set(["edit", "write", "update_plan"]);

export interface PlannerScouts {
  spec: ModelSpec;
  extensions: readonly string[];
  tools: readonly string[];
  mcpAllow?: readonly string[];
}

export interface PlannerPolicy {
  /** Tools the planner may call (besides its own plan tools). */
  tools: ReadonlySet<string>;
  /** MCP tools codemode scripts may call; undefined allows every one loaded. */
  mcpAllow?: readonly string[];
  /** Command prefixes bash may run beyond the read-only policy. */
  grantPrefixes: readonly string[];
  safeSubcommands?: SafeSubcommands;
  scouts?: PlannerScouts;
  /** Path of this package's entry, which scouts load to enforce an MCP allowlist. */
  guardExtensionPath: string;
  /** Show questions in the planner's lane and wait for your answers; undefined when you skip them. */
  ask(questions: PlanModeQuestion[], signal: AbortSignal | undefined): Promise<PlanModeQuestionAnswer[] | undefined>;
  /** The planner submitted (or resubmitted) its plan. */
  onPlan(plan: string): void;
}

export function plannerExtension(policy: PlannerPolicy): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: PLAN_MODE_QUESTION_TOOL_NAME,
      label: "Plan question",
      description:
        "Ask the user one to three structured questions when a product decision, preference, or tradeoff cannot be discovered by reading the code. Each question has 2-4 meaningful options; the user can also answer in their own words.",
      parameters: PLAN_MODE_QUESTION_PARAMS as never,
      async execute(_id, params: unknown, signal) {
        const parsed = normalizePlanModeQuestionParams(params);
        if (!parsed.ok) return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`) as never;
        const answers = await policy.ask(parsed.questions, signal);
        if (!answers) {
          return planModeQuestionCancelled(
            parsed.questions,
            "cancelled",
            "The user skipped these questions. Proceed with clearly stated low-risk assumptions, or ask once more in plain text if an answer is essential.",
          ) as never;
        }
        return planModeQuestionAnswered(parsed.questions, answers) as never;
      },
    });

    pi.registerTool({
      name: PLAN_MODE_COMPLETE_TOOL_NAME,
      label: "Complete plan",
      description:
        "Submit the decision-ready implementation plan (Markdown). Call it alone as your final action. To revise a plan later, call it again with the complete replacement.",
      parameters: PLAN_MODE_COMPLETE_PARAMS as never,
      async execute(_id, params: unknown) {
        const parsed = normalizePlanModeCompletion(params);
        if (!parsed.ok) throw new Error(parsed.error);
        policy.onPlan(parsed.plan);
        return planModeCompleted(parsed.plan);
      },
    });

    const scouts = policy.scouts;
    const running = new Set<ChildProcess>();
    if (scouts) {
      pi.registerTool({
        name: PLAN_SUBAGENTS_TOOL_NAME,
        label: "Plan subagents",
        description: `Run up to 6 read-only subagents in parallel on ${formatModelSpec(scouts.spec)} to investigate the codebase while planning. Each gets only its task text, can read and search files (no shell, no edits), and returns a report. Use it for broad or independent investigations; verify decisive facts yourself.`,
        parameters: PLAN_SUBAGENTS_PARAMS as never,
        async execute(_id, params: unknown, signal, onUpdate, ctx) {
          const parsed = normalizeScoutTasks(params);
          if (!parsed.ok) throw new Error(parsed.error);
          const metas: SubagentMeta[] = parsed.tasks.map((task, index) => ({
            index,
            label: task.label,
            model: formatModelSpec(scouts.spec),
            task: task.task,
            state: "running",
            startedAt: Date.now(),
          }));
          const reporter = createSubagentReporter(metas, (details, summary) =>
            onUpdate?.({ content: [{ type: "text", text: summary }], details } as never),
          );
          reporter.flush();
          const results = await Promise.all(
            parsed.tasks.map((task, index) =>
              runScout({
                spec: scouts.spec,
                task,
                cwd: ctx.cwd,
                onRecord: (record) => reporter.record(index, record),
                extensions: scouts.extensions,
                tools: scouts.tools,
                ...(scouts.mcpAllow
                  ? { mcpAllow: scouts.mcpAllow, guardExtensionPath: policy.guardExtensionPath }
                  : {}),
                ...(signal ? { signal } : {}),
                track: (child) => {
                  running.add(child);
                  return () => running.delete(child);
                },
              }).then((result) => {
                const meta = metas[index];
                if (meta) {
                  meta.state = result.status;
                  meta.endedAt = Date.now();
                }
                reporter.flush();
                return result;
              }),
            ),
          );
          const usage = emptyUsage();
          for (const result of results) addUsage(usage, result.usage);
          return {
            content: [{ type: "text" as const, text: formatScoutResults(scouts.spec, results) }],
            details: { results: results.map(({ label, status }) => ({ label, status })) },
            usage,
          } as never;
        },
      });
      pi.on("session_shutdown", () => {
        for (const child of running) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
        running.clear();
      });
    }

    const toolByName = (name: string): ToolInfo | undefined => {
      try {
        return pi.getAllTools().find((tool) => tool.name === name);
      } catch {
        return undefined;
      }
    };

    pi.on("tool_call", async (event, ctx) => {
      const name = event.toolName;
      if (name === PLAN_MODE_QUESTION_TOOL_NAME || name === PLAN_MODE_COMPLETE_TOOL_NAME) return undefined;
      if (scouts && name === PLAN_SUBAGENTS_TOOL_NAME) return undefined;
      if (BLOCKED_TOOLS.has(name)) return { block: true, reason: `Planning is read-only: '${name}' is blocked.` };
      const mcp = checkMcp(toolByName(name), name, event.input, policy.mcpAllow);
      if (mcp) return mcp.allowed ? undefined : { block: true, reason: mcp.reason };
      if (!policy.tools.has(name)) {
        return { block: true, reason: `'${name}' was not selected for this plan.` };
      }
      if (name === "bash") {
        const command = readCommand(event.input);
        if (commandGrantAllows(command, policy.grantPrefixes)) return undefined;
        const blocked = findBlockedCommandSegment(command, policy.safeSubcommands, ctx.cwd);
        if (blocked !== undefined) {
          return {
            block: true,
            reason: `Planning only runs reviewed read-only commands.\nBlocked command: ${blocked}${
              policy.grantPrefixes.length > 0
                ? `\nGranted commands also allowed (one per call): ${policy.grantPrefixes.join(", ")}`
                : ""
            }`,
          };
        }
      }
      if (name === "powershell") {
        const blocked = findBlockedPowerShellCommandSegment(readCommand(event.input), policy.safeSubcommands, ctx.cwd);
        if (blocked !== undefined) {
          return {
            block: true,
            reason: `Planning only runs reviewed read-only commands.\nBlocked command: ${blocked}`,
          };
        }
      }
      return undefined;
    });
  };
}

/** The allowlist verdict for an MCP tool or MCP resource call; undefined for other tools. */
function checkMcp(
  tool: ToolInfo | undefined,
  name: string,
  input: unknown,
  allow: readonly string[] | undefined,
): McpGuardVerdict | undefined {
  if (MCP_RESOURCE_TOOLS.has(name) && tool?.sourceInfo.path === "builtin:mcp")
    return checkMcpResourceCall(input, allow);
  const identity = mcpToolIdentity(tool);
  if (identity) return checkMcpTool(identity, allow);
  return isMcpToolName(name) && !tool ? { allowed: false, reason: `MCP tool '${name}' is not registered.` } : undefined;
}
