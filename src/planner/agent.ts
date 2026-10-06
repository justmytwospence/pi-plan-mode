// One planner: an in-process Pi session you can watch, talk to, and answer, from the planning
// screen. The same class serves `/plan` with one planner and with two; nothing about it depends on
// how many there are.
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelSpec, type ModelSpec } from "../implementation-models.js";
import { describeToolArgs, PlannerTrace } from "../planner-trace.js";
import { buildPlannerConversation, buildPlannerTranscript } from "../planners.js";
import type { PlanModeQuestion, PlanModeQuestionAnswer } from "../question-tool.js";
import { PLAN_SUBAGENTS_TOOL_NAME } from "../scout-process.js";
import { SubagentTracker } from "../subagent-progress.js";
import { type PlannerPolicy, plannerExtension } from "./extension.js";
import {
  createPlannerSession,
  type PlannerSessionFactory,
  type PlannerSessionHandle,
  readSessionEntries,
} from "./session.js";

/** Fraction of the time limit after which a working planner is asked to wrap up. */
export const SOFT_DEADLINE_FRACTION = 0.8;
export const WRAP_UP_MESSAGE =
  "Time is almost up. Stop investigating now and call plan_mode_complete alone with your best complete plan. Record anything you could not verify as explicit assumptions or open questions in the plan.";

export type PlannerStatus =
  /** Creating its session. */
  | "starting"
  /** Working on a turn. */
  | "working"
  /** Waiting for you to answer its questions. */
  | "asking"
  /** Idle: its turn ended (with or without a plan). */
  | "idle"
  | "failed"
  | "stopped";

export interface PendingQuestions {
  questions: PlanModeQuestion[];
  /** Your answers, or undefined to skip them. */
  resolve(answers: PlanModeQuestionAnswer[] | undefined): void;
}

export interface PlannerStats {
  startedAt: number;
  /** When the current turn ended; undefined while working. */
  endedAt?: number;
  toolCalls: number;
  subagentTasks: number;
  totalTokens: number;
  costUsd: number;
  lastActivity?: string;
  wrappingUp?: boolean;
}

export interface PlannerAccessConfig {
  tools: string[];
  extensions: string[];
  skills: string[];
  policy: Omit<PlannerPolicy, "ask" | "onPlan">;
  /** Appended to the planner's system prompt. */
  systemPrompt: string[];
}

export interface PlannerAgentOptions {
  /** `A` or `B`. */
  id: string;
  spec: ModelSpec;
  /** Display name, e.g. `Claude Fable 5.1`. */
  name: string;
  cwd: string;
  access: PlannerAccessConfig;
  /** Per turn: at 80% the planner is asked to wrap up, at the limit it is stopped. */
  timeoutMs: number;
  /** Where new planner sessions are stored. */
  sessionDir: string;
  /** Messages of your conversation, so the planner starts with your context. */
  seed: readonly unknown[];
  /** Continue this session file instead of starting a new one (after a reload). */
  sessionFile?: string;
  /** A plan already submitted earlier (restored runs). */
  plan?: string;
  revision?: number;
  onChange(): void;
  createSession?: PlannerSessionFactory;
}

export class PlannerAgent {
  readonly id: string;
  readonly spec: ModelSpec;
  readonly name: string;
  readonly trace = new PlannerTrace();
  readonly subagents: SubagentTracker;
  status: PlannerStatus = "starting";
  stats: PlannerStats = { startedAt: Date.now(), toolCalls: 0, subagentTasks: 0, totalTokens: 0, costUsd: 0 };
  /** The latest plan it submitted. */
  plan: string | undefined;
  /** How many times it has submitted a plan (A v2, A v3, …). */
  revision = 0;
  /** Its last reply text, shown while it has no plan yet. */
  lastReply = "";
  error: string | undefined;
  pending: PendingQuestions | undefined;
  sessionFile: string | undefined;

