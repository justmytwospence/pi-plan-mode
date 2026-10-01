/**
 * Talking to planners after they submitted their plans. While talk mode is on, what you type in
 * the prompt editor goes to one planner, or to several at once, (each resuming its own Pi session,
 * so it keeps everything it read) instead of the main model. Each reply, and any revised plan,
 * appears in the chat and updates that candidate (A becomes A v2). Planners reply in parallel.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { holdWorking } from "./herdr-blocked.js";
import type { ModelSpec } from "./implementation-models.js";
import {
  type CandidateSet,
  canTalkToPlanner,
  formatCost,
  formatDuration,
  formatPlannerFollowUp,
  formatTokens,
  PLANNER_TALK_MESSAGE_TYPE,
  type PlanCandidate,
} from "./multi-plan.js";
import { type PlannerProgress, type PlannerRunOptions, type PlannerTurnResult, runPlanner } from "./planner-process.js";
import type { SubagentView } from "./subagent-progress.js";
import type { TracePane } from "./trace-view.js";
import { labeledRule, spinner } from "./ui-kit.js";

const WIDGET_KEY = "plan-mode-planner-talk";

export interface TalkMessageDetails {
  role: "user" | "planner";
  candidate: string;
  name: string;
  /** Planner replies: the plan revision this reply produced. */
  revision?: number;
  /** Planner replies that revised the plan: the new plan. */
  plan?: string;
  status?: PlanCandidate["status"];
  error?: string;
  stats?: { durationMs: number; toolCalls: number; totalTokens: number; costUsd: number };
}

export interface PlannerTalkDeps {
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
  extensionPath: string;
  loadUserExtensions(): boolean;
  timeoutMs(): number;
  /** The newest candidate set in the current branch. */
  latestSet(ctx: ExtensionContext): CandidateSet | undefined;
  /** Persist an updated set (a new entry; the newest one wins). */
  saveSet(set: CandidateSet): void;
  /** Friendly model name and effort for a spec string. */
  describeModel(ctx: ExtensionContext, spec: string): { name: string; effort?: string };
  /** The monitor pane for a candidate, created when the run's traces are gone (e.g. after a restart). */
  pane(ctx: ExtensionContext, set: CandidateSet, candidate: PlanCandidate): TracePane;
  /** pi's event bus: a replying planner holds herdr working. */
  events?: { emit(channel: string, data: unknown): void };
  /** Test seam. */
  runPlanner?: (options: PlannerRunOptions) => Promise<PlannerTurnResult>;
}

interface Turn {
  setCreatedAt: number;
  id: string;
  name: string;
  controller: AbortController;
  progress?: PlannerProgress;
}

interface TalkTarget {
  setCreatedAt: number;
  members: Array<{ id: string; name: string }>;
}

