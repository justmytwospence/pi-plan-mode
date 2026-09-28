import { formatModelSpec, type ImplementationModelOverride, type ModelSpec } from "./implementation-models.js";

export const PLANNER_ENV = "PI_PLAN_MODE_PLANNER";
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
  const parts: string[] = [];
  if (candidate.status !== "done") parts.push(candidate.status);
  if (candidate.durationMs !== undefined) parts.push(formatDuration(candidate.durationMs));
  if (candidate.toolCalls !== undefined) parts.push(`${candidate.toolCalls} tool calls`);
  if (candidate.totalTokens) parts.push(`${formatTokens(candidate.totalTokens)} tokens`);
  if (candidate.costUsd) parts.push(`$${candidate.costUsd.toFixed(2)}`);
  if (candidate.planFromText) parts.push("plan taken from prose");
  return parts.join(" · ");
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatTokens(tokens: number) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
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

export function formatPlannerPrompt(task: string, transcript: string, plannerCount: number) {
  const others =
    plannerCount > 1 ? `${plannerCount - 1} other model${plannerCount > 2 ? "s are" : " is"}` : "Other models may be";
  return [
    `You are one of several independent planners. ${others} planning the same task in parallel without seeing your work; the user will compare the plans and pick one or combine them.`,
    "You are running non-interactively and nobody can answer questions. Do not call plan_mode_question. Resolve ambiguity by exploring the repository; when a real decision remains, choose the most reasonable option and record it under an explicit Assumptions section.",
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
