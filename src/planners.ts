import { type CommandGrant, type ResolvedGrant, resolveGrant } from "./command-grants.js";
import type { ImplementationModelOverride } from "./implementation-models.js";
import { isMcpToolName, type McpServerCatalog, mcpToolNames } from "./mcp-tools.js";

export const PLANNER_ENV = "PI_PLAN_MODE_PLANNER";
/** Comma-separated extra tools a planner may use; Plan mode admits them inside planners. */
export const EXTRA_TOOLS_ENV = "PI_PLAN_MODE_EXTRA_TOOLS";
/** JSON array of extension paths a planner passes on to its scouts. */
export const SCOUT_EXTENSIONS_ENV = "PI_PLAN_MODE_SCOUT_EXTENSIONS";
/** Comma-separated extra tools a planner passes on to its scouts. */
export const SCOUT_TOOLS_ENV = "PI_PLAN_MODE_SCOUT_TOOLS";
/** JSON array of MCP tools (`server/tool` or `server/*`) this process may call from codemode. */
export const MCP_ALLOW_ENV = "PI_PLAN_MODE_MCP_ALLOW";
/** JSON array of MCP tools a planner passes on to its scouts. */
export const SCOUT_MCP_ALLOW_ENV = "PI_PLAN_MODE_SCOUT_MCP_ALLOW";

/** Undefined means MCP calls are not restricted (no allowlist was passed). */
export function mcpAllowFromEnv(name = MCP_ALLOW_ENV, env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  return jsonListFromEnv(env[name]);
}

function jsonListFromEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A named bundle of extensions and tools that planners (and optionally their scouts) can be given. */
export interface PlannerToolset {
  label: string;
  /** What the toolset gives planners; shown in the picker and read by Jev. */
  description?: string;
  extensions: string[];
  tools: string[];
  /** Per-tool descriptions for the picker and Jev. */
  toolDescriptions?: Record<string, string>;
  /**
   * Expand into the MCP servers and their tools instead of listing `tools`, which name the gateway
   * (`codemode`). The chosen MCP tools join `tools`, so `--tools` registers exactly those.
   */
  mcp?: boolean;
  /** Selected by default when Jev is unavailable. */
  enabled: boolean;
  /** Also give these extensions and tools to the planner's scouts. */
  scouts: boolean;
}

/** What the user chose on the tools screen. */
export interface ToolSelection {
  shell: boolean;
  subagents: boolean;
  /** Chosen tools of ordinary toolsets, by toolset id. */
  toolsetTools: Record<string, string[]>;
  /** Chosen MCP tools as `server/tool`, or `server/*` for a whole server. */
  mcp: string[];
  /** Chosen command grants, by id. */
  grants?: string[];
}

/** What planners may use in one run. */
export interface PlannerAccess {
  shell: boolean;
  subagents: boolean;
  /** Extensions loaded into planners, and the tools they enable (including chosen MCP tools). */
  extensions: string[];
  tools: string[];
  /** MCP tools planners may call from codemode; undefined when MCP is not offered. */
  mcpAllow?: string[];
  /** Extensions, tools, and MCP tools passed on to scouts. */
  scoutExtensions: string[];
  scoutTools: string[];
  scoutMcpAllow?: string[];
  /** Extra commands bash may run (command grants), with the skills that explain them. */
  grants?: ResolvedGrant[];
}

export const DEFAULT_PLANNER_ACCESS: PlannerAccess = {
  shell: true,
  subagents: true,
  extensions: [],
  tools: [],
  scoutExtensions: [],
  scoutTools: [],
};