  private handle: PlannerSessionHandle | undefined;
  private opening: Promise<PlannerSessionHandle | undefined> | undefined;
  private unsubscribe: (() => void) | undefined;
  private softTimer: ReturnType<typeof setTimeout> | undefined;
  private hardTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Called when the current turn settles (or fails): consult() waits on them. */
  private settleWaiters: Array<() => void> = [];

  constructor(private readonly options: PlannerAgentOptions) {
    this.id = options.id;
    this.spec = options.spec;
    this.name = options.name;
    this.subagents = new SubagentTracker(options.id);
    this.sessionFile = options.sessionFile;
    if (options.plan) {
      this.plan = options.plan;
      this.revision = options.revision ?? 1;
      this.status = "idle";
      this.stats.endedAt = this.stats.startedAt;
      this.trace.note(`Plan ${this.id}${this.revision > 1 ? ` v${this.revision}` : ""} restored.`);
    } else if (options.sessionFile) {
      // Restored without a plan (e.g. mid-conversation): it waits for you, not starting.
      this.status = "idle";
      this.stats.endedAt = this.stats.startedAt;
      this.trace.note(`${this.id} restored.`);
    }
  }

  get access() {
    return this.options.access;
  }

  /** `anthropic/claude-fable-5-1:xhigh` */
  get label() {
    return formatModelSpec(this.spec);
  }

  get working() {
    return this.status === "starting" || this.status === "working" || this.status === "asking";
  }

  /** Start planning with `prompt` (the task and how to work). */
  async start(prompt: string, host: ExtensionContext) {
    const handle = await this.open(host);
    if (!handle) return;
    this.send(prompt);
  }

  /**
   * Say something to the planner: steers a working turn, or starts a new one. `shown` is what the
   * trace shows when the message carries more than you typed; `from` names who said it when it was
   * not you (e.g. your main agent).
   */
  async say(text: string, host: ExtensionContext, shown?: string, from?: string) {
    const message = text.trim();
    if (!message || this.disposed) return;
    this.trace.user(shown?.trim() || message, from);
    this.changed();
    const handle = await this.open(host);
    if (!handle) return;
    if (handle.session.isStreaming) {
      void handle.session.steer(message).catch((error: unknown) => this.fail(error));
      return;
    }
    this.send(message);
  }

  /**
   * Ask the idle planner something and wait for its turn to end: its reply, and whether it
   * resubmitted its plan. `from` labels the message in its lane (e.g. "main agent"), which shows
   * `shown` (the question without the framing the planner gets).
   */
  async consult(
    message: string,
    host: ExtensionContext,
    from: string,
    signal?: AbortSignal,
    shown?: string,
  ): Promise<{ reply: string; revised: boolean; error?: string }> {
    if (this.disposed) return { reply: "", revised: false, error: "the planner is closed" };
    const before = this.revision;
    this.lastReply = "";
    const settled = new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await this.say(message, host, shown ?? message, from);
    await settled;
    return {
      reply: this.lastReply,
      revised: this.revision > before,
      ...(this.status === "failed" && this.error ? { error: this.error } : {}),
    };
  }

  /**
   * What you and this planner said to each other (no tool output) since `since`, an entry count an
   * earlier call returned; from 0, it starts after the planner's task. `mark` is where to pick up.
   */
  conversation(since = 0): { text: string; mark: number } {
    let entries: readonly unknown[] = [];
    try {
      entries =
        this.handle?.entries?.() ?? (this.sessionFile ? readSessionEntries(this.sessionFile, this.options.cwd) : []);
    } catch {
      return { text: "", mark: since };
    }
    const skipUser = (text: string) => text === WRAP_UP_MESSAGE;
    const text =
      since === 0
        ? buildPlannerConversation(entries, this.id, { skipUser })
        : buildPlannerTranscript(entries.slice(since), undefined, `Planner ${this.id}`, skipUser);
    return { text, mark: entries.length };
  }

