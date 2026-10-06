// Planning and Review: one lane per planner (one or two), side by side. Each lane shows what its
// planner is doing (or its plan, once it has one), the questions it is asking you, and a line to
// talk to it; you can talk to both at once. With two planners, a full-width pane below the lanes
// talks to M, the merger: a third model that sees both plans and helps you merge them. The focused
// pane gets the room: M grows while you talk to it and shrinks to a few lines otherwise. Below
// everything, the actions for the plans.
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  type KeyId,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { PlannerAgent } from "../planner/agent.js";

/** What a lane shows of an agent: a planner, or M, your main agent seen through the same lens. */
export type LaneAgent = Pick<
  PlannerAgent,
  | "id"
  | "name"
  | "spec"
  | "trace"
  | "subagents"
  | "status"
  | "working"
  | "stats"
  | "plan"
  | "revision"
  | "pending"
  | "error"
  | "answer"
>;

import { formatCost, formatDuration, formatTokens } from "../planners.js";
import type { PlanModeQuestionAnswer } from "../question-tool.js";
import {
  effortText,
  type Hint,
  hintLine,
  labeledRule,
  padLines,
  padVisible,
  renderTable,
  rule,
  ScrollState,
  selectedRow,
  spinner,
  type WorkflowStep,
} from "../ui-kit.js";
import { pageHeader } from "./frame.js";
import { TraceRenderer, wrap } from "./trace-lines.js";

export interface LaneAction {
  id: string;
  label: string;
  description: string;
  /** Actions that ask for a line of text first (e.g. an export path). */
  input?: { placeholder: string; initial: string };
}

/** The merger pane, shown with two planners. */
export interface MergerPane {
  /** The merger, once you have talked to it. */
  agent: LaneAgent | undefined;
  /** Its model (and effort), shown before it starts. */
  name: string;
  /** Both plans are in, so it can start. */
  ready: boolean;
  /** Why it cannot start yet, e.g. "B failed" or "B is still planning"; shown in its pane. */
  waiting?: string;
}

export interface LanesPageOptions {
  title: string;
  task: () => string;
  agents(): readonly LaneAgent[];
  /** The merger pane below the lanes, or undefined (one planner). */
  merger?(): MergerPane | undefined;
  actions(): LaneAction[];
  onAction(id: string, text?: string): void;
  say(agent: LaneAgent, text: string): void;
  /** Talk to the merger (starting it on the first message); empty text asks it to compare the plans. */
  sayToMerger?(text: string): void;
  /** Esc: hide the screen (planners keep going), or stop every working planner. */
  hide(): void;
  stopAll(): void;
  rowsAvailable(): number;
  /**
   * The share of the space below the header you dragged the M pane to (0-1), kept by the caller so
   * it outlives this page; undefined sizes it automatically (small, or a third while focused).
   */
  mergerShare?: { get(): number | undefined; set(share: number | undefined): void };
  requestRender(): void;
}

interface QuestionCursor {
  /** The question set this cursor belongs to; a new set starts a new cursor. */
  of: LaneAgent["pending"];
  question: number;
  option: number;
  /** Answers by question index; going back and answering again replaces one. */
  answers: Array<PlanModeQuestionAnswer | undefined>;
}

type Modal = { kind: "escape"; choice: number } | { kind: "input"; action: LaneAction; input: Input };

/** What Tab moves between: the lanes, the merger pane, and the actions bar. */
type Target = { kind: "lane"; agent: LaneAgent } | { kind: "merger"; pane: MergerPane } | { kind: "actions" };

const MAX_SUBAGENT_LINES = 3;
const MERGER_ID = "M";
/** Rows of the merger pane while you are elsewhere: its title, a few lines, and its input. */
const MERGER_COLLAPSED_ROWS = 6;
/** Share of the space below the header the merger pane takes while you talk to it. */
const MERGER_FOCUSED_SHARE = 1 / 3;
const MIN_LANE_ROWS = 6;
/** The merger pane's smallest useful size: its title, a line, its rule, and its input. */
const MERGER_MIN_ROWS = 5;

export class LanesPage {
  /** Index into the Tab targets: the lanes, then the merger pane (if any), then the actions bar. */
  focus = 0;
  private actionIndex = 0;
  private modal: Modal | undefined;
  private readonly inputs = new Map<string, Input>();
  private readonly showTrace = new Set<string>();
  private readonly questions = new Map<string, QuestionCursor>();
  private readonly scroll = new ScrollState();
  private readonly renderer: TraceRenderer;
  private readonly lineCounts = new Map<string, number>();
  /** The plan revision each lane last showed: a new one is shown from its top. */
  private readonly seenRevision = new Map<string, number>();
  private readonly laneHeights = new Map<string, number>();
  private laneTop = 0;
  private laneLayout: Array<{ x: number; width: number; agent: LaneAgent }> = [];
  private mergerTop = 0;
  private actionsTop = 0;
  /** The last layout: rows below the header, and the M pane's rows (for resizing it). */
  private lastAvailable = 0;
  private lastMergerRows = 0;
  private draggingDivider = false;

