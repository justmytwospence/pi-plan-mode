// What a planner may use, from the tools screen: the tree (Shell, Subagents, toolsets, MCP servers,
// Other tools) and its selection, resolved into the planner session's tools, extensions and policy.
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { CommandGrant, ResolvedGrant } from "../command-grants.js";
import { PLAN_MODE_COMPLETE_TOOL_NAME } from "../completion-tool.js";
import type { ModelSpec } from "../implementation-models.js";
import { formatModelSpec } from "../implementation-models.js";
import { MCP_GATEWAY_TOOL } from "../mcp-tools.js";
import { type PlannerToolset, resolvePlannerAccess } from "../planners.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "../question-tool.js";
import { PLAN_SUBAGENTS_TOOL_NAME } from "../scout-process.js";
import type { SafeSubcommands } from "../tool-policy.js";
import { isBuiltinTool } from "../tool-policy.js";
import { leaves, type ToolNode, treeToSelection } from "../tool-tree.js";
import type { PlannerAccessConfig } from "./agent.js";
import { plannerSystemPrompt } from "./prompt.js";

const READ_TOOLS = ["read", "grep", "find", "ls"];
/** Tools that make no sense in a planner: it asks you with plan_mode_question instead. */
const NOT_FOR_PLANNERS = new Set([
  "ask_user_question",
  "plan_mode_question",
  "plan_mode_complete",
  "edit",
  "write",
  "update_plan",
]);

/** A tool from your session that planners can load: it comes from an extension file. */
export interface OtherTool {
  name: string;
  description: string;
  /** The extension that registers it. */
  extension: string;
}

/**
 * Tools in your session that planners may be given beyond the toolsets: extension tools whose
 * extension can be loaded into a planner. Pi's own tools, MCP tools, toolset tools, and tools of
 * this package are covered elsewhere.
 */
export function otherTools(all: readonly ToolInfo[], covered: ReadonlySet<string>, ownPath: string): OtherTool[] {
  const seen = new Set<string>();
  const tools: OtherTool[] = [];
  for (const tool of all) {
    if (seen.has(tool.name) || covered.has(tool.name) || NOT_FOR_PLANNERS.has(tool.name)) continue;
    if (isBuiltinTool(tool) || tool.namespace?.name?.startsWith("mcp__")) continue;
    const path = (tool.sourceInfo as { path?: unknown }).path;
    if (typeof path !== "string" || !path || path.startsWith("builtin:") || path.startsWith("<")) continue;
    if (path === ownPath || path.startsWith(ownPath.replace(/index\.ts$/u, ""))) continue;
    seen.add(tool.name);
    tools.push({ name: tool.name, description: oneLine(tool.description ?? "") || tool.name, extension: path });
  }
  return tools;
}

/** The Other tools group: off unless Jev or you pick them. */
export function otherToolsNode(tools: readonly OtherTool[]): ToolNode | undefined {
  if (tools.length === 0) return undefined;
  return {
    id: "other-tools",
    label: "Other tools",
    description: "Tools from your other Pi extensions, loaded into the planners when selected.",
    children: tools.map((tool) => ({
      id: `other:${tool.name}`,
      label: tool.name,
      description: tool.description,
      selected: false,
    })),
  };
}

export interface ResolveAccessInput {
  roots: readonly ToolNode[];
  toolsets: Readonly<Record<string, PlannerToolset>>;
  grants: Readonly<Record<string, CommandGrant>>;
  others: readonly OtherTool[];
  scout: ModelSpec | undefined;
  safeSubcommands?: SafeSubcommands;
  guardExtensionPath: string;
  expandPath(path: string): string;
}

export interface ResolvedAccess {
  config: PlannerAccessConfig;
  /** For the task prompt. */
  extraTools: string[];
  mcpAllow?: string[];
  grants: ResolvedGrant[];
  scoutLabel?: string;
}

export function resolveAccess(input: ResolveAccessInput): ResolvedAccess {
  const selection = treeToSelection(input.roots);
  const access = resolvePlannerAccess(selection, input.toolsets, input.expandPath, input.grants);
  const chosenOthers = leaves(input.roots)
    .filter((leaf) => leaf.selected && leaf.id.startsWith("other:"))
    .map((leaf) => input.others.find((tool) => tool.name === leaf.id.slice("other:".length)))
    .filter((tool): tool is OtherTool => tool !== undefined);
  const scouts = access.subagents && input.scout ? input.scout : undefined;
  const extraTools = [...access.tools, ...chosenOthers.map((tool) => tool.name)];
  const tools = [
    ...READ_TOOLS,
    ...(access.shell ? ["bash"] : []),
    PLAN_MODE_QUESTION_TOOL_NAME,
    PLAN_MODE_COMPLETE_TOOL_NAME,
    ...(scouts ? [PLAN_SUBAGENTS_TOOL_NAME] : []),
    ...extraTools,
  ];
  const grants = access.grants ?? [];
  return {
    config: {
      tools: [...new Set(tools)],
      extensions: [...new Set([...access.extensions, ...chosenOthers.map((tool) => tool.extension)])],
      skills: [...new Set(grants.flatMap((grant) => grant.skills))],
      systemPrompt: [plannerSystemPrompt()],
      policy: {
        tools: new Set(tools),
        ...(access.mcpAllow ? { mcpAllow: access.mcpAllow } : {}),
        grantPrefixes: grants.flatMap((grant) => grant.commands),
        ...(input.safeSubcommands ? { safeSubcommands: input.safeSubcommands } : {}),
        ...(scouts
          ? {
              scouts: {
                spec: scouts,
                extensions: access.scoutExtensions,
                tools: access.scoutTools,
                ...(access.scoutMcpAllow ? { mcpAllow: access.scoutMcpAllow } : {}),
              },
            }
          : {}),
        guardExtensionPath: input.guardExtensionPath,
      },
    },
    extraTools,
    ...(access.mcpAllow ? { mcpAllow: access.mcpAllow } : {}),
    grants,
    ...(scouts ? { scoutLabel: formatModelSpec(scouts) } : {}),
  };
}

/** Whether the selection gives planners MCP tools (they reach them through codemode). */
export function usesMcp(config: PlannerAccessConfig) {
  return config.tools.includes(MCP_GATEWAY_TOOL);
}

function oneLine(text: string) {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