  /** Answer the pending questions (or skip them with undefined). */
  answer(answers: PlanModeQuestionAnswer[] | undefined) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (this.status === "asking") this.status = "working";
    this.trace.note(answers ? `Answered: ${answers.map((answer) => answer.answer).join(" · ")}` : "Questions skipped.");
    pending.resolve(answers);
    this.changed();
  }

  /** Stop the current turn (the session stays, so you can keep talking). */
  async stop() {
    this.pending?.resolve(undefined);
    this.pending = undefined;
    if (!this.handle?.session.isStreaming) return;
    this.trace.note("Stopped by you.", "warning");
    try {
      await this.handle.session.abort();
    } catch {
      // Already idle.
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.settle();
    this.clearTimers();
    this.pending?.resolve(undefined);
    this.pending = undefined;
    this.unsubscribe?.();
    try {
      this.handle?.dispose();
    } catch {
      // Already gone.
    }
    this.handle = undefined;
    if (this.working) this.status = "stopped";
  }

  private open(host: ExtensionContext) {
    if (this.handle) return Promise.resolve(this.handle);
    this.opening ??= this.create(host);
    return this.opening;
  }

  private async create(host: ExtensionContext) {
    this.status = "starting";
    this.stats = { ...this.stats, startedAt: Date.now(), endedAt: undefined };
    this.changed();
    const factory = this.options.createSession ?? createPlannerSession;
    try {
      const policy: PlannerPolicy = {
        ...this.options.access.policy,
        ask: (questions, signal) => this.ask(questions, signal),
        onPlan: (plan) => {
          this.plan = plan;
          this.revision += 1;
          this.stats.lastActivity = "submitted plan";
          this.trace.note(`Plan ${this.id}${this.revision > 1 ? ` v${this.revision}` : ""} submitted.`);
          this.changed();
        },
      };
      const handle = await factory(host, {
        cwd: this.options.cwd,
        spec: this.spec,
        tools: this.options.access.tools,
        extensions: this.options.access.extensions,
        skills: this.options.access.skills,
        policy: plannerExtension(policy),
        appendSystemPrompt: this.options.access.systemPrompt,
        storage: this.sessionFile
          ? { kind: "open", file: this.sessionFile }
          : { kind: "new", dir: this.options.sessionDir, seed: this.options.seed },
      });
      if (this.disposed) {
        handle.dispose();
        return undefined;
      }
      this.handle = handle;
      this.sessionFile = handle.file ?? this.sessionFile;
      this.unsubscribe = handle.subscribe((event) => this.onEvent(event));
      this.status = "idle";
      this.changed();
      return handle;
    } catch (error: unknown) {
      this.opening = undefined;
      this.fail(error);
      return undefined;
    }
  }

  private send(message: string) {
    const session = this.handle?.session;
    if (!session) return;
    this.beginTurn();
    session.prompt(message, { expandPromptTemplates: false }).catch((error: unknown) => this.fail(error));
  }

  private ask(questions: PlanModeQuestion[], signal: AbortSignal | undefined) {
    return new Promise<PlanModeQuestionAnswer[] | undefined>((resolve) => {
      const done = (answers: PlanModeQuestionAnswer[] | undefined) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(answers);
      };
      const onAbort = () => {
        if (this.pending?.resolve === done) this.pending = undefined;
        done(undefined);
        this.changed();
      };
      if (signal?.aborted) return done(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = { questions, resolve: done };
      this.status = "asking";
      // The clock stops while it waits for you.
      this.clearTimers();
      this.stats.lastActivity = "asking you";
      this.changed();
    });
  }

  private beginTurn() {
    this.status = "working";
    this.error = undefined;
    this.stats = {
      ...this.stats,
      startedAt: Date.now(),
      endedAt: undefined,
      wrappingUp: false,
      lastActivity: "thinking",
    };
    this.armTimers();
    this.changed();
  }

  private armTimers() {
    this.clearTimers();
    const limit = this.options.timeoutMs;
    if (!(limit > 0)) return;
    this.softTimer = setTimeout(
      () => {
        const session = this.handle?.session;
        if (!session?.isStreaming) return;
        this.stats.wrappingUp = true;
        this.stats.lastActivity = "asked to wrap up";
        this.trace.note("Time is almost up: asked the planner to finish now.", "warning");
        void session.steer(WRAP_UP_MESSAGE).catch(() => undefined);
        this.changed();
      },
      Math.max(1, Math.floor(limit * SOFT_DEADLINE_FRACTION)),
    );
    this.hardTimer = setTimeout(() => {
      if (!this.handle?.session.isStreaming) return;
      this.trace.note(`Stopped at the ${Math.round(limit / 60_000)} min limit.`, "warning");
      void this.handle.session.abort().catch(() => undefined);
    }, limit);
    this.softTimer.unref?.();
    this.hardTimer.unref?.();
  }

  private clearTimers() {
    if (this.softTimer) clearTimeout(this.softTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.softTimer = undefined;
    this.hardTimer = undefined;
  }

  private onEvent(event: AgentSessionEvent) {
    const record = event as unknown as Record<string, unknown>;
    if (record.type === "tool_execution_update" && record.toolName === PLAN_SUBAGENTS_TOOL_NAME) {
      const partial = isRecord(record.partialResult) ? record.partialResult : undefined;
      if (this.subagents.apply(String(record.toolCallId ?? "call"), partial?.details)) this.changed();
      return;
    }
    this.trace.apply(record);
    switch (record.type) {
      case "agent_start":
        if (this.status !== "asking") this.status = "working";
        break;
      case "tool_execution_start": {
        const name = typeof record.toolName === "string" ? record.toolName : "tool";
        this.stats.toolCalls += 1;
        this.stats.lastActivity = describeToolArgs(name, record.args);
        if (name === PLAN_SUBAGENTS_TOOL_NAME && isRecord(record.args) && Array.isArray(record.args.tasks)) {
          this.stats.subagentTasks += record.args.tasks.length;
        }
        break;
      }
      case "tool_execution_end": {
        if (record.toolName === PLAN_SUBAGENTS_TOOL_NAME && typeof record.toolCallId === "string") {
          this.subagents.finish(record.toolCallId, false);
        }
        const result = isRecord(record.result) ? record.result : undefined;
        if (result && isRecord(result.usage)) this.addUsage(result.usage);
        break;
      }
      case "message_update": {
        const update = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
        const activity =
          update?.type === "thinking_delta" ? "thinking" : update?.type === "text_delta" ? "writing" : undefined;
        if (activity && !this.stats.wrappingUp) this.stats.lastActivity = activity;
        break;
      }
      case "message_end": {
        const message = isRecord(record.message) ? record.message : undefined;
        if (message?.role !== "assistant") break;
        if (isRecord(message.usage)) this.addUsage(message.usage);
        const text = assistantText(message.content);
        if (text) this.lastReply = text;
        if (message.stopReason === "error") {
          this.error = typeof message.errorMessage === "string" ? message.errorMessage : "Model error.";
        }
        break;
      }
      case "agent_settled":
        this.clearTimers();
        if (this.status !== "asking") this.status = this.error && !this.plan ? "failed" : "idle";
        this.stats.endedAt = Date.now();
        this.stats.lastActivity = this.plan ? "plan ready" : this.error ? "failed" : "waiting for you";
        this.settle();
        break;
      default:
        break;
    }
    this.changed();
  }

  private addUsage(usage: Record<string, unknown>) {
    this.stats.totalTokens += typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
    const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
    this.stats.costUsd += typeof cost === "number" ? cost : 0;
  }

  private fail(error: unknown) {
    this.clearTimers();
    this.error = error instanceof Error ? error.message : String(error);
    this.status = "failed";
    this.stats.endedAt = Date.now();
    this.trace.note(`Failed: ${this.error}`, "error");
    this.changed();
    this.settle();
  }

  private settle() {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private changed() {
    try {
      this.options.onChange();
    } catch {
      // Rendering must never break a planner.
    }
  }
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
