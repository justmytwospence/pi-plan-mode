import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeyId,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatCost, formatDuration, formatTokens } from "./multi-plan.js";
import type { PlannerTrace, TraceEntry } from "./planner-trace.js";
import {
  type AgentState,
  type Column,
  effortText,
  fieldLine,
  type Hint,
  hintLine,
  labeledRule,
  padLines,
  padVisible,
  renderTable,
  rule,
  ScrollState,
  selectedRow,
  stateIcon,
  titleLine,
} from "./ui-kit.js";

/** Stats for one agent (planner or subagent). */
export interface PaneStats {
  state: "starting" | "running" | "done" | "failed" | "cancelled" | "timeout";
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  subagentTasks: number;
  totalTokens: number;
  costUsd: number;
  lastActivity?: string;
  wrappingUp?: boolean;
}

export interface TracePane {
  id: string;
  /** Model spec, e.g. `anthropic/claude-opus-5-5:high`. */
  model: string;
  /** Friendly model name, e.g. `Claude Opus 5.5`. */
  name?: string;
  /** Effort (thinking level), when set. */
  effort?: string;
  /** Short task label (subagents). */
  label?: string;
  /** Full task text (subagents). */
  task?: string;
  trace: PlannerTrace;
  progress?: PaneStats;
  /** Subagents fanned out by this planner. */
  children?: TracePane[];
}

export interface TraceViewOptions {
  title: string;
  getPanes(): readonly TracePane[];
  /** True while planners run: Esc then asks before stopping them. */
  isLive(): boolean;
  rows(): number;
  requestRender(): void;
  onCancel(): void;
  /** Leave the monitor (after the run: go on to comparing plans). */
  onClose(): void;
}

interface AgentRow {
  pane: TracePane;
  family: TracePane;
  depth: number;
  last: boolean;
}

const MIN_LANE_WIDTH = 40;
const LANE_GAP = " │ ";

/**
 * Monitor for a multi-model run. The top lists every planner and every subagent it fanned out
 * (model, effort, time, tools, tokens, cost, what it is doing now); below, one lane per planner
 * shows the live trace of the selected agent in that planner's family, each lane scrolling on its
 * own (wheel/trackpad over the lane, or PgUp/PgDn for the selected one). Enter opens any agent's
 * full trace.
 */
export class TraceView implements Component {
  private selected = 0;
  private tableScroll = 0;
  private focused: string | undefined;
  private lanes = true;
  private confirmingCancel = false;
  private finished = false;
  private readonly scroll = new ScrollState();
  /** Agent shown in each planner's lane (the planner itself until something else is selected). */
  private readonly peek = new Map<string, string>();
  private readonly lineCache = new WeakMap<TraceEntry, { key: string; lines: string[] }>();
  private readonly lineCounts = new Map<string, number>();
  private laneHeight = 10;
  private fullHeight = 10;
  // Geometry of the last overview render, for mouse hit-testing.
  private tableTop = 0;
  private tableRows: AgentRow[] = [];
  private laneTop = 0;
  private laneBottom = 0;
  private laneLayout: Array<{ x: number; width: number; pane: TracePane }> = [];

  constructor(
    private readonly theme: Theme,
    private readonly options: TraceViewOptions,
  ) {}

  invalidate() {}

  /** True when the user is reading something that an automatic screen change would interrupt. */
  isBusy() {
    return this.focused !== undefined;
  }

  /** The run ended while the user was busy: offer to continue instead of jumping away. */
  markFinished() {
    this.finished = true;
    this.confirmingCancel = false;
    this.options.requestRender();
  }

  private rows(): AgentRow[] {
    const rows: AgentRow[] = [];
    for (const pane of this.options.getPanes()) {
      rows.push({ pane, family: pane, depth: 0, last: false });
      const children = pane.children ?? [];
      children.forEach((child, index) => {
        rows.push({ pane: child, family: pane, depth: 1, last: index === children.length - 1 });
      });
    }
    return rows;
  }

