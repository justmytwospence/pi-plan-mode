import { basename } from "node:path";

/** One toggle in the planner picker that Jev can preselect. */
export interface ToolCapability {
  id: string;
  label: string;
  /** What the capability gives planners, in plain language; Jev reads this. */
  description: string;
  /** Preselection when Jev is unavailable. */
  fallbackSelected: boolean;
}

export type JevToolPick =
  | {
      kind: "jev";
      model: string;
      probabilities: Record<string, number>;
      selected: Record<string, boolean>;
    }
  | { kind: "fallback"; reason: string };

export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_THRESHOLD = 0.5;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_TASK_CHARS = 4_000;
const MAX_CONVERSATION_CHARS = 3_000;

type SdkModule = typeof import("@typesafe-ai/sdk");

export interface PickToolsInput {
  task: string;
  conversation: string;
  cwd: string;
  capabilities: readonly ToolCapability[];
  threshold?: number;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the lazy SDK import. */
  loadSdk?: () => Promise<SdkModule>;
}

const QUESTION =
  "Would AI agents writing an implementation plan for `task` materially benefit from having `capability` while they research it?";
const CRITERIA = {
  true: "The plan depends on information or checks this capability provides",
  false: "The plan can be researched well without it",
};

/**
 * Ask Jev (TypeSafe's System One model) which planner capabilities fit the task: one Noul per
 * capability in a single request. Every failure mode -- no API key, SDK missing, network error,
 * timeout, malformed answer -- resolves to `fallback` with a short reason, never throws.
 */
export async function pickToolsWithJev(input: PickToolsInput): Promise<JevToolPick> {
  const env = input.env ?? process.env;
  if (input.capabilities.length === 0) return { kind: "fallback", reason: "no tools to choose" };
  if (!env.TYPESAFE_API_KEY?.trim()) return { kind: "fallback", reason: "TYPESAFE_API_KEY is not set" };
  const task = input.task.trim();
  const conversation = input.conversation.trim();
  if (!task && !conversation) return { kind: "fallback", reason: "no task to judge" };

  let sdk: SdkModule;
  try {
    sdk = await (input.loadSdk ?? (() => import("@typesafe-ai/sdk")))();
  } catch {
    return { kind: "fallback", reason: "the TypeSafe SDK is not installed (run npm ci in the plugin)" };
  }

  const model = input.model?.trim() || DEFAULT_JEV_MODEL;
  const threshold = input.threshold ?? DEFAULT_JEV_THRESHOLD;
  const questions = Object.fromEntries(
    input.capabilities.map((capability, index) => [
      `c${index}`,
      sdk.noul(
        { capability: { name: capability.label, provides: capability.description }, question: QUESTION },
        CRITERIA,
      ),
    ]),
  );
  const state = {
    task: task ? clip(task, MAX_TASK_CHARS) : "Plan the task discussed in `conversation`.",
    ...(conversation ? { conversation: clipTail(conversation, MAX_CONVERSATION_CHARS) } : {}),
    working_directory: basename(input.cwd) || input.cwd,
  };

  try {
    const client = new sdk.TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY.trim(), logLevel: "off" });
    const response = await client.systemOne(
      { state, questions, model },
      {
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retry: { maxRetries: 1 },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const probabilities: Record<string, number> = {};
    const selected: Record<string, boolean> = {};
    for (const [index, capability] of input.capabilities.entries()) {
      const answer = (response.answers as Record<string, { noul?: unknown } | undefined>)[`c${index}`];
      const value = answer?.noul;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        return { kind: "fallback", reason: "Jev returned an unexpected answer" };
      }
      probabilities[capability.id] = value;
      selected[capability.id] = value >= threshold;
    }
    return { kind: "jev", model: typeof response.model === "string" ? response.model : model, probabilities, selected };
  } catch (error: unknown) {
    return { kind: "fallback", reason: `Jev is unavailable (${describeError(error)})` };
  }
}

function describeError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") return status === 401 ? "invalid API key" : `HTTP ${status}`;
  if (/Timeout/u.test(name)) return "timed out";
  if (/Abort/u.test(name)) return "cancelled";
  if (/Connection/u.test(name)) return "no connection";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 120) || "unknown error";
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clipTail(text: string, max: number) {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}