  constructor(
    private readonly theme: Theme,
    private readonly options: LanesPageOptions,
  ) {
    this.renderer = new TraceRenderer(theme);
  }

  /** The step the page stands for: Planning while a planner works, Review once plans are in. */
  step(): WorkflowStep {
    const agents = this.options.agents();
    if (agents.some((agent) => agent.working)) return "Planning";
    return agents.some((agent) => agent.plan) ? "Review" : "Planning";
  }

  /** Go to the actions bar (e.g. when every plan is in). */
  focusActions() {
    this.focus = this.targets().length - 1;
  }

  get typing() {
    return this.modal?.kind === "input" || this.focusedTarget().kind !== "actions";
  }

  private pane() {
    return this.options.merger?.();
  }

  private targets(): Target[] {
    const pane = this.pane();
    return [
      ...this.options.agents().map((agent): Target => ({ kind: "lane", agent })),
      // Tab reaches M only once it can start: before that it has nothing to do with what you type.
      ...(pane && (pane.agent || pane.ready) ? [{ kind: "merger", pane } as Target] : []),
      { kind: "actions" },
    ];
  }

  private focusedTarget(): Target {
    const targets = this.targets();
    if (this.focus >= targets.length) this.focus = targets.length - 1;
    return targets[this.focus] ?? { kind: "actions" };
  }

  /** Every agent on the page: the planners and the merger once it has started. */
  private everyone() {
    const merger = this.pane()?.agent;
    return [...this.options.agents(), ...(merger ? [merger] : [])];
  }

  private input(agent: LaneAgent) {
    return this.inputFor(agent.id);
  }

  private inputFor(id: string) {
    let input = this.inputs.get(id);
    if (!input) {
      input = new Input({ prompt: "", placeholder: `talk to ${id}…` });
      this.inputs.set(id, input);
    }
    return input;
  }

  private viewKey(agent: LaneAgent) {
    return `${agent.id}:${this.showsPlan(agent) ? "plan" : "trace"}`;
  }

  private showsPlan(agent: LaneAgent) {
    return agent.plan !== undefined && !this.showTrace.has(agent.id);
  }