  private select(index: number, rows: AgentRow[]) {
    if (rows.length === 0) return;
    this.selected = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[this.selected];
    if (row) this.peek.set(row.family.id, row.pane.id);
  }

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const live = this.options.isLive();
    if (this.confirmingCancel) {
      this.confirmingCancel = false;
      if (is("y", "enter") && live) this.options.onCancel();
      this.options.requestRender();
      return;
    }
    const rows = this.rows();
    if (this.focused) {
      const index = rows.findIndex((row) => row.pane.id === this.focused);
      const pane = rows[index]?.pane;
      const page = Math.max(1, this.fullHeight - 2);
      if (this.finished && !live && is("c")) return this.options.onClose();
      if (!pane || is("escape", "q", "left", "h")) this.focused = undefined;
      else if (is("tab", "shift+tab")) {
        const next = (index + (is("tab") ? 1 : -1) + rows.length) % rows.length;
        this.select(next, rows);
        this.focused = rows[next]?.pane.id;
      } else if (is("up", "k")) this.scrollPane(pane, -1, this.fullHeight);
      else if (is("down", "j")) this.scrollPane(pane, 1, this.fullHeight);
      else if (is("pageUp", "ctrl+u", "shift+space")) this.scrollPane(pane, -page, this.fullHeight);
      else if (is("pageDown", "ctrl+d", "space")) this.scrollPane(pane, page, this.fullHeight);
      else if (is("home", "g")) this.scroll.toTop(pane.id);
      else if (is("end", "shift+g")) this.scroll.follow(pane.id);
      else return;
      this.options.requestRender();
      return;
    }
    const current = rows[this.selected]?.pane;
    const half = Math.max(1, Math.floor(this.laneHeight / 2));
    if (is("escape", "q")) {
      if (live) this.confirmingCancel = true;
      else this.options.onClose();
    } else if (this.finished && !live && is("c")) this.options.onClose();
    else if (is("up", "k")) this.select(this.selected - 1, rows);
    else if (is("down", "j")) this.select(this.selected + 1, rows);
    else if (is("tab", "shift+tab")) {
      // Jump between planners.
      const planners = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.depth === 0);
      const position = planners.findIndex(({ row }) => row.family === rows[this.selected]?.family);
      const next = planners[(position + (is("tab") ? 1 : -1) + planners.length) % Math.max(1, planners.length)];
      if (next) this.select(next.index, rows);
    } else if (is("enter", "right", "l")) this.focused = current?.id;
    else if (is("s")) this.lanes = !this.lanes;
    else if (current && is("pageUp", "ctrl+u")) this.scrollPane(current, -half, this.laneHeight);
    else if (current && is("pageDown", "ctrl+d")) this.scrollPane(current, half, this.laneHeight);
    else if (current && is("home", "g")) this.scroll.toTop(current.id);
    else if (current && is("end", "shift+g")) this.scroll.follow(current.id);
    else return;
    this.options.requestRender();
  }

  private scrollPane(pane: TracePane, delta: number, height: number) {
    this.scroll.scrollBy(pane.id, delta, this.lineCounts.get(pane.id) ?? 0, height);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const rows = this.rows();
    const wheel = event.type === "wheel" ? (event.wheelDelta ?? 0) : 0;
    if (this.focused) {
      const pane = rows.find((row) => row.pane.id === this.focused)?.pane;
      if (event.type === "wheel" && pane) {
        this.scrollPane(pane, wheel, this.fullHeight);
        this.options.requestRender();
      }
      return event.type === "move" || event.type === "release" ? undefined : { handled: true };
    }
    const inTable = event.y >= this.tableTop && event.y < this.tableTop + this.tableRows.length;
    const lane =
      event.y >= this.laneTop && event.y < this.laneBottom
        ? this.laneLayout.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width + 1)
        : undefined;
    if (event.type === "wheel") {
      if (lane) this.scrollPane(lane.pane, wheel, this.laneHeight);
      else if (inTable) this.select(this.selected + Math.sign(wheel), rows);
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      const target = inTable ? this.tableRows[event.y - this.tableTop]?.pane : lane ? lane.pane : undefined;
      const index = target ? rows.findIndex((row) => row.pane.id === target.id) : -1;
      if (index >= 0) {
        this.select(index, rows);
        if ((event.clickCount ?? 1) >= 2) this.focused = target?.id;
      }
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "press" ? { handled: true } : undefined;
  }

  render(width: number): string[] {
    const rows = this.rows();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const height = Math.max(14, this.options.rows());
    const focused = this.focused ? rows.find((row) => row.pane.id === this.focused) : undefined;
    if (this.focused && !focused) this.focused = undefined;
    const lines = focused ? this.renderFull(focused, width, height) : this.renderOverview(rows, width, height);
    return padLines(lines, height).map((line) => truncateToWidth(line, width));
  }

  private renderOverview(rows: AgentRow[], width: number, height: number) {
    const theme = this.theme;
    const now = Date.now();
    const live = this.options.isLive();
    const planners = this.options.getPanes();
    const context = `${totals(planners, now)}${this.finished && !live ? " · all finished" : ""}`;
    const header = [rule(theme, width), titleLine(theme, width, this.options.title, context, "Planning"), ""];
    const footer = [rule(theme, width), this.footer(rows, width, live)];

    const table = renderTable(theme, rows, this.columns(now), width - 3);
    const available = height - header.length - footer.length;
    const maxTable = Math.max(3, Math.floor((available - 2) * 0.45));
    const tableHeight = Math.min(rows.length, maxTable);
    if (this.selected < this.tableScroll) this.tableScroll = this.selected;
    if (this.selected >= this.tableScroll + tableHeight) this.tableScroll = this.selected - tableHeight + 1;
    this.tableScroll = Math.max(0, Math.min(this.tableScroll, rows.length - tableHeight));
    this.tableRows = rows.slice(this.tableScroll, this.tableScroll + tableHeight);
    const tableLines = [
      `   ${table.header}`,
      ...this.tableRows.map((row, offset) => {
        const index = this.tableScroll + offset;
        const text = table.lines[index] ?? "";
        if (index === this.selected) return selectedRow(theme, width, `${theme.fg("accent", " › ")}${text}`);
        return `   ${row.depth > 0 ? theme.fg("muted", text) : text}`;
      }),
    ];
    if (rows.length > tableHeight) {
      tableLines.push(
        theme.fg("dim", `   ${this.tableScroll + 1}–${this.tableScroll + tableHeight} of ${rows.length} agents`),
      );
    }
    this.tableTop = header.length + 1;

    const laneTop = header.length + tableLines.length;
    const laneArea = Math.max(4, available - tableLines.length);
    this.laneHeight = laneArea - 1;
    const families = planners.length;
    const laneWidth = families > 0 ? Math.floor((width - (families - 1) * LANE_GAP.length) / families) : width;
    const useLanes = this.lanes && families > 1 && families <= 3 && laneWidth >= MIN_LANE_WIDTH;
    const selectedRowInfo = rows[this.selected];
    const shown: TracePane[] = useLanes
      ? planners.map((planner) => {
          const peekId = this.peek.get(planner.id);
          return rows.find((row) => row.family === planner && row.pane.id === peekId)?.pane ?? planner;
        })
      : selectedRowInfo
        ? [selectedRowInfo.pane]
        : [];
    const columnWidth = useLanes ? laneWidth : width;
    this.laneLayout = shown.map((pane, index) => ({
      x: index * (columnWidth + LANE_GAP.length),
      width: columnWidth,
      pane,
    }));
    this.laneTop = laneTop + 1;
    this.laneBottom = laneTop + laneArea;
    const rendered = shown.map((pane, index) => {
      const active = selectedRowInfo?.pane.id === pane.id || (useLanes && selectedRowInfo?.family === planners[index]);
      return this.lane(pane, columnWidth, this.laneHeight, active, live);
    });
    const laneLines: string[] = [];
    for (let line = 0; line < laneArea; line += 1) {
      laneLines.push(
        rendered.map((lane) => padVisible(lane[line] ?? "", columnWidth)).join(theme.fg("borderMuted", LANE_GAP)),
      );
    }
    const spare = height - header.length - tableLines.length - laneLines.length - footer.length;
    return [...header, ...tableLines, ...laneLines, ...fill(spare), ...footer];
  }

  private columns(now: number): Column<AgentRow>[] {
    const theme = this.theme;
    return [
      {
        header: "AGENT",
        flex: true,
        min: 8,
        get: ({ pane, depth, last }) => {
          const branch = depth === 0 ? "" : theme.fg("dim", last ? "└ " : "├ ");
          const state: AgentState = pane.progress?.state ?? "waiting";
          const id = depth === 0 ? theme.bold(pane.id) : pane.id;
          return `${branch}${stateIcon(theme, state, now)} ${id}${pane.label ? ` ${pane.label}` : ""}`;
        },
      },
      { header: "MODEL", flex: true, min: 12, get: ({ pane }) => pane.name ?? pane.model },
      { header: "EFFORT", get: ({ pane }) => effortText(theme, pane.effort) },
      {
        header: "TIME",
        align: "right",
        get: ({ pane }) =>
          pane.progress ? formatDuration((pane.progress.endedAt ?? now) - pane.progress.startedAt) : "",
      },
      { header: "TOOLS", align: "right", get: ({ pane }) => (pane.progress ? String(pane.progress.toolCalls) : "") },
      {
        header: "TOKENS",
        align: "right",
        get: ({ pane }) => (pane.progress?.totalTokens ? formatTokens(pane.progress.totalTokens) : ""),
      },
      {
        header: "COST",
        align: "right",
        get: ({ pane }) => (pane.progress?.costUsd ? formatCost(pane.progress.costUsd) : ""),
      },
      { header: "NOW", flex: true, min: 10, get: ({ pane }) => activity(theme, pane.progress) },
    ];
  }

  private lane(pane: TracePane, width: number, height: number, active: boolean, live: boolean) {
    const theme = this.theme;
    const all = this.traceLines(pane.trace, width);
    this.lineCounts.set(pane.id, all.length);
    const view = this.scroll.window(pane.id, all, height);
    const title = `${pane.id}${pane.label ? ` ${pane.label}` : ""} · ${pane.name ?? pane.model}`;
    const state = pane.progress?.state;
    const position = !this.scroll.following(pane.id)
      ? theme.fg("warning", view.below > 0 ? `paused · ${view.below} more ↓` : "paused")
      : (state === "running" || state === "starting") && live
        ? theme.fg("success", "live")
        : state === "done"
          ? theme.fg("dim", "done")
          : state
            ? theme.fg("error", state === "timeout" ? "timed out" : state)
            : "";
    const head = labeledRule(
      theme,
      width,
      active ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title),
      position,
      active ? "borderAccent" : "borderMuted",
    );
    const body =
      all.length === 0 ? [theme.fg("dim", pane.progress ? "(thinking…)" : "(waiting to start)")] : view.lines;
    return [head, ...body];
  }

  private renderFull(row: AgentRow, width: number, height: number) {
    const theme = this.theme;
    const pane = row.pane;
    const now = Date.now();
    const progress = pane.progress;
    const title = `${pane.id}${pane.label ? ` · ${pane.label}` : ""}`;
    const context = [pane.name ?? pane.model, pane.effort ? `effort ${pane.effort}` : ""].filter(Boolean).join(" · ");
    const status = progress
      ? [
          `${stateIcon(theme, progress.state, now)} ${activity(theme, progress)}`,
          formatDuration((progress.endedAt ?? now) - progress.startedAt),
          `${progress.toolCalls} tools`,
          ...(progress.subagentTasks ? [`${progress.subagentTasks} subagents`] : []),
          ...(progress.totalTokens ? [`${formatTokens(progress.totalTokens)} tok`] : []),
          ...(progress.costUsd ? [formatCost(progress.costUsd)] : []),
        ].join(theme.fg("dim", " · "))
      : theme.fg("dim", "waiting to start");
    const taskLines = pane.task
      ? wrap(pane.task, Math.max(10, width - 8))
          .slice(0, 3)
          .map((line, index) => fieldLine(theme, width, index === 0 ? "Task" : "", line))
      : [];
    const header = [
      rule(theme, width),
      titleLine(theme, width, title, context, "Planning"),
      fieldLine(theme, width, "State", status),
      ...taskLines,
    ];
    const footer = [
      rule(theme, width),
      hintLine(theme, width, [
        ...(this.finished && !this.options.isLive() ? [{ key: "c", label: "compare plans", primary: true }] : []),
        { key: "↑↓", label: "scroll" },
        { key: "space", label: "page" },
        { key: "g", label: "top" },
        { key: "G", label: "follow" },
        { key: "tab", label: "next agent" },
        { key: "esc", label: "back to overview", primary: !this.finished },
      ]),
    ];
    this.fullHeight = Math.max(3, height - header.length - footer.length - 1);
    const all = this.traceLines(pane.trace, width);
    this.lineCounts.set(pane.id, all.length);
    const view = this.scroll.window(pane.id, all, this.fullHeight);
    const where =
      all.length === 0
        ? ""
        : `lines ${view.start + 1}–${view.start + view.lines.length} of ${all.length}${this.scroll.following(pane.id) ? " · following" : ""}`;
    const body = all.length === 0 ? [theme.fg("dim", progress ? "(thinking…)" : "(waiting to start)")] : view.lines;
    return [
      ...header,
      labeledRule(theme, width, theme.fg("muted", "trace"), theme.fg("dim", where)),
      ...padLines(body, this.fullHeight),
      ...footer,
    ];
  }

  private footer(rows: AgentRow[], width: number, live: boolean) {
    const theme = this.theme;
    if (this.confirmingCancel) {
      return ` ${theme.fg("warning", "Stop every planner and discard this run?")}   ${hintLine(theme, width - 45, [
        { key: "y", label: "stop them" },
        { key: "any other key", label: "keep planning", primary: true },
      ])}`;
    }
    const current = rows[this.selected]?.pane;
    const hints: Hint[] = [];
    const done = this.finished && !live;
    if (done) hints.push({ key: "c", label: "compare plans", primary: true });
    hints.push(
      { key: "↑↓", label: "select" },
      { key: "⏎", label: current ? `open ${current.id}'s full trace` : "open trace", primary: !this.finished },
      { key: "PgUp/PgDn", label: "scroll lane" },
      { key: "G", label: "follow" },
    );
    if (this.options.getPanes().length > 1) {
      hints.push({ key: "tab", label: "next planner" }, { key: "s", label: this.lanes ? "one lane" : "lanes" });
    }
    if (!done) hints.push({ key: "esc", label: live ? "stop planning" : "close" });
    return hintLine(theme, width, hints);
  }

  private traceLines(trace: PlannerTrace, width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    for (const entry of trace.entries) {
      const key = `${width}:${entryKey(entry)}`;
      const cached = this.lineCache.get(entry);
      if (cached?.key === key) {
        lines.push(...cached.lines);
        continue;
      }
      let rendered: string[];
      if (entry.kind === "text") {
        rendered = wrap(entry.text.trim(), width);
      } else if (entry.kind === "thinking") {
        rendered = wrap(entry.text.trim(), width).map((line) => theme.fg("thinkingText", theme.italic(line)));
      } else if (entry.kind === "tool") {
        const icon = entry.status === "running" ? "⋯" : entry.status === "ok" ? "✓" : "✗";
        const color = entry.status === "error" ? "error" : entry.status === "running" ? "accent" : "toolTitle";
        rendered = wrap(`${icon} ${entry.summary}`, width).map((line) => theme.fg(color, line));
        if (entry.result) rendered.push(theme.fg("dim", truncateToWidth(`  ${entry.result}`, width)));
      } else {
        const color = entry.tone === "error" ? "error" : entry.tone === "warning" ? "warning" : "muted";
        rendered = wrap(`• ${entry.text}`, width).map((line) => theme.fg(color, line));
      }
      if (entry.kind === "text" || entry.kind === "thinking") rendered.push("");
      this.lineCache.set(entry, { key, lines: rendered });
      lines.push(...rendered);
    }
    return lines;
  }
}

