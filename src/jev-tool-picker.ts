import { basename } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

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

export const DEFAULT_JEV_PROVIDER = "typesafe";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_THRESHOLD = 0.5;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_TASK_CHARS = 4_000;
const MAX_CONVERSATION_CHARS = 3_000;

/** The part of Pi's model registry the picker uses: its classifier models. */
export type ClassifierRegistry = Pick<ModelRegistry, "findOfType" | "classify">;

export interface PickToolsInput {
  task: string;
  conversation: string;
  cwd: string;
  capabilities: readonly ToolCapability[];
  /** Pi's model registry (`ctx.modelRegistry`); Jev runs through it with Pi's credentials. */
  registry: ClassifierRegistry;
  threshold?: number;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const CRITERIA = {
  true: "The plan depends on information or checks this capability provides",
  false: "The plan can be researched well without it",
};

function question(capability: ToolCapability) {
  return (
    `Capability "${capability.label}" gives the agents: ${capability.description}. ` +
    "Would AI agents writing an implementation plan for `task` materially benefit from having this capability while they research it?"
  );
}

/**
 * Ask Jev (TypeSafe's System One model) which planner capabilities fit the task: one bool question
 * per capability in a single request, through Pi's classifier models. Every failure mode -- no
 * classifier, no credentials, network error, timeout, malformed answer -- resolves to `fallback`
 * with a short reason, never throws.
 */
export async function pickToolsWithJev(input: PickToolsInput): Promise<JevToolPick> {
  if (input.capabilities.length === 0) return { kind: "fallback", reason: "no tools to choose" };
  const task = input.task.trim();
  const conversation = input.conversation.trim();
  if (!task && !conversation) return { kind: "fallback", reason: "no task to judge" };

  const provider = input.provider?.trim() || DEFAULT_JEV_PROVIDER;
  const modelId = input.model?.trim() || DEFAULT_JEV_MODEL;
  let model: ReturnType<ClassifierRegistry["findOfType"]>;
  try {
    model = input.registry.findOfType("classifier", provider, modelId);
  } catch {
    model = undefined;
  }
  if (!model) return { kind: "fallback", reason: `no classifier model ${provider}/${modelId}` };

  const threshold = input.threshold ?? DEFAULT_JEV_THRESHOLD;
  const questions = Object.fromEntries(
    input.capabilities.map((capability, index) => [
      `c${index}`,
      { type: "bool" as const, instructions: question(capability), criteria: CRITERIA },
    ]),
  );
  const state = {
    task: task ? clip(task, MAX_TASK_CHARS) : "Plan the task discussed in `conversation`.",
    ...(conversation ? { conversation: clipTail(conversation, MAX_CONVERSATION_CHARS) } : {}),
    working_directory: basename(input.cwd) || input.cwd,
  };

  try {
    const result = await input.registry.classify(
      model,
      { state, questions },
      { timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(input.signal ? { signal: input.signal } : {}) },
    );
    if (result.stopReason !== "stop") {
      return {
        kind: "fallback",
        reason: `Jev is unavailable (${describeError(result.stopReason, result.errorMessage)})`,
      };
    }
    const probabilities: Record<string, number> = {};
    const selected: Record<string, boolean> = {};
    for (const [index, capability] of input.capabilities.entries()) {
      const answer = result.answers[`c${index}`];
      const value = answer?.type === "bool" ? answer.probability : undefined;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        return { kind: "fallback", reason: "Jev returned an unexpected answer" };
      }
      probabilities[capability.id] = value;
      selected[capability.id] = value >= threshold;
    }
    return { kind: "jev", model: result.model || modelId, probabilities, selected };
  } catch (error: unknown) {
    return {
      kind: "fallback",
      reason: `Jev is unavailable (${describeError("error", error instanceof Error ? error.message : String(error))})`,
    };
  }
}

function describeError(stopReason: string, message: string | undefined) {
  if (stopReason === "aborted") return "cancelled";
  const text = (message ?? "").replace(/\s+/gu, " ");
  if (/No API key/iu.test(text)) return "no TypeSafe credentials";
  if (/\b401\b|unauthori[sz]ed/iu.test(text)) return "invalid API key";
  if (/timed out|timeout/iu.test(text)) return "timed out";
  return text.slice(0, 120) || "unknown error";
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clipTail(text: string, max: number) {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}
