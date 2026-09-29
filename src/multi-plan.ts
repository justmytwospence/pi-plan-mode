import { formatModelSpec, type ImplementationModelOverride, type ModelSpec } from "./implementation-models.js";

export const PLANNER_ENV = "PI_PLAN_MODE_PLANNER";
/** Comma-separated extra tools a planner may use; Plan mode admits them inside planners. */
export const EXTRA_TOOLS_ENV = "PI_PLAN_MODE_EXTRA_TOOLS";
/** JSON array of extension paths a planner passes on to its scouts. */
export const SCOUT_EXTENSIONS_ENV = "PI_PLAN_MODE_SCOUT_EXTENSIONS";
/** Comma-separated extra tools a planner passes on to its scouts. */
export const SCOUT_TOOLS_ENV = "PI_PLAN_MODE_SCOUT_TOOLS";
/** JSON array of MCP tools (`server/tool` or `server/*`) this process may call through `mcp`. */
export const MCP_ALLOW_ENV = "PI_PLAN_MODE_MCP_ALLOW";
/** JSON array of MCP tools a planner passes on to its scouts. */
export const SCOUT_MCP_ALLOW_ENV = "PI_PLAN_MODE_SCOUT_MCP_ALLOW";

export function extraToolsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return listFromEnv(env[EXTRA_TOOLS_ENV]);
}

export function scoutToolsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return listFromEnv(env[SCOUT_TOOLS_ENV]);
}

export function scoutExtensionsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return jsonListFromEnv(env[SCOUT_EXTENSIONS_ENV]) ?? [];
}

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

function listFromEnv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
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
  /** Expand into the configured MCP servers and their tools instead of listing `tools`. */
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
}

/** What planners may use in one run. */
export interface PlannerAccess {
  shell: boolean;
  subagents: boolean;
  /** Extensions loaded into planners, and the tools they enable. */
  extensions: string[];
  tools: string[];
  /** MCP tools planners may call through `mcp`; undefined when MCP is not offered. */
  mcpAllow?: string[];
  /** Extensions, tools, and MCP tools passed on to scouts. */
  scoutExtensions: string[];
  scoutTools: string[];
  scoutMcpAllow?: string[];
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
): PlannerAccess {
  const extensions: string[] = [];
  const tools: string[] = [];
  const scoutExtensions: string[] = [];
  const scoutTools: string[] = [];
  let mcpAllow: string[] | undefined;
  let scoutMcpAllow: string[] | undefined;
  for (const [id, toolset] of Object.entries(toolsets)) {
    const chosen = toolset.mcp
      ? selection.mcp.length > 0
        ? toolset.tools
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
    shell: selection.shell,
    subagents: selection.subagents,
    extensions: unique(extensions),
    tools: unique(tools),
    ...(mcpAllow ? { mcpAllow } : {}),
    scoutExtensions: unique(scoutExtensions),
    scoutTools: unique(scoutTools),
    ...(scoutMcpAllow ? { scoutMcpAllow } : {}),
  };
}

export const CANDIDATES_ENTRY_TYPE = "plan-mode-candidates";
export const MULTI_TASK_MESSAGE_TYPE = "plan-mode-multi-task";
export const SELECTED_PLAN_MESSAGE_TYPE = "plan-mode-selected-plan";
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_TOOL_RESULT_CHARS = 4_000;
const CANDIDATE_IDS = "ABCDEFGHIJ";

export type CandidateStatus = "done" | "failed" | "cancelled" | "timeout";