function totals(planners: readonly TracePane[], now: number) {
  const subagents = planners.reduce((sum, pane) => sum + (pane.children?.length ?? 0), 0);
  const started = planners.flatMap((pane) => (pane.progress ? [pane.progress.startedAt] : []));
  const ended = planners.map((pane) => pane.progress?.endedAt);
  const end = ended.every((value) => value !== undefined) && ended.length > 0 ? Math.max(...(ended as number[])) : now;
  const tokens = planners.reduce((sum, pane) => sum + (pane.progress?.totalTokens ?? 0), 0);
  const cost = planners.reduce((sum, pane) => sum + (pane.progress?.costUsd ?? 0), 0);
  return [
    `${planners.length} planner${planners.length === 1 ? "" : "s"}`,
    ...(subagents ? [`${subagents} subagent${subagents === 1 ? "" : "s"}`] : []),
    ...(started.length ? [formatDuration(end - Math.min(...started))] : []),
    ...(tokens ? [`${formatTokens(tokens)} tok`] : []),
    ...(cost ? [formatCost(cost)] : []),
  ].join(" · ");
}

function activity(theme: Theme, progress: PaneStats | undefined) {
  if (!progress) return theme.fg("dim", "waiting");
  switch (progress.state) {
    case "running":
    case "starting":
      if (progress.wrappingUp) return theme.fg("warning", "wrapping up");
      return progress.lastActivity ?? "starting";
    case "done":
      return theme.fg("success", "done");
    case "cancelled":
      return theme.fg("dim", "cancelled");
    case "timeout":
      return theme.fg("error", "timed out");
    default:
      return theme.fg("error", progress.state);
  }
}

function entryKey(entry: TraceEntry) {
  switch (entry.kind) {
    case "text":
    case "thinking":
      return `${entry.kind}:${entry.text.length}`;
    case "tool":
      return `tool:${entry.status}:${entry.result?.length ?? 0}`;
    default:
      return `note:${entry.text.length}`;
  }
}

function wrap(text: string, width: number) {
  if (!text) return [];
  return text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}

function fill(count: number) {
  return Array(Math.max(0, count)).fill("");
}

export { formatDuration };
