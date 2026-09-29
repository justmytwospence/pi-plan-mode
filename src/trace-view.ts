import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeyId,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { alignColumns, formatDuration, statsCells } from "./multi-plan.js";
import type { PlannerTrace, TraceEntry } from "./planner-trace.js";

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
  /** True while planners run: Esc then asks to cancel instead of closing. */
  isLive(): boolean;
  rows(): number;
  requestRender(): void;
  onCancel(): void;
  onClose(): void;
}

interface AgentRow {
  pane: TracePane;
  depth: number;
  last: boolean;
}

const MIN_SPLIT_COLUMN = 40;
const SEPARATOR = " │ ";

/**
 * Monitor for a multi-model run. The overview lists every planner and every subagent it fanned
 * out, with model, effort, time, tools, tokens, cost, and current activity, above a live preview
 * of the selected agent (or of all planners side by side). Enter opens any agent's full trace.
 */
export class TraceView implements Component {
  private selected = 0;
  private tableScroll = 0;
  private focused: string | undefined;
  private previewPlanners = false;
  private readonly scrollTop = new Map<string, number | undefined>();
  private confirmingCancel = false;
  private readonly lineCache = new WeakMap<TraceEntry, { key: string; lines: string[] }>();
  private lastBodyHeight = 10;
  private readonly lastLineCounts = new Map<string, number>();
  private tableTop = 0;
  private shownRows: AgentRow[] = [];
  private lastSplitWidth = 0;
  private previewTop = 0;

  constructor(
    private readonly theme: Theme,
    private readonly options: TraceViewOptions,
  ) {}

  invalidate() {}

  private rows(): AgentRow[] {
    const rows: AgentRow[] = [];
    for (const pane of this.options.getPanes()) {
      rows.push({ pane, depth: 0, last: false });
      const children = pane.children ?? [];
      children.forEach((child, index) => {
        rows.push({ pane: child, depth: 1, last: index === children.length - 1 });
      });
    }
    return rows;
  }