export class PlannerTalk {
  private target: TalkTarget | undefined;
  private readonly turns = new Map<string, Turn>();
  private widgetRender: (() => void) | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: PlannerTalkDeps) {}

  get active() {
    return this.target !== undefined;
  }

  /** `A`, or `A + B` when talking to several planners. */
  get targetId() {
    return this.target ? memberIds(this.target) : undefined;
  }

  /** Whether you can talk to this candidate: a planner whose session was kept. */
  static canTalk(candidate: PlanCandidate) {
    return canTalkToPlanner(candidate);
  }

  /** Talk to one planner, or to several at once (each gets every message and replies on its own). */
  start(ctx: ExtensionContext, set: CandidateSet, ids: string | readonly string[]) {
    const wanted = typeof ids === "string" ? [ids] : [...new Set(ids)];
    const members: TalkTarget["members"] = [];
    for (const id of wanted) {
      const candidate = set.candidates.find((entry) => entry.id === id);
      if (!candidate || !PlannerTalk.canTalk(candidate)) {
        ctx.ui.notify(
          candidate?.origin === "session"
            ? `${id} is this session's own plan; talk to the main model with /plan talk off.`
            : `Planner ${id} cannot be resumed (it ran before planner sessions were kept). Start a new /plan multi to talk to its planners.`,
          "warning",
        );
        return false;
      }
      members.push({ id, name: this.deps.describeModel(ctx, candidate.label).name });
    }
    if (members.length === 0) return false;
    this.target = { setCreatedAt: set.createdAt, members };
    this.refreshWidget(ctx);
    const who =
      members.length === 1
        ? `planner ${members[0]?.id} (${members[0]?.name})`
        : `planners ${memberIds(this.target)}; each gets every message and replies on its own`;
    ctx.ui.notify(
      `Now talking to ${who}. Your messages go to ${members.length === 1 ? "it" : "them"}, not the main model; /plan talk off to switch back.`,
      "info",
    );
    return true;
  }

  stop(ctx: ExtensionContext, quiet = false) {
    if (!this.target) return;
    const who = this.target.members.length === 1 ? "planner" : "planners";
    const ids = memberIds(this.target);
    this.target = undefined;
    this.refreshWidget(ctx);
    if (!quiet) ctx.ui.notify(`Stopped talking to ${who} ${ids}; messages go to the main model again.`, "info");
  }

  /** Stop every planner that is still replying. */
  cancel(ctx: ExtensionContext) {
    const count = this.turns.size;
    for (const turn of this.turns.values()) turn.controller.abort(new DOMException("Cancelled", "AbortError"));
    ctx.ui.notify(
      count ? `Stopping ${count} planner repl${count === 1 ? "y" : "ies"}.` : "No planner is replying.",
      "info",
    );
  }

  /** Forget talk mode (new session, new run); replies still running finish in the background. */
  reset(ctx?: ExtensionContext) {
    this.target = undefined;
    if (ctx) this.refreshWidget(ctx);
  }

  /** Route a message you typed to the planner(s) you are talking to. */
  send(ctx: ExtensionContext, text: string) {
    const target = this.target;
    if (!target) return;
    const set = this.deps.latestSet(ctx);
    const candidates = target.members.map((member) =>
      set?.createdAt === target.setCreatedAt ? set.candidates.find((c) => c.id === member.id) : undefined,
    );
    if (
      !set ||
      candidates.some(
        (candidate) => !candidate || !PlannerTalk.canTalk(candidate) || !candidate.model || !candidate.session,
      )
    ) {
      this.stop(ctx, true);
      ctx.ui.notify(
        `Planner ${memberIds(target)} is no longer in this branch's latest plans; talk mode is off.`,
        "warning",
      );
      return;
    }
    const busy = target.members.filter((member) => this.turns.has(`${set.createdAt}:${member.id}`));
    if (busy.length > 0) {
      // Keep what you wrote; one message at a time per planner, and everyone gets the same one.
      try {
        ctx.ui.setEditorText(text);
      } catch {
        // No editor (RPC).
      }
      ctx.ui.notify(
        `${busy.map((member) => member.id).join(" + ")} ${busy.length === 1 ? "is" : "are"} still replying to your last message. Send this when ${busy.length === 1 ? "it finishes" : "they finish"}.`,
        "warning",
      );
      return;
    }
    this.deps.pi.sendMessage<TalkMessageDetails>(
      {
        customType: PLANNER_TALK_MESSAGE_TYPE,
        content: text,
        display: true,
        details: {
          role: "user",
          candidate: memberIds(target),
          name: target.members.map((member) => member.name).join(" + "),
        },
      },
      { triggerTurn: false },
    );
    for (const [index, member] of target.members.entries()) {
      const candidate = candidates[index];
      if (candidate) this.sendTo(ctx, set, candidate, member.name, text);
    }
  }

  /** One planner's turn: resume its session with your message and record its reply. */
  private sendTo(ctx: ExtensionContext, set: CandidateSet, candidate: PlanCandidate, name: string, text: string) {
    if (!candidate.model || !candidate.session) return;
    this.update(ctx, set.createdAt, candidate.id, (current) => ({
      ...current,
      thread: [...(current.thread ?? []), { role: "user", text, at: Date.now() }],
    }));
    const key = `${set.createdAt}:${candidate.id}`;
    const pane = this.deps.pane(ctx, set, candidate);
    pane.trace.note(`You: ${text.replace(/\s+/gu, " ").slice(0, 400)}`, "info");
    const baseChildren = [...(pane.children ?? [])];
    const turn: Turn = {
      setCreatedAt: set.createdAt,
      id: candidate.id,
      name,
      controller: new AbortController(),
    };
    this.turns.set(key, turn);
    this.refreshWidget(ctx);
    const releaseWorking = holdWorking(this.deps.events, `${candidate.id} is replying`);
    const spec: ModelSpec = {
      ...candidate.model,
      ...(candidate.thinkingLevel ? { thinkingLevel: candidate.thinkingLevel } : {}),
    };
    const run = this.deps.runPlanner ?? runPlanner;
    void run({
      id: candidate.id,
      spec,
      cwd: ctx.cwd,
      prompt: formatPlannerFollowUp(text),
      timeoutMs: this.deps.timeoutMs(),
      extensionPath: this.deps.extensionPath,
      loadUserExtensions: this.deps.loadUserExtensions(),
      ...(candidate.launch?.scoutSpec ? { scoutSpec: candidate.launch.scoutSpec } : {}),
      ...(candidate.launch ? { access: candidate.launch.access } : {}),
      session: candidate.session,
      followUp: true,
      trace: pane.trace,
      subagentOffset: baseChildren.length,
      signal: turn.controller.signal,
      onProgress: (progress) => {
        turn.progress = progress;
        pane.progress = progress;
        this.widgetRender?.();
      },
      onSubagents: (views: readonly SubagentView[]) => {
        pane.children = [...baseChildren, ...views.map((view) => this.subagentPane(ctx, view))];
      },
    })
      .then((result) => this.finishTurn(ctx, set.createdAt, candidate.id, name, result))
      .catch((error: unknown) =>
        this.finishTurn(ctx, set.createdAt, candidate.id, name, {
          ...candidate,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        releaseWorking();
        this.turns.delete(key);
        this.refreshWidget(ctx);
      });
  }

  private readonly subagentPanes = new WeakMap<SubagentView, TracePane>();

  private subagentPane(ctx: ExtensionContext, view: SubagentView): TracePane {
    let pane = this.subagentPanes.get(view);
    if (!pane) {
      const described = this.deps.describeModel(ctx, view.model);
      pane = {
        id: view.id,
        model: view.model,
        name: described.name,
        ...(described.effort ? { effort: described.effort } : {}),
        label: view.label,
        task: view.task,
        trace: view.trace,
        progress: view.stats,
      };
      this.subagentPanes.set(view, pane);
    }
    return pane;
  }

  private finishTurn(ctx: ExtensionContext, setCreatedAt: number, id: string, name: string, result: PlannerTurnResult) {
    const isRevision = revised(result);
    const updated = this.update(ctx, setCreatedAt, id, (current) => {
      const revision = isRevision ? (current.plan ? (current.revision ?? 1) + 1 : 1) : undefined;
      const reply = result.reply?.trim() || (isRevision ? "Revised the plan." : "");
      return {
        ...current,
        ...(isRevision && result.plan !== undefined
          ? { plan: result.plan, status: "done" as const, revision, planFromText: false }
          : {}),
        durationMs: (current.durationMs ?? 0) + (result.durationMs ?? 0),
        toolCalls: (current.toolCalls ?? 0) + (result.toolCalls ?? 0),
        ...(current.subagentTasks || result.subagentTasks
          ? { subagentTasks: (current.subagentTasks ?? 0) + (result.subagentTasks ?? 0) }
          : {}),
        totalTokens: (current.totalTokens ?? 0) + (result.totalTokens ?? 0),
        costUsd: (current.costUsd ?? 0) + (result.costUsd ?? 0),
        thread: [
          ...(current.thread ?? []),
          ...(reply || result.status !== "done"
            ? [
                {
                  role: "planner" as const,
                  text: reply || `(no reply: ${result.error ?? result.status})`,
                  at: Date.now(),
                  ...(revision !== undefined ? { revision } : {}),
                },
              ]
            : []),
        ],
      };
    });
    const revision = isRevision ? updated?.revision : undefined;
    try {
      this.deps.pi.sendMessage<TalkMessageDetails>(
        {
          customType: PLANNER_TALK_MESSAGE_TYPE,
          content:
            result.status === "done"
              ? result.reply?.trim() || "Revised the plan."
              : `No reply: ${result.error ?? result.status}`,
          display: true,
          details: {
            role: "planner",
            candidate: id,
            name,
            ...(revision !== undefined ? { revision, plan: result.plan ?? "" } : {}),
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            stats: {
              durationMs: result.durationMs ?? 0,
              toolCalls: result.toolCalls ?? 0,
              totalTokens: result.totalTokens ?? 0,
              costUsd: result.costUsd ?? 0,
            },
          },
        },
        { triggerTurn: false },
      );
    } catch {
      // The session may have changed while the planner replied; its turn is saved regardless.
    }
  }

  /** Read-modify-write one candidate in the newest set, and persist it. */
  private update(
    ctx: ExtensionContext,
    setCreatedAt: number,
    id: string,
    change: (candidate: PlanCandidate) => PlanCandidate,
  ): PlanCandidate | undefined {
    let set: CandidateSet | undefined;
    try {
      set = this.deps.latestSet(ctx);
    } catch {
      return undefined;
    }
    if (!set || set.createdAt !== setCreatedAt) return undefined;
    let updated: PlanCandidate | undefined;
    const candidates = set.candidates.map((candidate) => {
      if (candidate.id !== id) return candidate;
      updated = change(candidate);
      return updated;
    });
    if (!updated) return undefined;
    this.deps.saveSet({ ...set, candidates });
    return updated;
  }

  private refreshWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const visible = this.target !== undefined || this.turns.size > 0;
    try {
      if (!visible) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        this.widgetRender = undefined;
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = undefined;
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.setWidget(WIDGET_KEY, this.plainLines());
        return;
      }
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.widgetRender = () => tui.requestRender();
        return new TalkWidget(theme, () => this.snapshot());
      });
      if (this.turns.size > 0 && !this.ticker) {
        this.ticker = setInterval(() => this.widgetRender?.(), 150);
        this.ticker.unref?.();
      } else if (this.turns.size === 0 && this.ticker) {
        clearInterval(this.ticker);
        this.ticker = undefined;
      }
    } catch {
      // Stale context.
    }
  }

  private snapshot(): TalkSnapshot {
    return {
      ...(this.target
        ? {
            target: {
              id: memberIds(this.target),
              name: this.target.members.map((member) => member.name).join(" + "),
              several: this.target.members.length > 1,
            },
          }
        : {}),
      turns: [...this.turns.values()].map((turn) => ({
        id: turn.id,
        name: turn.name,
        ...(turn.progress ? { progress: turn.progress } : {}),
      })),
    };
  }

  private plainLines() {
    const snapshot = this.snapshot();
    return [
      ...(snapshot.target
        ? [
            `Talking to ${snapshot.target.several ? "planners" : "planner"} ${snapshot.target.id} (${snapshot.target.name}); /plan talk off to switch back.`,
          ]
        : []),
      ...snapshot.turns.map(
        (turn) => `${turn.id} is replying${turn.progress ? ` · ${activityText(turn.progress)}` : ""}`,
      ),
    ];
  }
}