  invalidate() {}

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const targets = this.targets();
    if (this.focus >= targets.length) this.focus = targets.length - 1;
    if (this.modal?.kind === "escape") return this.handleEscapeModal(data, is);
    if (this.modal?.kind === "input") {
      const modal = this.modal;
      if (is("escape")) this.modal = undefined;
      else if (is("enter")) {
        this.modal = undefined;
        this.options.onAction(modal.action.id, modal.input.getValue().trim());
      } else modal.input.handleInput(data);
      return this.options.requestRender();
    }
    if (is("escape")) {
      this.modal = { kind: "escape", choice: 0 };
      return this.options.requestRender();
    }
    if (this.pane() && is("shift+up", "shift+down")) {
      // Move the divider between the lanes and M by a row.
      this.resizeMerger(this.lastMergerRows + (is("shift+up") ? 1 : -1));
      return this.options.requestRender();
    }
    if (is("tab") || is("shift+tab")) {
      const step = is("tab") ? 1 : -1;
      this.focus = (this.focus + step + targets.length) % targets.length;
      if (targets[this.focus]?.kind === "actions") this.actionIndex = 0;
      return this.options.requestRender();
    }
    const target = targets[this.focus];
    if (!target || target.kind === "actions") return this.handleActions(is);
    if (target.kind === "merger" && !target.pane.agent) {
      if (is("enter")) this.startMerger(target.pane);
      else if (!is("up", "down", "ctrl+u", "ctrl+d", "ctrl+o")) this.inputFor(MERGER_ID).handleInput(data);
      return this.options.requestRender();
    }
    const agent = target.kind === "lane" ? target.agent : target.pane.agent;
    if (!agent) return;
    const half = Math.max(1, Math.floor((this.laneHeights.get(agent.id) ?? 10) / 2));
    if (is("ctrl+u")) this.scrollLane(agent, -half);
    else if (is("ctrl+d")) this.scrollLane(agent, half);
    else if (is("ctrl+o")) {
      if (agent.plan !== undefined) {
        if (this.showTrace.has(agent.id)) this.showTrace.delete(agent.id);
        else this.showTrace.add(agent.id);
      }
    } else if (agent.pending && this.input(agent).getValue() === "" && is("left", "backspace", "right")) {
      // With nothing typed, ←/backspace go back a question and → forward (as far as you have answered).
      const cursor = this.questionCursor(agent);
      if (is("right")) {
        const reachable = cursor.answers.findIndex((answer) => answer === undefined);
        const last = reachable === -1 ? agent.pending.questions.length - 1 : reachable;
        if (cursor.question < last) this.moveToQuestion(agent, cursor, cursor.question + 1);
      } else if (cursor.question > 0) this.moveToQuestion(agent, cursor, cursor.question - 1);
    } else if (agent.pending && (is("up") || is("down"))) {
      const cursor = this.questionCursor(agent);
      const question = agent.pending.questions[cursor.question];
      const count = this.optionCount(cursor, cursor.question, question?.options.length ?? 0);
      cursor.option = (cursor.option + (is("up") ? -1 : 1) + count) % count;
    } else if (is("up")) this.scrollLane(agent, -1);
    else if (is("down")) this.scrollLane(agent, 1);
    else if (is("enter")) this.submit(agent, target.kind === "merger");
    else this.input(agent).handleInput(data);
    this.options.requestRender();
  }

  /** Enter in the merger pane before M exists: start it with what you typed, or ask it to compare. */
  private startMerger(pane: MergerPane) {
    if (!pane.ready) return;
    const input = this.inputFor(MERGER_ID);
    const text = input.getValue().trim();
    input.setValue("");
    this.scroll.follow(`${MERGER_ID}:trace`);
    this.showTrace.add(MERGER_ID);
    this.options.sayToMerger?.(text);
  }

  private handleEscapeModal(_data: string, is: (...keys: KeyId[]) => boolean) {
    const modal = this.modal as Extract<Modal, { kind: "escape" }>;
    const choices = this.escapeChoices();
    if (is("escape")) this.modal = undefined;
    else if (is("left", "ctrl+h", "up")) modal.choice = (modal.choice - 1 + choices.length) % choices.length;
    else if (is("right", "ctrl+l", "down", "tab")) modal.choice = (modal.choice + 1) % choices.length;
    else if (is("enter")) {
      this.modal = undefined;
      const choice = choices[modal.choice];
      if (choice?.id === "hide") return this.options.hide();
      if (choice?.id === "stop") this.options.stopAll();
    }
    this.options.requestRender();
  }

  private escapeChoices() {
    const working = this.everyone().some((agent) => agent.working);
    return [
      { id: "hide", label: working ? "Hide (keep planning)" : "Hide (keep the plans)" },
      ...(working ? [{ id: "stop", label: "Stop planning" }] : []),
      { id: "back", label: "Back" },
    ];
  }

  private handleActions(is: (...keys: KeyId[]) => boolean) {
    const actions = this.options.actions();
    if (actions.length === 0) return;
    if (this.actionIndex >= actions.length) this.actionIndex = 0;
    if (is("left", "ctrl+h", "h", "up")) this.actionIndex = (this.actionIndex - 1 + actions.length) % actions.length;
    else if (is("right", "ctrl+l", "l", "down")) this.actionIndex = (this.actionIndex + 1) % actions.length;
    else if (is("enter")) {
      const action = actions[this.actionIndex];
      if (!action) return;
      if (action.input) {
        const input = new Input({ prompt: "", placeholder: action.input.placeholder });
        input.setValue(action.input.initial);
        input.focused = true;
        this.modal = { kind: "input", action, input };
      } else this.options.onAction(action.id);
    } else return;
    this.options.requestRender();
  }

  private questionCursor(agent: LaneAgent): QuestionCursor {
    let cursor = this.questions.get(agent.id);
    if (!cursor || !agent.pending || cursor.of !== agent.pending) {
      cursor = { of: agent.pending, question: 0, option: 0, answers: [] };
      this.questions.set(agent.id, cursor);
    }
    return cursor;
  }

  /**
   * Show another question with its earlier answer selected: an option, or your own words as a row
   * of their own (so the line stays empty and ←/→ keep moving between questions).
   */
  private moveToQuestion(agent: LaneAgent, cursor: QuestionCursor, index: number) {
    cursor.question = index;
    const previous = cursor.answers[index];
    const question = agent.pending?.questions[index];
    cursor.option = !previous
      ? 0
      : previous.wasCustom
        ? (question?.options.length ?? 0) + 1
        : Math.max(0, (previous.optionIndex ?? 1) - 1);
  }

  /** Rows a question offers: its options, Skip, and your own earlier answer if you typed one. */
  private optionCount(cursor: QuestionCursor, questionIndex: number, optionsLength: number) {
    return optionsLength + 1 + (cursor.answers[questionIndex]?.wasCustom ? 1 : 0);
  }

  /** Enter in a lane or the merger pane: answer its question, or send what you typed. */
  private submit(agent: LaneAgent, merger = false) {
    const input = this.input(agent);
    const text = input.getValue().trim();
    const pending = agent.pending;
    if (pending) {
      const cursor = this.questionCursor(agent);
      const question = pending.questions[cursor.question];
      if (!question) return;
      if (!text && cursor.option === question.options.length) {
        this.questions.delete(agent.id);
        agent.answer(undefined);
        return;
      }
      const option = question.options[cursor.option];
      const earlier = cursor.answers[cursor.question];
      // Your own earlier words, kept when you leave them selected and type nothing new.
      const keepsEarlier = !text && cursor.option === question.options.length + 1 && earlier?.wasCustom;
      cursor.answers[cursor.question] = keepsEarlier
        ? earlier
        : {
            id: question.id,
            header: question.header,
            question: question.question,
            answer: text || option?.label || "",
            wasCustom: text.length > 0,
            ...(text ? {} : { optionIndex: cursor.option + 1 }),
          };
      input.setValue("");
      const unanswered = pending.questions.findIndex((_question, index) => cursor.answers[index] === undefined);
      if (unanswered === -1 && cursor.question === pending.questions.length - 1) {
        this.questions.delete(agent.id);
        agent.answer(cursor.answers.filter((answer): answer is PlanModeQuestionAnswer => answer !== undefined));
        return;
      }
      // On to the next question (or, after the last, the first one still unanswered).
      const next = cursor.question + 1 < pending.questions.length ? cursor.question + 1 : unanswered;
      this.moveToQuestion(agent, cursor, next);
      return;
    }
    if (!text) return;
    input.setValue("");
    this.scroll.follow(`${agent.id}:trace`);
    this.showTrace.add(agent.id);
    if (merger) this.options.sayToMerger?.(text);
    else this.options.say(agent, text);
  }

  private scrollLane(agent: LaneAgent, delta: number) {
    const key = this.viewKey(agent);
    this.scroll.scrollBy(key, delta, this.lineCounts.get(key) ?? 0, this.laneHeights.get(agent.id) ?? 10);
  }

  /** Size the M pane to `rows` (kept within both panes' minimums) and remember it as a share. */
  private resizeMerger(rows: number) {
    if (!this.options.mergerShare || this.lastAvailable <= 0) return;
    const clamped = Math.max(MERGER_MIN_ROWS, Math.min(this.lastAvailable - MIN_LANE_ROWS, rows));
    this.lastMergerRows = clamped;
    this.options.mergerShare.set(clamped / this.lastAvailable);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The M pane's title rule is the divider: drag it to resize; double-click it to size M
    // automatically again.
    const onDivider = this.pane() !== undefined && this.lastMergerRows > 0 && event.y === this.mergerTop;
    if (this.draggingDivider) {
      if (event.type === "drag" || event.type === "move") {
        this.resizeMerger(this.actionsTop - event.y);
        this.options.requestRender();
        return { capture: true };
      }
      if (event.type === "release") {
        this.draggingDivider = false;
        return { handled: true };
      }
    }
    if (onDivider && event.type === "press" && event.button === "left") {
      this.draggingDivider = true;
      return { capture: true };
    }
    if (onDivider && event.type === "click" && (event.clickCount ?? 1) >= 2) {
      this.options.mergerShare?.set(undefined);
      this.options.requestRender();
      return { handled: true };
    }
    const lane =
      event.y >= this.laneTop && event.y < this.mergerTop
        ? this.laneLayout.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width + 1)
        : undefined;
    const pane = this.pane();
    const inMerger = pane !== undefined && event.y >= this.mergerTop && event.y < this.actionsTop;
    const scrolled = lane?.agent ?? (inMerger ? pane?.agent : undefined);
    if (event.type === "wheel" && scrolled) {
      this.scrollLane(scrolled, Math.sign(event.wheelDelta ?? 0) * 3);
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click") {
      const targets = this.targets();
      if (lane) this.focus = this.options.agents().indexOf(lane.agent);
      else if (inMerger) this.focus = targets.findIndex((target) => target.kind === "merger");
      else if (event.y >= this.actionsTop) this.focus = targets.length - 1;
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "move" || event.type === "release" ? undefined : { handled: true };
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = this.options.rowsAvailable();
    const agents = this.options.agents();
    const target = this.focusedTarget();
    const pane = this.pane();
    for (const agent of this.everyone()) this.syncRevision(agent);
    const header = pageHeader(theme, width, this.options.title, this.context(agents, pane), this.step());
    const task = this.options.task().split("\n")[0] ?? "";
    const taskLine = task ? truncateToWidth(` ${theme.fg("dim", "Task ")} ${task}`, width) : undefined;
    const footer = this.footer(width, target);
    // Everything fits the screen and the actions bar always shows: when room runs short, the
    // stats rows go first, then the merger pane (unless you are in it), and the lanes are cut last.
    const mergerFocused = target.kind === "merger";
    const base = [...header, ...(taskLine ? [taskLine] : [])];
    const room = height - base.length - footer.length;
    const stats = this.statsLines(width, agents, pane);
    const mergerMin = pane ? MERGER_MIN_ROWS : 0;
    const top = room - stats.length >= MIN_LANE_ROWS + mergerMin ? [...base, ...stats] : base;
    const available = Math.max(1, height - top.length - footer.length);
    const showMerger = pane !== undefined && (mergerFocused || available >= MIN_LANE_ROWS + MERGER_MIN_ROWS);
    const share = this.options.mergerShare?.get();
    const wanted =
      share !== undefined
        ? Math.round(available * share)
        : mergerFocused || pane?.agent?.pending
          ? Math.floor(available * MERGER_FOCUSED_SHARE)
          : MERGER_COLLAPSED_ROWS;
    const mergerRows = showMerger ? Math.max(MERGER_MIN_ROWS, Math.min(available - MIN_LANE_ROWS, wanted)) : 0;
    this.lastAvailable = available;
    this.lastMergerRows = mergerRows;
    const laneRows = Math.max(1, available - mergerRows);
    this.laneTop = top.length;
    // The lanes render at least their own minimum; cut them to the rows they were given.
    const lanes = this.renderLanes(agents, width, Math.max(MIN_LANE_ROWS, laneRows), target).slice(0, laneRows);
    this.mergerTop = top.length + lanes.length;
    const merger =
      showMerger && pane
        ? this.renderMerger(pane, width, mergerRows, mergerFocused).slice(0, available - lanes.length)
        : [];
    this.actionsTop = this.mergerTop + merger.length;
    const middle = padLines([...lanes, ...merger], available);
    // The footer (actions bar and keys) is never the part that gets cut.
    const above = [...top, ...middle].slice(0, Math.max(0, height - footer.length));
    return [...above, ...footer].map((line) => truncateToWidth(line, width));
  }

  private context(agents: readonly LaneAgent[], pane: MergerPane | undefined) {
    const all = [...agents, ...(pane?.agent ? [pane.agent] : [])];
    const tokens = all.reduce((sum, agent) => sum + agent.stats.totalTokens, 0);
    const cost = all.reduce((sum, agent) => sum + agent.stats.costUsd, 0);
    return [
      agents.length === 1 ? "1 planner" : `${agents.length} planners`,
      ...(pane?.agent ? ["main agent"] : []),
      ...(tokens ? [`${formatTokens(tokens)} tok`] : []),
      ...(cost ? [formatCost(cost)] : []),
    ].join(" · ");
  }

  private renderLanes(agents: readonly LaneAgent[], width: number, rows: number, target: Target): string[] {
    const gap = " │ ";
    const count = Math.max(1, agents.length);
    const laneWidth = Math.max(20, Math.floor((width - gap.length * (count - 1)) / count));
    this.laneLayout = [];
    const columns = agents.map((agent, index) => {
      this.laneLayout.push({ x: index * (laneWidth + gap.length), width: laneWidth, agent });
      return this.lane(agent, laneWidth, rows, target.kind === "lane" && target.agent === agent);
    });
    if (columns.length === 0) return padLines([this.theme.fg("dim", "  No planners.")], rows);
    const lines: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      lines.push(
        columns.map((column) => padVisible(column[row] ?? "", laneWidth)).join(this.theme.fg("borderMuted", gap)),
      );
    }
    return lines;
  }

  /** The merger pane: M once it has started, or what it will do before then. */
  private renderMerger(pane: MergerPane, width: number, rows: number, focused: boolean): string[] {
    if (pane.agent) return this.lane(pane.agent, width, rows, focused, true);
    const theme = this.theme;
    const color = focused ? "borderAccent" : "borderMuted";
    const title = `${MERGER_ID} · merger · ${pane.name}`;
    const head = labeledRule(
      theme,
      width,
      focused ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title),
      pane.ready ? theme.fg("dim", "not started") : theme.fg("warning", pane.waiting ?? "waiting for both plans"),
      color,
    );
    const about = pane.ready
      ? "Talk the two plans over with M, a third model that sees both of them and what you told each planner. When you are ready, ask it to write the merged plan. Enter on an empty line asks it to compare the plans."
      : `${pane.waiting ? `${pane.waiting}: M needs both plans, so it cannot start. ` : ""}Once both plans are in, M, a third model that sees both of them and what you told each planner, can talk them over with you and merge them into one. Until then, talk to a planner or Tab to the actions to implement a plan.`;
    const bodyHeight = Math.max(1, rows - 3);
    const body = wrap(about, Math.max(10, width - 2)).map((line) => theme.fg("dim", ` ${line}`));
    const input = this.inputFor(MERGER_ID);
    input.focused = focused && this.modal === undefined;
    const inputLine = focused
      ? `${theme.fg("accent", "›")} ${input.render(Math.max(4, width - 2))[0] ?? ""}`
      : theme.fg(
          "dim",
          pane.ready
            ? `› ${input.getValue() || `tab here to talk to ${MERGER_ID}`}`
            : "  M starts once both plans are in",
        );
    return [
      head,
      ...padLines(body, bodyHeight),
      labeledRule(theme, width, theme.fg("dim", "chat"), "", color),
      truncateToWidth(inputLine, width),
    ];
  }

  /** A new plan version is shown from its top, in place of the trace. */
  private syncRevision(agent: LaneAgent) {
    if (agent.plan === undefined || this.seenRevision.get(agent.id) === agent.revision) return;
    this.seenRevision.set(agent.id, agent.revision);
    this.showTrace.delete(agent.id);
    this.scroll.toTop(`${agent.id}:plan`);
  }

  private lane(agent: LaneAgent, width: number, rows: number, focused: boolean, merger = false): string[] {
    const theme = this.theme;
    const title = `${agent.id}${merger ? " · main agent" : ""} · ${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}${
      agent.revision > 1 ? ` · v${agent.revision}` : ""
    }`;
    const traceLabel = merger ? "chat" : "trace";
    const head = labeledRule(
      theme,
      width,
      focused ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title),
      this.status(agent),
      focused ? "borderAccent" : "borderMuted",
    );
    // A pane too short for them (the merger, collapsed) leaves out the running subagents.
    const subagents = (rows < 10 ? [] : agent.subagents.agents)
      .filter((sub) => sub.stats.state === "running" || sub.stats.state === "starting")
      .slice(0, MAX_SUBAGENT_LINES)
      .map((sub) =>
        truncateToWidth(theme.fg("dim", `  ↳ ${sub.id} ${sub.label} · ${sub.stats.lastActivity ?? "starting"}`), width),
      );
    const question = this.questionLines(agent, width);
    const input = this.input(agent);
    input.focused = focused && this.modal === undefined;
    const inputLine = focused
      ? `${theme.fg("accent", "›")} ${input.render(Math.max(4, width - 2))[0] ?? ""}`
      : theme.fg("dim", `› ${input.getValue() || `tab here to talk to ${agent.id}`}`);
    const bodyHeight = Math.max(2, rows - 1 - subagents.length - question.length - 2);
    this.laneHeights.set(agent.id, bodyHeight);
    const key = this.viewKey(agent);
    const all = this.showsPlan(agent)
      ? this.renderer.planLines(`${agent.id}:${agent.revision}`, agent.plan ?? "", width)
      : this.renderer.lines(agent.trace, width);
    this.lineCounts.set(key, all.length);
    const view = this.scroll.window(key, all, bodyHeight);
    const empty = agent.status === "starting" ? `${spinner()} starting…` : "(nothing yet)";
    const body = all.length === 0 ? [theme.fg("dim", empty)] : view.lines;
    const position =
      view.below > 0 || view.start > 0
        ? theme.fg(
            "dim",
            `${this.showsPlan(agent) ? "plan" : traceLabel} ${view.start + 1}–${view.start + view.lines.length}/${all.length}`,
          )
        : theme.fg("dim", this.showsPlan(agent) ? "plan" : traceLabel);
    return [
      head,
      ...subagents,
      ...padLines(body, bodyHeight),
      ...question,
      labeledRule(theme, width, position, "", focused ? "borderAccent" : "borderMuted"),
      truncateToWidth(inputLine, width),
    ];
  }

  /**
   * One live row per planner (and the merger once it has started): its state, model, how long its
   * turn has run, and the tools, subagent tasks, tokens and cost it has used so far.
   */
  private statsLines(width: number, agents: readonly LaneAgent[], pane: MergerPane | undefined): string[] {
    const theme = this.theme;
    const rows = [...agents, ...(pane?.agent ? [pane.agent] : [])];
    if (rows.length === 0) return [];
    const now = Date.now();
    const count = (value: number, one: string, many: string) => (value ? `${value} ${value === 1 ? one : many}` : "");
    const table = renderTable(
      theme,
      rows,
      [
        {
          header: "",
          get: (agent) =>
            `${this.stateIcon(agent)} ${theme.bold(agent.id)} ${theme.fg("muted", `${agent === pane?.agent ? "main agent · " : ""}${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}`)}`,
          flex: true,
          min: 12,
        },
        {
          header: "",
          get: (agent) => formatDuration((agent.stats.endedAt ?? now) - agent.stats.startedAt),
          align: "right",
        },
        { header: "", get: (agent) => count(agent.stats.toolCalls, "tool", "tools"), align: "right" },
        {
          header: "",
          get: (agent) => count(agent.stats.subagentTasks, "subagent", "subagents"),
          align: "right",
        },
        {
          header: "",
          get: (agent) => (agent.stats.totalTokens ? `${formatTokens(agent.stats.totalTokens)} tok` : ""),
          align: "right",
        },
        {
          header: "",
          get: (agent) => (agent.stats.costUsd ? formatCost(agent.stats.costUsd) : ""),
          align: "right",
        },
        { header: "", get: (agent) => this.activity(agent), flex: true, min: 10 },
      ],
      Math.max(20, width - 1),
    );
    return table.lines.map((line) => truncateToWidth(` ${line}`, width));
  }

  private stateIcon(agent: LaneAgent) {
    const theme = this.theme;
    switch (agent.status) {
      case "starting":
      case "working":
        return theme.fg("accent", spinner());
      case "asking":
        return theme.fg("warning", "?");
      case "idle":
        return agent.plan ? theme.fg("success", "✓") : theme.fg("muted", "·");
      case "failed":
        return theme.fg("error", "✗");
      default:
        return theme.fg("dim", "–");
    }
  }

  /** What an agent is doing right now, in a few words. */
  private activity(agent: LaneAgent) {
    const theme = this.theme;
    switch (agent.status) {
      case "starting":
        return theme.fg("dim", "starting");
      case "working":
        return agent.stats.wrappingUp
          ? theme.fg("warning", "wrapping up")
          : theme.fg("dim", agent.stats.lastActivity ?? "working");
      case "asking":
        return theme.fg("warning", "asking you");
      case "idle":
        return agent.plan
          ? theme.fg("success", `plan ready${agent.revision > 1 ? ` (v${agent.revision})` : ""}`)
          : theme.fg("muted", "waiting for you");
      case "failed":
        return theme.fg("error", `failed${agent.error ? `: ${agent.error}` : ""}`);
      default:
        return theme.fg("dim", "stopped");
    }
  }

  private status(agent: LaneAgent) {
    const theme = this.theme;
    const elapsed = formatDuration((agent.stats.endedAt ?? Date.now()) - agent.stats.startedAt);
    const parts: string[] = [];
    switch (agent.status) {
      case "starting":
        parts.push(`${theme.fg("accent", spinner())} starting`);
        break;
      case "working":
        parts.push(
          `${theme.fg("accent", spinner())} ${agent.stats.wrappingUp ? theme.fg("warning", "wrapping up") : truncateToWidth(agent.stats.lastActivity ?? "working", 28, "…")}`,
        );
        break;
      case "asking":
        parts.push(theme.fg("warning", "? asking you"));
        break;
      case "idle":
        parts.push(agent.plan ? theme.fg("success", "✓ plan ready") : theme.fg("muted", "waiting for you"));
        break;
      case "failed":
        parts.push(theme.fg("error", "✗ failed"));
        break;
      default:
        parts.push(theme.fg("dim", "stopped"));
    }
    parts.push(theme.fg("dim", elapsed));
    if (agent.stats.costUsd) parts.push(theme.fg("dim", formatCost(agent.stats.costUsd)));
    return parts.join(theme.fg("dim", " · "));
  }

  private questionLines(agent: LaneAgent, width: number): string[] {
    const pending = agent.pending;
    if (!pending) return [];
    const theme = this.theme;
    const cursor = this.questionCursor(agent);
    const question = pending.questions[cursor.question];
    if (!question) return [];
    const count = pending.questions.length > 1 ? ` (${cursor.question + 1}/${pending.questions.length})` : "";
    // One dot per question: answered, current, still to go.
    const progress =
      pending.questions.length > 1
        ? pending.questions
            .map((_question, index) =>
              index === cursor.question
                ? theme.fg("warning", "◉")
                : cursor.answers[index]
                  ? theme.fg("success", "●")
                  : theme.fg("dim", "○"),
            )
            .join("")
        : "";
    const lines = [
      labeledRule(theme, width, theme.fg("warning", theme.bold(`? ${question.header}${count}`)), progress, "warning"),
      ...wrap(question.question, width).map((line) => theme.bold(line)),
    ];
    const earlier = cursor.answers[cursor.question];
    const options = [
      ...question.options.map((option) => option.label),
      "Skip (let the planner decide)",
      ...(earlier?.wasCustom ? [`✎ your answer: ${earlier.answer}`] : []),
    ];
    options.forEach((label, index) => {
      const description = question.options[index]?.description;
      const text = `${index + 1}. ${label}${description ? theme.fg("dim", ` — ${description}`) : ""}`;
      const line = truncateToWidth(index === cursor.option ? `${theme.fg("accent", "›")} ${text}` : `  ${text}`, width);
      lines.push(index === cursor.option ? selectedRow(theme, width, line) : line);
    });
    return lines;
  }

  private footer(width: number, target: Target): string[] {
    const theme = this.theme;
    const actions = this.options.actions();
    if (this.actionIndex >= actions.length) this.actionIndex = 0;
    const onBar = target.kind === "actions";
    const bar = actions.map((action, index) => {
      const label = ` ${action.label} `;
      return onBar && index === this.actionIndex
        ? theme.bg("selectedBg", theme.fg("accent", theme.bold(label)))
        : theme.fg(onBar ? "text" : "muted", label);
    });
    const barLine = actions.length
      ? ` ${bar.join(theme.fg("dim", "·"))}`
      : theme.fg("dim", "  Actions appear once a plan is in.");
    const current = onBar ? actions[this.actionIndex] : undefined;
    const lines = [rule(theme, width, onBar ? "borderAccent" : "borderMuted"), truncateToWidth(barLine, width)];
    if (this.modal?.kind === "escape") {
      const choices = this.escapeChoices();
      const modal = this.modal;
      const row = choices
        .map((choice, index) =>
          index === modal.choice
            ? theme.bg("selectedBg", theme.fg("accent", theme.bold(` ${choice.label} `)))
            : ` ${choice.label} `,
        )
        .join(theme.fg("dim", "·"));
      lines.push(truncateToWidth(` ${theme.fg("warning", "Leave planning?")}  ${row}`, width));
      lines.push(
        hintLine(theme, width, [
          { key: "⏎", label: "choose", primary: true },
          { key: "←→", label: "move" },
          { key: "esc", label: "back" },
        ]),
      );
      return lines;
    }
    if (this.modal?.kind === "input") {
      const modal = this.modal;
      const label = ` ${theme.fg("accent", modal.action.label)} `;
      lines.push(
        truncateToWidth(`${label}${modal.input.render(Math.max(10, width - visibleWidth(label)))[0] ?? ""}`, width),
      );
      lines.push(
        hintLine(theme, width, [
          { key: "⏎", label: "ok", primary: true },
          { key: "esc", label: "cancel" },
        ]),
      );
      return lines;
    }
    lines.push(truncateToWidth(` ${theme.fg("muted", current?.description ?? this.laneHint(target))}`, width));
    lines.push(hintLine(theme, width, this.hints(target)));
    return lines;
  }

  private laneHint(target: Target) {
    if (target.kind === "actions") return "";
    if (target.kind === "merger" && !target.pane.agent) {
      return target.pane.ready
        ? "Talk the plans over with M; ⏎ on an empty line asks it to compare them. Ask it to merge them when you are ready."
        : "M can help once both plans are in.";
    }
    const merger = target.kind === "merger";
    const agent = target.kind === "lane" ? target.agent : target.pane.agent;
    if (!agent) return "";
    if (agent.pending) {
      const several = agent.pending.questions.length > 1;
      return `${agent.id} is asking you: ↑↓ pick an answer and ⏎, or type your own answer.${several ? " ←→ (with nothing typed) move between its questions to change an answer." : ""}`;
    }
    if (agent.working) return `${agent.id} is working. Type to steer it; it reads your message after its current step.`;
    if (merger && agent.plan) {
      return "M's merged plan is ready. Talk to M to change it; Tab to the actions to implement it.";
    }
    if (merger) return "Talk it through with M; when you are ready, ask it to write the merged plan.";
    if (agent.plan) return `${agent.id}'s plan is ready. Talk to it to change it; Tab to the actions to implement it.`;
    return `${agent.id} is waiting for you. Type a message and press ⏎.`;
  }

  private hints(target: Target): Hint[] {
    const panes = this.targets().length - 1;
    if (target.kind === "actions") {
      return [
        { key: "⏎", label: "do it", primary: true },
        { key: "←→", label: "choose" },
        { key: "tab", label: panes > 1 ? "panes" : "lane" },
        { key: "esc", label: "leave" },
      ];
    }
    const agent = target.kind === "lane" ? target.agent : target.pane.agent;
    const merger = target.kind === "merger";
    const compares =
      target.kind === "merger" && !agent && target.pane.ready && !this.inputFor(MERGER_ID).getValue().trim();
    return [
      { key: "⏎", label: agent?.pending ? "answer" : compares ? "compare" : "send", primary: true },
      ...(agent?.pending
        ? [
            { key: "↑↓", label: "pick" },
            ...(agent.pending.questions.length > 1 ? [{ key: "←→", label: "question" }] : []),
          ]
        : agent
          ? [{ key: "↑↓", label: "scroll" }]
          : []),
      ...(agent ? [{ key: "^u/^d", label: "page" }] : []),
      ...(agent?.plan !== undefined
        ? [{ key: "^o", label: this.showsPlan(agent) ? (merger ? "chat" : "trace") : "plan" }]
        : []),
      ...(merger && this.options.mergerShare ? [{ key: "⇧↑↓", label: "resize" }] : []),
      { key: "tab", label: panes > 1 ? "next pane / actions" : "actions" },
      { key: "esc", label: "leave" },
    ];
  }
}

export { effortText };