  private selectedPane(rows = this.rows()) {
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    return rows[this.selected]?.pane;
  }

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    if (this.confirmingCancel) {
      this.confirmingCancel = false;
      if (is("escape", "y")) this.options.onCancel();
      this.options.requestRender();
      return;
    }
    const rows = this.rows();
    if (this.focused) {
      const pane = rows.find((row) => row.pane.id === this.focused)?.pane;
      if (is("escape", "q", "left", "h") || !pane) this.focused = undefined;
      else if (is("tab", "shift+tab")) {
        const index = rows.findIndex((row) => row.pane.id === this.focused);
        const next = (index + (is("tab") ? 1 : -1) + rows.length) % rows.length;
        this.selected = next;
        this.focused = rows[next]?.pane.id;
      } else if (!this.scroll(pane, data)) return;
      this.options.requestRender();
      return;
    }
    if (is("escape", "q")) {
      if (this.options.isLive()) this.confirmingCancel = true;
      else this.options.onClose();
    } else if (is("up", "k")) this.selected = (this.selected - 1 + rows.length) % Math.max(1, rows.length);
    else if (is("down", "j")) this.selected = (this.selected + 1) % Math.max(1, rows.length);
    else if (is("enter", "right", "l")) this.focused = this.selectedPane(rows)?.id;
    else if (is("s")) this.previewPlanners = !this.previewPlanners;
    else return;
    this.options.requestRender();
  }

  /** Scroll a pane's trace; returns false when the key is not a scroll key. */
  private scroll(pane: TracePane, data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const height = this.lastBodyHeight;
    const total = this.lastLineCounts.get(pane.id) ?? 0;
    const maxTop = Math.max(0, total - height);
    const current = this.scrollTop.get(pane.id) ?? maxTop;
    const move = (top: number | undefined) =>
      this.scrollTop.set(pane.id, top === undefined || top >= maxTop ? undefined : Math.max(0, top));
    if (is("up", "k")) move(current - 1);
    else if (is("down", "j")) move(current + 1);
    else if (is("pageUp", "ctrl+u")) move(current - Math.max(1, Math.floor(height / 2)));
    else if (is("pageDown", "ctrl+d")) move(current + Math.max(1, Math.floor(height / 2)));
    else if (is("home", "g")) move(0);
    else if (is("end", "shift+g")) move(undefined);
    else return false;
    return true;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const rows = this.rows();
    if (this.focused) {
      const pane = rows.find((row) => row.pane.id === this.focused)?.pane;
      if (event.type === "wheel" && pane) {
        this.scroll(pane, (event.wheelDelta ?? 0) < 0 ? "k" : "j");
        this.scroll(pane, (event.wheelDelta ?? 0) < 0 ? "k" : "j");
        this.scroll(pane, (event.wheelDelta ?? 0) < 0 ? "k" : "j");
        this.options.requestRender();
        return { handled: true };
      }
      return event.type === "press" || event.type === "click" ? { handled: true } : undefined;
    }
    if (event.type === "wheel") {
      const delta = Math.sign(event.wheelDelta ?? 0);
      if (delta !== 0 && rows.length > 0) this.selected = Math.min(rows.length - 1, Math.max(0, this.selected + delta));
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      const index = event.y - this.tableTop;
      const row = this.shownRows[index];
      if (row) {
        this.selected = this.tableScroll + index;
        if ((event.clickCount ?? 1) >= 2) this.focused = row.pane.id;
      } else if (event.y >= this.previewTop && this.previewPlanners && this.lastSplitWidth > 0) {
        const column = Math.floor(event.x / (this.lastSplitWidth + SEPARATOR.length));
        const pane = this.options.getPanes()[column];
        if (pane) this.focused = pane.id;
      }
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "press" ? { handled: true } : undefined;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const rows = this.rows();
    const height = Math.max(12, this.options.rows());
    const live = this.options.isLive();
    const rule = theme.fg("borderMuted", "─".repeat(width));
    const focusedPane = this.focused ? rows.find((row) => row.pane.id === this.focused)?.pane : undefined;
    if (this.focused && !focusedPane) this.focused = undefined;

    if (focusedPane) {
      const header = [
        rule,
        truncateToWidth(
          theme.bold(`${focusedPane.id} · ${focusedPane.model}${focusedPane.label ? ` · ${focusedPane.label}` : ""}`),
          width,
        ),
        truncateToWidth(theme.fg("muted", statLine(focusedPane)), width),
        ...(focusedPane.task
          ? wrap(`Task: ${focusedPane.task}`, width)
              .slice(0, 3)
              .map((line) => theme.fg("dim", line))
          : []),
        rule,
      ];
      const footer = [
        rule,
        truncateToWidth(
          theme.fg("dim", "↑↓ j/k scroll · PgUp/PgDn · g top · End follow · tab next agent · Esc back to overview"),
          width,
        ),
      ];
      const bodyHeight = Math.max(3, height - header.length - footer.length);
      this.lastBodyHeight = bodyHeight;
      const body = this.window(focusedPane, width, bodyHeight);
      return [...header, ...padLines(body, bodyHeight), ...footer].map((line) => truncateToWidth(line, width));
    }

    const selectedPane = this.selectedPane(rows);
    const tableLines = alignColumns(
      rows.map(({ pane, depth, last }) => {
        const progress = pane.progress;
        const icon = !progress
          ? "·"
          : progress.state === "done"
            ? "✓"
            : progress.state === "running" || progress.state === "starting"
              ? "…"
              : "✗";
        const branch = depth === 0 ? "" : last ? "└ " : "├ ";
        return [
          `${branch}${icon} ${pane.id}`,
          pane.model,
          pane.label ? truncateToWidth(pane.label, 28) : "",
          ...statsCells({
            ...(progress ? { durationMs: (progress.endedAt ?? Date.now()) - progress.startedAt } : {}),
            ...(progress ? { toolCalls: progress.toolCalls } : {}),
            subagents: progress?.subagentTasks ?? 0,
            tokens: progress?.totalTokens ?? 0,
            cost: progress?.costUsd ?? 0,
          }),
          activity(progress),
        ];
      }),
    );
    const header = [rule, truncateToWidth(theme.bold(this.options.title), width)];
    const footerText = this.confirmingCancel
      ? theme.fg("warning", "Cancel every planner? Esc or y to cancel them, any other key to keep going.")
      : theme.fg(
          "dim",
          [
            "↑↓ select agent",
            "Enter open its full trace",
            `s ${this.previewPlanners ? "preview selected agent" : "planners side by side"}`,
            live ? "Esc cancel" : "Esc close",
          ].join(" · "),
        );
    const footer = [rule, truncateToWidth(footerText, width)];
    const available = Math.max(6, height - header.length - footer.length);
    const tableHeight = Math.min(rows.length, Math.max(3, Math.floor(available * 0.4)));
    if (this.selected < this.tableScroll) this.tableScroll = this.selected;
    if (this.selected >= this.tableScroll + tableHeight) this.tableScroll = this.selected - tableHeight + 1;
    this.tableTop = header.length;
    this.shownRows = rows.slice(this.tableScroll, this.tableScroll + tableHeight);
    const table = this.shownRows.map((row, offset) => {
      const index = this.tableScroll + offset;
      const line = tableLines[index] ?? "";
      const text = truncateToWidth(`${index === this.selected ? "›" : " "} ${line}`, width);
      return index === this.selected ? theme.fg("accent", text) : row.depth > 0 ? theme.fg("muted", text) : text;
    });
    const previewHeight = Math.max(3, available - table.length - 1);
    this.previewTop = header.length + table.length + 1;
    let preview: string[];
    const panes = this.options.getPanes();
    const columns = panes.length;
    const splitWidth = columns > 0 ? Math.floor((width - (columns - 1) * SEPARATOR.length) / columns) : width;
    const useSplit = this.previewPlanners && columns > 1 && columns <= 3 && splitWidth >= MIN_SPLIT_COLUMN;
    this.lastSplitWidth = useSplit ? splitWidth : 0;
    if (useSplit) {
      const rendered = panes.map((pane) => [
        truncateToWidth(theme.fg("accent", theme.bold(`${pane.id} · ${pane.model}`)), splitWidth),
        ...this.window(pane, splitWidth, previewHeight - 1),
      ]);
      preview = [];
      for (let row = 0; row < previewHeight; row += 1) {
        preview.push(
          rendered.map((lines) => padTo(lines[row] ?? "", splitWidth)).join(theme.fg("borderMuted", SEPARATOR)),
        );
      }
    } else if (selectedPane) {
      preview = [
        truncateToWidth(
          theme.fg(
            "accent",
            theme.bold(
              `${selectedPane.id} · ${selectedPane.model}${selectedPane.label ? ` · ${selectedPane.label}` : ""}`,
            ),
          ),
          width,
        ),
        ...this.window(selectedPane, width, previewHeight - 1, true),
      ];
    } else {
      preview = [];
    }
    return [...header, ...table, rule, ...padLines(preview, previewHeight), ...footer].map((line) =>
      truncateToWidth(line, width),
    );
  }

  /** The visible slice of a pane's trace: its scroll position, or the tail when following. */
  private window(pane: TracePane, width: number, height: number, tail = false) {
    const all = this.traceLines(pane.trace, width);
    this.lastLineCounts.set(pane.id, all.length);
    const top = tail ? undefined : this.scrollTop.get(pane.id);
    const maxTop = Math.max(0, all.length - height);
    const start = top === undefined ? maxTop : Math.min(top, maxTop);
    if (all.length === 0) return [this.theme.fg("dim", "(no activity yet)")];
    return all.slice(start, start + height);
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

function activity(progress: PaneStats | undefined) {
  if (!progress) return "waiting";
  if (progress.state === "running" || progress.state === "starting") {
    return progress.wrappingUp ? "wrapping up" : (progress.lastActivity ?? "starting");
  }
  return progress.state;
}

function statLine(pane: TracePane) {
  const progress = pane.progress;
  if (!progress) return "waiting";
  return [
    ...statsCells({
      durationMs: (progress.endedAt ?? Date.now()) - progress.startedAt,
      toolCalls: progress.toolCalls,
      subagents: progress.subagentTasks,
      tokens: progress.totalTokens,
      cost: progress.costUsd,
    }),
    activity(progress),
  ]
    .filter(Boolean)
    .join(" · ");
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

function padTo(line: string, width: number) {
  const visible = visibleWidth(line);
  return visible >= width ? truncateToWidth(line, width) : line + " ".repeat(width - visible);
}

function padLines(lines: string[], height: number) {
  return lines.length >= height ? lines.slice(0, height) : [...lines, ...Array(height - lines.length).fill("")];
}

export { formatDuration };
