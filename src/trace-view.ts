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
import type { PlannerProgress } from "./planner-process.js";
import type { PlannerTrace, TraceEntry } from "./planner-trace.js";

export interface TracePane {
  id: string;
  label: string;
  trace: PlannerTrace;
  progress?: PlannerProgress;
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

const MIN_SPLIT_COLUMN = 40;
const SEPARATOR = " │ ";

/**
 * A scrollable view of every planner's live trace: side by side when the terminal is wide enough,
 * otherwise one planner at a time with tabs. Each pane follows new output until scrolled up.
 */
export class TraceView implements Component {
  private focus = 0;
  private split = true;
  private readonly scrollTop = new Map<string, number | undefined>();
  private confirmingCancel = false;
  private readonly lineCache = new WeakMap<TraceEntry, { key: string; lines: string[] }>();

  constructor(
    private readonly theme: Theme,
    private readonly options: TraceViewOptions,
  ) {}

  invalidate() {
    // Lines are rebuilt from the traces on every render; cached wraps are keyed by width.
  }

  handleInput(data: string) {
    const panes = this.options.getPanes();
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    if (this.confirmingCancel) {
      this.confirmingCancel = false;
      if (is("escape", "y")) this.options.onCancel();
      this.options.requestRender();
      return;
    }
    if (is("escape", "q")) {
      if (this.options.isLive()) this.confirmingCancel = true;
      else this.options.onClose();
    } else if (is("enter") && !this.options.isLive()) {
      this.options.onClose();
    } else if (is("tab", "right", "l")) {
      this.focus = (this.focus + 1) % Math.max(1, panes.length);
    } else if (is("shift+tab", "left", "h")) {
      this.focus = (this.focus - 1 + panes.length) % Math.max(1, panes.length);
    } else if (is("s")) {
      this.split = !this.split;
    } else {
      const pane = panes[this.focus];
      if (!pane) return;
      const bodyHeight = this.lastBodyHeight;
      const total = this.lastLineCounts.get(pane.id) ?? 0;
      const maxTop = Math.max(0, total - bodyHeight);
      const current = this.scrollTop.get(pane.id) ?? maxTop;
      const move = (top: number | undefined) =>
        this.scrollTop.set(pane.id, top === undefined || top >= maxTop ? undefined : Math.max(0, top));
      if (is("up", "k")) move(current - 1);
      else if (is("down", "j")) move(current + 1);
      else if (is("pageUp", "ctrl+u")) move(current - Math.max(1, Math.floor(bodyHeight / 2)));
      else if (is("pageDown", "ctrl+d")) move(current + Math.max(1, Math.floor(bodyHeight / 2)));
      else if (is("home", "g")) move(0);
      else if (is("end", "shift+g")) move(undefined);
      else return;
    }
    this.options.requestRender();
  }

