// Pi's built-in commands that matter for a planner, typed in its lane: they act on that planner's
// own session (its model, effort, context, login), since a planner has no editor of its own.
import type { ModelSpec } from "./implementation-models.js";

type Level = NonNullable<ModelSpec["thinkingLevel"]>;
type Tone = "info" | "warning" | "error";

export interface LaneCommand {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
}

export const LANE_COMMANDS: LaneCommand[] = [
  {
    name: "login",
    args: "[provider]",
    description: "log in again (its provider by default); a failed planner retries",
  },
  { name: "model", args: "[query]", description: "switch its model; no query lists them" },
  { name: "thinking", aliases: ["effort"], args: "[level]", description: "change its effort" },
  { name: "compact", args: "[instructions]", description: "compact its context" },
  { name: "context", aliases: ["usage"], description: "context window, tokens and cost" },
  { name: "copy", description: "copy its last reply (or its plan) to the clipboard" },
  { name: "help", description: "list these commands" },
];

/** The planner a command acts on. */
export interface LaneCommandAgent {
  id: string;
  spec: ModelSpec;
  name: string;
  working: boolean;
  status: string;
  plan: string | undefined;
  lastReply: string;
  stats: { totalTokens: number; costUsd: number };
  note(text: string, tone?: Tone): void;
  switchModel(spec: ModelSpec, name: string): Promise<void>;
  setEffort(level: Level | undefined): void;
  compact(instructions?: string): Promise<void>;
  contextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

export interface LaneCommandHost {
  /** Models you can switch to, with display names. */
  models(): Array<{ spec: ModelSpec; name: string }>;
  /** Effort levels a model accepts (empty: it does not think). */
  efforts(spec: ModelSpec): Level[];
  login(agent: LaneCommandAgent, provider: string): void;
  copy(text: string): Promise<void>;
}

/** Commands whose name (or alias) starts with what you typed after the slash. */
export function matchingCommands(input: string): LaneCommand[] {
  const typed = input.trim().slice(1).split(/\s+/u)[0]?.toLowerCase() ?? "";
  return LANE_COMMANDS.filter((command) =>
    [command.name, ...(command.aliases ?? [])].some((name) => name.startsWith(typed)),
  );
}

/** Run `input` if it is a command; false when it is an ordinary message for the planner. */
export async function runLaneCommand(input: string, agent: LaneCommandAgent, host: LaneCommandHost): Promise<boolean> {
  const text = input.trim();
  if (!text.startsWith("/") || text.startsWith("//")) return false;
  const [head = "", ...rest] = text.slice(1).split(/\s+/u);
  const arg = rest.join(" ").trim();
  const command = LANE_COMMANDS.find((candidate) =>
    [candidate.name, ...(candidate.aliases ?? [])].includes(head.toLowerCase()),
  );
  try {
    switch (command?.name) {
      case "login":
        host.login(agent, arg || agent.spec.provider);
        return true;
      case "model":
        await model(arg, agent, host);
        return true;
      case "thinking":
        effort(arg, agent, host);
        return true;
      case "compact":
        if (busy(agent)) return true;
        await agent.compact(arg || undefined);
        return true;
      case "context":
        context(agent);
        return true;
      case "copy": {
        const copied = agent.lastReply.trim() || agent.plan?.trim();
        if (!copied) agent.note("Nothing to copy yet.", "warning");
        else {
          await host.copy(copied);
          agent.note(agent.lastReply.trim() ? "Copied its last reply." : "Copied its plan.");
        }
        return true;
      }
      case "help":
        agent.note(help());
        return true;
      default:
        agent.note(`Unknown command /${head}. ${help()}`, "warning");
        return true;
    }
  } catch (error: unknown) {
    agent.note(`/${head} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return true;
  }
}

function help() {
  return `Commands: ${LANE_COMMANDS.map((command) => `/${command.name}${command.args ? ` ${command.args}` : ""}`).join(", ")}. Start with // to send a message that begins with a slash.`;
}

function busy(agent: LaneCommandAgent) {
  if (!agent.working) return false;
  agent.note(`${agent.id} is working; wait for it to finish (or stop it with esc) first.`, "warning");
  return true;
}

async function model(query: string, agent: LaneCommandAgent, host: LaneCommandHost) {
  const models = host.models();
  const label = (entry: { spec: ModelSpec; name: string }) =>
    `${entry.name} (${entry.spec.provider}/${entry.spec.modelId})`;
  if (!query) {
    agent.note(
      `Model: ${agent.name}. Switch with /model <query>, e.g. ${models
        .slice(0, 6)
        .map((entry) => entry.spec.modelId)
        .join(", ")}${models.length > 6 ? ", …" : ""}.`,
    );
    return;
  }
  if (busy(agent)) return;
  const q = query.toLowerCase();
  const key = (entry: { spec: ModelSpec }) => `${entry.spec.provider}/${entry.spec.modelId}`.toLowerCase();
  const exact = models.filter(
    (entry) => key(entry) === q || entry.spec.modelId.toLowerCase() === q || entry.name.toLowerCase() === q,
  );
  const words = q.split(/\s+/u);
  const loose = models.filter((entry) => {
    const haystack = `${key(entry)} ${entry.name.toLowerCase()}`;
    return words.every((word) => haystack.includes(word));
  });
  const found = exact.length > 0 ? exact : loose;
  if (found.length === 0) {
    agent.note(`No model matches "${query}".`, "warning");
    return;
  }
  if (found.length > 1) {
    agent.note(
      `"${query}" matches ${found.length}: ${found.slice(0, 8).map(label).join(", ")}. Be more specific.`,
      "warning",
    );
    return;
  }
  const chosen = found[0] as { spec: ModelSpec; name: string };
  const levels = host.efforts(chosen.spec);
  const current = agent.spec.thinkingLevel;
  const spec: ModelSpec = {
    provider: chosen.spec.provider,
    modelId: chosen.spec.modelId,
    ...(current && levels.includes(current) ? { thinkingLevel: current } : {}),
  };
  await agent.switchModel(spec, chosen.name);
}

function effort(arg: string, agent: LaneCommandAgent, host: LaneCommandHost) {
  const levels = host.efforts(agent.spec);
  if (levels.length === 0) {
    agent.note(`${agent.name} has no effort levels.`, "warning");
    return;
  }
  if (!arg) {
    agent.note(`Effort: ${agent.spec.thinkingLevel ?? "model default"}. Levels: ${levels.join(", ")}.`);
    return;
  }
  if (busy(agent)) return;
  const level = levels.find((candidate) => candidate === arg.toLowerCase());
  if (!level) {
    agent.note(`${agent.name} takes ${levels.join(", ")}.`, "warning");
    return;
  }
  agent.setEffort(level);
}

function context(agent: LaneCommandAgent) {
  const usage = agent.contextUsage();
  const window = usage
    ? usage.tokens === null
      ? `context unknown until its next reply (window ${format(usage.contextWindow)})`
      : `context ${format(usage.tokens)} of ${format(usage.contextWindow)}${usage.percent === null ? "" : ` (${Math.round(usage.percent)}%)`}`
    : "context unknown (no session yet)";
  agent.note(`${window} · ${format(agent.stats.totalTokens)} tokens used · $${agent.stats.costUsd.toFixed(2)}`);
}

function format(tokens: number) {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}k`
      : String(tokens);
}