export function resolvePlannerAccess(
  selection: ToolSelection,
  toolsets: Readonly<Record<string, PlannerToolset>>,
  resolvePath: (path: string) => string = (path) => path,
  commandGrants: Readonly<Record<string, CommandGrant>> = {},
  mcpCatalog: readonly McpServerCatalog[] = [],
): PlannerAccess {
  const grants = (selection.grants ?? []).flatMap((id) => {
    const grant = commandGrants[id];
    return grant ? [resolveGrant(id, grant, resolvePath)] : [];
  });
  const extensions: string[] = [];
  const tools: string[] = [];
  const scoutExtensions: string[] = [];
  const scoutTools: string[] = [];
  let mcpAllow: string[] | undefined;
  let scoutMcpAllow: string[] | undefined;
  for (const [id, toolset] of Object.entries(toolsets)) {
    const chosen = toolset.mcp
      ? selection.mcp.length > 0
        ? [...toolset.tools, ...mcpToolNames(mcpCatalog, selection.mcp)]
        : []
      : (selection.toolsetTools[id] ?? []).filter((tool) => toolset.tools.includes(tool));
    if (chosen.length === 0) continue;
    const paths = toolset.extensions.map(resolvePath);
    extensions.push(...paths);
    tools.push(...chosen);
    if (toolset.mcp) mcpAllow = [...selection.mcp];
    if (toolset.scouts) {
      scoutExtensions.push(...paths);
      scoutTools.push(...chosen);
      if (toolset.mcp) scoutMcpAllow = [...selection.mcp];
    }
  }
  const unique = (values: string[]) => [...new Set(values)];
  return {
    // Granted commands run through bash.
    shell: selection.shell || grants.length > 0,
    subagents: selection.subagents,
    ...(grants.length > 0 ? { grants } : {}),
    extensions: unique(extensions),
    tools: unique(tools),
    ...(mcpAllow ? { mcpAllow } : {}),
    scoutExtensions: unique(scoutExtensions),
    scoutTools: unique(scoutTools),
    ...(scoutMcpAllow ? { scoutMcpAllow } : {}),
  };
}

const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_TOOL_RESULT_CHARS = 4_000;

/** A planner's plan, as the synthesis prompt describes it. */
export interface PlanCandidate {
  /** `A` or `B`. */
  id: string;
  /** Model spec label. */
  label: string;
  model?: ImplementationModelOverride;
  plan?: string;
  revision?: number;
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** 999, 12.3k, 123k, 10.4M. */
export function formatTokens(tokens: number) {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 2 : 1)}M`;
}

export function formatCost(usd: number) {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
}

type BranchEntry = {
  type?: string;
  id?: string;
  customType?: string;
  summary?: string;
  firstKeptEntryId?: string;
  content?: unknown;
  data?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    customType?: string;
  };
};

/**
 * Render the planning conversation for planner subprocesses: user and assistant text plus
 * plan-question answers. Tool output and completed plans are left out so planners explore the
 * repository themselves and are not anchored on an earlier plan.
 */
export function buildPlannerTranscript(entries: readonly unknown[], maxChars = MAX_TRANSCRIPT_CHARS) {
  const branch = entries as BranchEntry[];
  let start = 0;
  let summary: string | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    summary = typeof entry.summary === "string" ? entry.summary : undefined;
    const kept = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    start = kept >= 0 && kept < index ? kept : index + 1;
    break;
  }
  const blocks: string[] = [];
  if (summary?.trim()) blocks.push(`Summary of earlier conversation:\n${summary.trim()}`);
  for (const entry of branch.slice(start)) {
    if (entry?.type === "compaction") continue;
    if (entry?.type !== "message" || !entry.message) continue;
    const { role } = entry.message;
    if (role === "user") {
      const text = textContent(entry.message.content);
      if (text) blocks.push(`User: ${text}`);
    } else if (role === "assistant") {
      const text = textContent(entry.message.content);
      if (text) blocks.push(`Assistant: ${text}`);
    } else if (role === "toolResult" && entry.message.toolName === "plan_mode_question") {
      const text = textContent(entry.message.content);
      if (text) blocks.push(`Answers to planning questions:\n${truncate(text, MAX_TOOL_RESULT_CHARS)}`);
    }
  }
  const transcript = blocks.join("\n\n");
  if (transcript.length <= maxChars) return transcript;
  const first = blocks[0] ?? "";
  const tailBudget = Math.max(0, maxChars - Math.min(first.length, maxChars / 4) - 64);
  return `${truncate(first, maxChars / 4)}\n\n[… earlier conversation omitted …]\n\n${transcript.slice(-tailBudget)}`;
}

/** Tells a model which MCP tools it may call from codemode scripts, and how to find them. */
export function mcpToolsNote(mcpAllow: readonly string[], lead: string) {
  return `From codemode scripts ${lead} (server/tool; * means every tool on that server): ${mcpAllow.join(", ") || "none"}. They are named mcp__<server>__<tool>; the codemode description lists them, and scripts find the rest with searchTools() and describeTool(). MCP tools reach external services and some can change things; use them only to read.`;
}

/** The tools to name in prose: the chosen MCP tools are described by the MCP note instead. */
export function describedTools(tools: readonly string[]) {
  return tools.filter((tool) => !isMcpToolName(tool));
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