export interface PlanCandidate {
  /** Letter shown to the user and in the synthesis prompt. */
  id: string;
  /** Model spec label, or "Current plan" for the plan already in this session. */
  label: string;
  origin: "planner" | "session";
  model?: ImplementationModelOverride;
  thinkingLevel?: ModelSpec["thinkingLevel"];
  status: CandidateStatus;
  plan?: string;
  /** True when the planner answered in prose instead of calling plan_mode_complete. */
  planFromText?: boolean;
  error?: string;
  durationMs?: number;
  toolCalls?: number;
  /** Read-only subagent tasks the planner delegated through plan_subagents. */
  subagentTasks?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface CandidateSet {
  version: 1;
  task: string;
  createdAt: number;
  candidates: PlanCandidate[];
}

export function candidateId(index: number) {
  return CANDIDATE_IDS[index] ?? String(index + 1);
}

export function isPlannerProcess(env: NodeJS.ProcessEnv = process.env) {
  return env[PLANNER_ENV] === "1";
}

export function candidateSummary(candidate: PlanCandidate) {
  return statsCells({
    status: candidate.status === "done" ? "" : candidate.status,
    ...(candidate.durationMs !== undefined ? { durationMs: candidate.durationMs } : {}),
    ...(candidate.toolCalls !== undefined ? { toolCalls: candidate.toolCalls } : {}),
    subagents: candidate.subagentTasks ?? 0,
    tokens: candidate.totalTokens ?? 0,
    cost: candidate.costUsd ?? 0,
  })
    .filter(Boolean)
    .concat(candidate.planFromText ? ["plan taken from prose"] : [])
    .join(" · ");
}

/** Stats for one planner as separate cells, so callers can align them across planners. */
export function statsCells(stats: {
  status?: string;
  durationMs?: number;
  toolCalls?: number;
  subagents?: number;
  tokens?: number;
  cost?: number;
}): string[] {
  return [
    stats.status ?? "",
    stats.durationMs !== undefined ? formatDuration(stats.durationMs) : "",
    stats.toolCalls !== undefined ? `${stats.toolCalls} ${stats.toolCalls === 1 ? "tool" : "tools"}` : "",
    stats.subagents ? `${stats.subagents} ${stats.subagents === 1 ? "subagent" : "subagents"}` : "",
    stats.tokens ? `${formatTokens(stats.tokens)} tok` : "",
    stats.cost ? formatCost(stats.cost) : "",
  ];
}

/**
 * Pad cells column by column so values line up across rows; numeric-looking columns are right
 * aligned. Empty columns are dropped entirely.
 */
export function alignColumns(rows: readonly (readonly string[])[], separator = "  ", pad = " "): string[] {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_unused, column) =>
    Math.max(0, ...rows.map((row) => [...(row[column] ?? "")].length)),
  );
  const rightAligned = widths.map((_width, column) =>
    rows.every((row) => !row[column] || /^[$~]?[\d.,]+[a-zA-Z%]*(?:\s[\d.,]*[a-zA-Z]+)?$/u.test(row[column] ?? "")),
  );
  return rows.map((row) =>
    widths
      .map((width, column) => {
        if (width === 0) return undefined;
        const cell = row[column] ?? "";
        const padding = pad.repeat(width - [...cell].length);
        return rightAligned[column] ? padding + cell : cell + padding;
      })
      .filter((cell): cell is string => cell !== undefined)
      .join(separator)
      .replace(/[\s\u2800]+$/u, ""),
  );
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

