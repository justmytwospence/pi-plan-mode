// Planning and Review: one lane per planner (one or two), side by side. Each lane shows what its
// planner is doing (or its plan, once it has one), the questions it is asking you, and a line to
// talk to it; you can talk to both at once. Below the lanes, the actions for the plans.
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
import { formatCost, formatDuration, formatTokens } from "../planners.js";
import type { PlanModeQuestionAnswer } from "../question-tool.js";
import {
  effortText,
  type Hint,
  hintLine,
  labeledRule,
  padLines,
  padVisible,
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

export interface LanesPageOptions {
  title: string;
  task: () => string;
  agents(): readonly PlannerAgent[];
  actions(): LaneAction[];
  onAction(id: string, text?: string): void;
  say(agent: PlannerAgent, text: string): void;
  /** Esc: hide the screen (planners keep going), or stop every working planner. */
  hide(): void;
  stopAll(): void;
  rowsAvailable(): number;
  requestRender(): void;
}

interface QuestionCursor {
  question: number;
  option: number;
  answers: PlanModeQuestionAnswer[];
}

type Modal = { kind: "escape"; choice: number } | { kind: "input"; action: LaneAction; input: Input };

const MAX_SUBAGENT_LINES = 3;

export class LanesPage {
  /** Lane index, or `lanes.length` for the actions bar. */
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
  private laneLayout: Array<{ x: number; width: number; agent: PlannerAgent }> = [];
  private actionsTop = 0;

  constructor(
    private readonly theme: Theme,
    private readonly options: LanesPageOptions,
  ) {
    this.renderer = new TraceRenderer(theme);
  }

  /** The step the page stands for: Planning while anyone works, Review once plans are in. */
  step(): WorkflowStep {
    const agents = this.options.agents();
    if (agents.some((agent) => agent.working)) return "Planning";
    return agents.some((agent) => agent.plan) ? "Review" : "Planning";
  }

  /** Go to the actions bar (e.g. when every plan is in). */
  focusActions() {
    this.focus = this.options.agents().length;
  }

  get typing() {
    return this.modal?.kind === "input" || this.focus < this.options.agents().length;
  }

  private input(agent: PlannerAgent) {
    let input = this.inputs.get(agent.id);
    if (!input) {
      input = new Input({ prompt: "", placeholder: `talk to ${agent.id}…` });
      this.inputs.set(agent.id, input);
    }
    return input;
  }

  private viewKey(agent: PlannerAgent) {
    return `${agent.id}:${this.showsPlan(agent) ? "plan" : "trace"}`;
  }

  private showsPlan(agent: PlannerAgent) {
    return agent.plan !== undefined && !this.showTrace.has(agent.id);
  }

  invalidate() {}

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const agents = this.options.agents();
    if (this.focus > agents.length) this.focus = agents.length;
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
    if (is("tab") || is("shift+tab")) {
      const step = is("tab") ? 1 : -1;
      this.focus = (this.focus + step + agents.length + 1) % (agents.length + 1);
      if (this.focus === agents.length) this.actionIndex = 0;
      return this.options.requestRender();
    }
    if (this.focus === agents.length) return this.handleActions(is);
    const agent = agents[this.focus];
    if (!agent) return;
    const half = Math.max(1, Math.floor((this.laneHeights.get(agent.id) ?? 10) / 2));
    if (is("ctrl+u")) this.scrollLane(agent, -half);
    else if (is("ctrl+d")) this.scrollLane(agent, half);
    else if (is("ctrl+o")) {
      if (agent.plan !== undefined) {
        if (this.showTrace.has(agent.id)) this.showTrace.delete(agent.id);
        else this.showTrace.add(agent.id);
      }
    } else if (agent.pending && (is("up") || is("down"))) {
      const cursor = this.questionCursor(agent);
      const question = agent.pending.questions[cursor.question];
      const count = (question?.options.length ?? 0) + 1;
      cursor.option = (cursor.option + (is("up") ? -1 : 1) + count) % count;
    } else if (is("up")) this.scrollLane(agent, -1);
    else if (is("down")) this.scrollLane(agent, 1);
    else if (is("enter")) this.submit(agent);
    else this.input(agent).handleInput(data);
    this.options.requestRender();
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
    const working = this.options.agents().some((agent) => agent.working);
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

  private questionCursor(agent: PlannerAgent): QuestionCursor {
    let cursor = this.questions.get(agent.id);
    if (!cursor || !agent.pending) {
      cursor = { question: 0, option: 0, answers: [] };
      this.questions.set(agent.id, cursor);
    }
    return cursor;
  }

  /** Enter in a lane: answer its question, or send what you typed. */
  private submit(agent: PlannerAgent) {
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
      cursor.answers.push({
        id: question.id,
        header: question.header,
        question: question.question,
        answer: text || option?.label || "",
        wasCustom: text.length > 0,
        ...(text ? {} : { optionIndex: cursor.option + 1 }),
      });
      input.setValue("");
      cursor.question += 1;
      cursor.option = 0;
      if (cursor.question >= pending.questions.length) {
        this.questions.delete(agent.id);
        agent.answer(cursor.answers);
      }
      return;
    }
    if (!text) return;
    input.setValue("");
    this.scroll.follow(`${agent.id}:trace`);
    this.showTrace.add(agent.id);
    this.options.say(agent, text);
  }

  private scrollLane(agent: PlannerAgent, delta: number) {
    const key = this.viewKey(agent);
    this.scroll.scrollBy(key, delta, this.lineCounts.get(key) ?? 0, this.laneHeights.get(agent.id) ?? 10);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const lane =
      event.y >= this.laneTop && event.y < this.actionsTop
        ? this.laneLayout.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width + 1)
        : undefined;
    if (event.type === "wheel" && lane) {
      this.scrollLane(lane.agent, Math.sign(event.wheelDelta ?? 0) * 3);
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click") {
      if (lane) this.focus = this.options.agents().indexOf(lane.agent);
      else if (event.y >= this.actionsTop) this.focus = this.options.agents().length;
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "move" || event.type === "release" ? undefined : { handled: true };
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = this.options.rowsAvailable();
    const agents = this.options.agents();
    if (this.focus > agents.length) this.focus = agents.length;
    const header = pageHeader(theme, width, this.options.title, this.context(agents), this.step());
    const task = this.options.task().split("\n")[0] ?? "";
    const taskLine = task ? truncateToWidth(` ${theme.fg("dim", "Task ")} ${task}`, width) : undefined;
    const footer = this.footer(width, agents);
    const top = [...header, ...(taskLine ? [taskLine] : [])];
    const laneRows = Math.max(6, height - top.length - footer.length);
    this.laneTop = top.length;
    const lanes = this.renderLanes(agents, width, laneRows);
    this.actionsTop = top.length + lanes.length;
    return [...top, ...lanes, ...footer].map((line) => truncateToWidth(line, width));
  }

  private context(agents: readonly PlannerAgent[]) {
    const tokens = agents.reduce((sum, agent) => sum + agent.stats.totalTokens, 0);
    const cost = agents.reduce((sum, agent) => sum + agent.stats.costUsd, 0);
    return [
      agents.length === 1 ? "1 planner" : `${agents.length} planners`,
      ...(tokens ? [`${formatTokens(tokens)} tok`] : []),
      ...(cost ? [formatCost(cost)] : []),
    ].join(" · ");
  }

  private renderLanes(agents: readonly PlannerAgent[], width: number, rows: number): string[] {
    const gap = " │ ";
    const count = Math.max(1, agents.length);
    const laneWidth = Math.max(20, Math.floor((width - gap.length * (count - 1)) / count));
    this.laneLayout = [];
    const columns = agents.map((agent, index) => {
      this.laneLayout.push({ x: index * (laneWidth + gap.length), width: laneWidth, agent });
      return this.lane(agent, laneWidth, rows, index === this.focus);
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

  private lane(agent: PlannerAgent, width: number, rows: number, focused: boolean): string[] {
    const theme = this.theme;
    if (agent.plan !== undefined && this.seenRevision.get(agent.id) !== agent.revision) {
      this.seenRevision.set(agent.id, agent.revision);
      this.showTrace.delete(agent.id);
      this.scroll.toTop(`${agent.id}:plan`);
    }
    const title = `${agent.id} · ${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}${
      agent.revision > 1 ? ` · v${agent.revision}` : ""
    }`;
    const head = labeledRule(
      theme,
      width,
      focused ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title),
      this.status(agent),
      focused ? "borderAccent" : "borderMuted",
    );
    const subagents = agent.subagents.agents
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
            `${this.showsPlan(agent) ? "plan" : "trace"} ${view.start + 1}–${view.start + view.lines.length}/${all.length}`,
          )
        : theme.fg("dim", this.showsPlan(agent) ? "plan" : "trace");
    return [
      head,
      ...subagents,
      ...padLines(body, bodyHeight),
      ...question,
      labeledRule(theme, width, position, "", focused ? "borderAccent" : "borderMuted"),
      truncateToWidth(inputLine, width),
    ];
  }

  private status(agent: PlannerAgent) {
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

  private questionLines(agent: PlannerAgent, width: number): string[] {
    const pending = agent.pending;
    if (!pending) return [];
    const theme = this.theme;
    const cursor = this.questionCursor(agent);
    const question = pending.questions[cursor.question];
    if (!question) return [];
    const count = pending.questions.length > 1 ? ` (${cursor.question + 1}/${pending.questions.length})` : "";
    const lines = [
      labeledRule(theme, width, theme.fg("warning", theme.bold(`? ${question.header}${count}`)), "", "warning"),
      ...wrap(question.question, width).map((line) => theme.bold(line)),
    ];
    const options = [...question.options.map((option) => option.label), "Skip (let the planner decide)"];
    options.forEach((label, index) => {
      const description = question.options[index]?.description;
      const text = `${index + 1}. ${label}${description ? theme.fg("dim", ` — ${description}`) : ""}`;
      const line = truncateToWidth(index === cursor.option ? `${theme.fg("accent", "›")} ${text}` : `  ${text}`, width);
      lines.push(index === cursor.option ? selectedRow(theme, width, line) : line);
    });
    return lines;
  }

  private footer(width: number, agents: readonly PlannerAgent[]): string[] {
    const theme = this.theme;
    const actions = this.options.actions();
    if (this.actionIndex >= actions.length) this.actionIndex = 0;
    const onBar = this.focus === agents.length;
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
    lines.push(truncateToWidth(` ${theme.fg("muted", current?.description ?? this.laneHint(agents))}`, width));
    lines.push(hintLine(theme, width, this.hints(agents)));
    return lines;
  }

  private laneHint(agents: readonly PlannerAgent[]) {
    const agent = agents[this.focus];
    if (!agent) return "";
    if (agent.pending) return `${agent.id} is asking you: ↑↓ pick an answer and ⏎, or type your own answer.`;
    if (agent.working) return `${agent.id} is working. Type to steer it; it reads your message after its current step.`;
    if (agent.plan) return `${agent.id}'s plan is ready. Talk to it to change it; Tab to the actions to implement it.`;
    return `${agent.id} is waiting for you. Type a message and press ⏎.`;
  }

  private hints(agents: readonly PlannerAgent[]): Hint[] {
    const onBar = this.focus === agents.length;
    if (onBar) {
      return [
        { key: "⏎", label: "do it", primary: true },
        { key: "←→", label: "choose" },
        { key: "tab", label: agents.length > 1 ? "lanes" : "lane" },
        { key: "esc", label: "leave" },
      ];
    }
    const agent = agents[this.focus];
    return [
      { key: "⏎", label: agent?.pending ? "answer" : "send", primary: true },
      ...(agent?.pending ? [{ key: "↑↓", label: "pick" }] : [{ key: "↑↓", label: "scroll" }]),
      { key: "^u/^d", label: "page" },
      ...(agent?.plan !== undefined ? [{ key: "^o", label: this.showsPlan(agent) ? "trace" : "plan" }] : []),
      { key: "tab", label: agents.length > 1 ? "next lane / actions" : "actions" },
      { key: "esc", label: "leave" },
    ];
  }
}

export { effortText };