  /** Mouse wheel scrolls the pane under the pointer (or the focused one); a click focuses a pane. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const panes = this.options.getPanes();
    if (this.lastSplitWidth > 0 && panes.length > 1) {
      const column = Math.floor(event.x / (this.lastSplitWidth + SEPARATOR.length));
      if ((event.type === "click" || event.type === "wheel") && column >= 0 && column < panes.length)
        this.focus = column;
    }
    if (event.type === "wheel") {
      const pane = panes[this.focus];
      if (!pane) return { handled: true };
      const total = this.lastLineCounts.get(pane.id) ?? 0;
      const maxTop = Math.max(0, total - this.lastBodyHeight);
      const current = this.scrollTop.get(pane.id) ?? maxTop;
      const next = current + Math.sign(event.wheelDelta ?? 0) * 3;
      this.scrollTop.set(pane.id, next >= maxTop ? undefined : Math.max(0, next));
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click") {
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "press" ? { handled: true } : undefined;
  }

  private lastSplitWidth = 0;
  private lastBodyHeight = 10;
  private readonly lastLineCounts = new Map<string, number>();

  render(width: number): string[] {
    const theme = this.theme;
    const panes = this.options.getPanes();
    if (this.focus >= panes.length) this.focus = 0;
    const height = Math.max(12, this.options.rows());
    const live = this.options.isLive();

    const summary = alignColumns(
      panes.map((pane) => {
        const progress = pane.progress;
        const icon = !progress
          ? "·"
          : progress.state === "done"
            ? "✓"
            : progress.state === "running" || progress.state === "starting"
              ? "…"
              : "✗";
        return [
          `${icon} ${pane.id} ${pane.label}`,
          ...statsCells({
            ...(progress ? { durationMs: (progress.endedAt ?? Date.now()) - progress.startedAt } : {}),
            ...(progress ? { toolCalls: progress.toolCalls } : {}),
            subagents: progress?.subagentTasks ?? 0,
            tokens: progress?.totalTokens ?? 0,
            cost: progress?.costUsd ?? 0,
          }),
          progress?.wrappingUp && progress.state === "running" ? "wrapping up" : "",
        ];
      }),
    ).map((line, index) => {
      const text = truncateToWidth(line, width);
      return index === this.focus ? theme.fg("accent", text) : text;
    });

    const header = [
      theme.fg("borderMuted", "─".repeat(width)),
      truncateToWidth(theme.bold(this.options.title), width),
      ...summary,
      theme.fg("borderMuted", "─".repeat(width)),
    ];
    const footerText = this.confirmingCancel
      ? theme.fg("warning", "Cancel every planner? Esc or y to cancel them, any other key to keep going.")
      : theme.fg(
          "dim",
          [
            panes.length > 1 ? "tab/←→ switch" : "",
            "↑↓ j/k scroll",
            "PgUp/PgDn",
            "End follow",
            panes.length > 1 ? `s ${this.split ? "one at a time" : "side by side"}` : "",
            live ? "Esc cancel" : "Esc/Enter close",
          ]
            .filter(Boolean)
            .join(" · "),
        );
    const footer = [theme.fg("borderMuted", "─".repeat(width)), truncateToWidth(footerText, width)];
    const bodyHeight = Math.max(3, height - header.length - footer.length - 1);
    this.lastBodyHeight = bodyHeight;

    const columns = panes.length;
    const splitWidth = columns > 0 ? Math.floor((width - (columns - 1) * SEPARATOR.length) / columns) : width;
    const useSplit = this.split && columns > 1 && columns <= 3 && splitWidth >= MIN_SPLIT_COLUMN;
    this.lastSplitWidth = useSplit ? splitWidth : 0;
    const body: string[] = [];
    if (useSplit) {
      const rendered = panes.map((pane, index) => this.paneLines(pane, splitWidth, bodyHeight, index === this.focus));
      for (let row = 0; row < bodyHeight + 1; row += 1) {
        body.push(
          rendered.map((lines) => padTo(lines[row] ?? "", splitWidth)).join(theme.fg("borderMuted", SEPARATOR)),
        );
      }
    } else if (panes[this.focus]) {
      const tabs = panes
        .map((pane, index) => {
          const tab = ` ${pane.id} · ${pane.label} `;
          return index === this.focus ? theme.inverse(tab) : theme.fg("dim", tab);
        })
        .join(" ");
      const pane = panes[this.focus] as TracePane;
      const lines = this.paneLines(pane, width, bodyHeight, true, false);
      body.push(truncateToWidth(tabs, width), ...lines.slice(0, bodyHeight));
    }
    return [...header, ...body, ...footer].map((line) => truncateToWidth(line, width));
  }

  /** A pane's heading plus its visible window of trace lines. */
  private paneLines(pane: TracePane, width: number, height: number, focused: boolean, withHeading = true) {
    const theme = this.theme;
    const all = this.traceLines(pane.trace, width);
    this.lastLineCounts.set(pane.id, all.length);
    const top = this.scrollTop.get(pane.id);
    const maxTop = Math.max(0, all.length - height);
    const start = top === undefined ? maxTop : Math.min(top, maxTop);
    const window = all.slice(start, start + height);
    const following = top === undefined;
    const heading = `${pane.id} · ${pane.label}${following ? "" : ` · ${start + 1}-${start + window.length}/${all.length}`}`;
    const headingLine = focused ? theme.fg("accent", theme.bold(heading)) : theme.fg("muted", heading);
    return withHeading ? [truncateToWidth(headingLine, width), ...window] : window;
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
        rendered = wrap(entry.text.trim(), width).map((line) => theme.fg("dim", theme.italic(line)));
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

export { formatDuration };