export function plannerLabel(spec: ModelSpec) {
  return formatModelSpec(spec);
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
    if (entry?.type === "custom_message" && entry.customType === MULTI_TASK_MESSAGE_TYPE) {
      const text = textContent(entry.content);
      if (text) blocks.push(`User: ${text}`);
      continue;
    }
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

export function formatPlannerPrompt(
  task: string,
  transcript: string,
  plannerCount: number,
  scoutLabel?: string,
  researchTools: readonly string[] = [],
  mcpAllow?: readonly string[],
) {
  const others =
    plannerCount > 1 ? `${plannerCount - 1} other model${plannerCount > 2 ? "s are" : " is"}` : "Other models may be";
  return [
    `You are one of several independent planners. ${others} planning the same task in parallel without seeing your work; the user will compare the plans and pick one or combine them.`,
    "You are running non-interactively and nobody can answer questions. Do not call plan_mode_question. Resolve ambiguity by exploring the repository; when a real decision remains, choose the most reasonable option and record it under an explicit Assumptions section.",
    ...(researchTools.length > 0
      ? [
          `Research beyond the repository whenever outside knowledge matters (library and API docs, versions, known issues, prior art, notes) with ${researchTools.join(", ")}.`,
        ]
      : []),
    ...(researchTools.includes("mcp")
      ? [
          `Through the mcp tool you may call only these MCP tools (server/tool; * means every tool on that server): ${(mcpAllow ?? []).join(", ") || "none"}. Use mcp search or describe to see their arguments. MCP tools reach external services and some can change things; use them only to read.`,
        ]
      : []),
    ...(scoutLabel
      ? [
          `For broad or independent investigations, delegate to read-only subagents with plan_subagents (they run on ${scoutLabel}; give each a self-contained task and run independent ones in one call). Verify anything decisive yourself, and write the plan yourself.`,
        ]
      : []),
    "Finish by calling plan_mode_complete alone with the complete plan.",
    "",
    "## Task",
    "",
    task.trim() || "Plan the task discussed in the conversation below.",
    ...(transcript.trim() ? ["", "## Conversation so far", "", transcript.trim()] : []),
  ].join("\n");
}

export function formatSynthesisPrompt(candidates: readonly PlanCandidate[], guidance: string | undefined) {
  const trimmed = guidance?.trim();
  return [
    `Synthesize one implementation plan from the ${candidates.length} independent candidate plans below. Different models wrote them in parallel for the same task without seeing each other.`,
    "",
    `Guidance from the user: ${trimmed || "none. Use your judgment: pick the strongest candidate as the base and graft in the best ideas from the others."}`,
    "",
    "Before deciding, check claims where the candidates disagree against the repository. Resolve every disagreement explicitly, and use plan_mode_question when one needs the user's decision. Then call plan_mode_complete with the complete synthesized plan, not a diff against a candidate.",
    "",
    ...candidates.map(
      (candidate) =>
        `<candidate id="${candidate.id}" source="${escapeAttribute(candidate.label)}">\n${candidate.plan?.trim() ?? ""}\n</candidate>`,
    ),
  ].join("\n");
}

export function formatSelectedPlanMessage(candidate: PlanCandidate) {
  return `**Selected plan ${candidate.id} (${candidate.label})**\n\n${candidate.plan?.trim() ?? ""}`;
}

export function latestCandidateSet(entries: readonly unknown[]): CandidateSet | undefined {
  const branch = entries as BranchEntry[];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== CANDIDATES_ENTRY_TYPE) continue;
    return normalizeCandidateSet(entry.data);
  }
  return undefined;
}

export function normalizeCandidateSet(value: unknown): CandidateSet | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.task !== "string" || !Array.isArray(value.candidates)) {
    return undefined;
  }
  const candidates = value.candidates.flatMap((candidate): PlanCandidate[] => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.label !== "string") return [];
    const status = candidate.status;
    if (status !== "done" && status !== "failed" && status !== "cancelled" && status !== "timeout") return [];
    return [
      {
        id: candidate.id,
        label: candidate.label,
        origin: candidate.origin === "session" ? "session" : "planner",
        status,
        ...(isModel(candidate.model)
          ? { model: { provider: candidate.model.provider, modelId: candidate.model.modelId } }
          : {}),
        ...(typeof candidate.plan === "string" ? { plan: candidate.plan } : {}),
        ...(candidate.planFromText === true ? { planFromText: true } : {}),
        ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
        ...numberField("durationMs", candidate.durationMs),
        ...numberField("toolCalls", candidate.toolCalls),
        ...numberField("subagentTasks", candidate.subagentTasks),
        ...numberField("totalTokens", candidate.totalTokens),
        ...numberField("costUsd", candidate.costUsd),
      },
    ];
  });
  return {
    version: 1,
    task: value.task,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    candidates,
  };
}

function numberField<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as Record<Key, number>) : {};
}

function isModel(value: unknown): value is ImplementationModelOverride {
  return isRecord(value) && typeof value.provider === "string" && typeof value.modelId === "string";
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

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