function revised(result: PlannerTurnResult) {
  return result.status === "done" && result.planSubmitted === true && result.plan !== undefined;
}

function memberIds(target: TalkTarget) {
  return target.members.map((member) => member.id).join(" + ");
}

interface TalkSnapshot {
  target?: { id: string; name: string; several: boolean };
  turns: Array<{ id: string; name: string; progress?: PlannerProgress }>;
}

function activityText(progress: PlannerProgress) {
  return [
    formatDuration((progress.endedAt ?? Date.now()) - progress.startedAt),
    `${progress.toolCalls} tools`,
    ...(progress.totalTokens ? [`${formatTokens(progress.totalTokens)} tok`] : []),
    ...(progress.costUsd ? [formatCost(progress.costUsd)] : []),
    ...(progress.lastActivity ? [progress.lastActivity] : []),
  ].join(" · ");
}

/** Above the editor: who you are talking to, and which planners are replying right now. */
class TalkWidget implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly snapshot: () => TalkSnapshot,
  ) {}

  invalidate() {}

  render(width: number): string[] {
    const theme = this.theme;
    const { target, turns } = this.snapshot();
    const lines: string[] = [];
    if (target) {
      lines.push(
        labeledRule(
          theme,
          width,
          theme.fg(
            "accent",
            theme.bold(`Talking to ${target.several ? "planners" : "planner"} ${target.id} · ${target.name}`),
          ),
          theme.fg("dim", "/plan talk off"),
          "borderAccent",
        ),
      );
    }
    for (const turn of turns) {
      lines.push(
        truncateToWidth(
          ` ${theme.fg("accent", spinner())} ${theme.bold(turn.id)} ${theme.fg("muted", `${turn.name} is replying`)}${turn.progress ? theme.fg("dim", ` · ${activityText(turn.progress)}`) : ""}`,
          width,
          "…",
        ),
      );
    }
    const ids = target?.id.split(" + ") ?? [];
    if (target && !turns.some((turn) => ids.includes(turn.id))) {
      lines.push(
        truncateToWidth(
          ` ${theme.fg("muted", `What you send now goes to ${target.several ? "planners" : "planner"} ${target.id}, not the main model.`)}  ${theme.fg("accent", "/plan compare")} ${theme.fg("dim", "all plans, merge, or talk to another")}`,
          width,
          "…",
        ),
      );
    }
    return lines;
  }
}
