/**
 * Shared building blocks for the multi-model planning screens, so every screen has the same
 * header (title, context, workflow steps), the same selection bar, and the same footer of
 * context-sensitive key hints.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const WORKFLOW_STEPS = ["Settings", "Tools", "Planning", "Review", "Implement"] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface Hint {
  key: string;
  label: string;
  /** The action most people want next; drawn brighter. */
  primary?: boolean;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function spinner(now = Date.now()) {
  return SPINNER[Math.floor(now / 120) % SPINNER.length] ?? "⠋";
}

/** `✓ Settings ─ ● Tools ─ ○ Planning ─ ○ Review ─ ○ Implement` */
export function stepBar(theme: Theme, current: WorkflowStep) {
  const index = WORKFLOW_STEPS.indexOf(current);
  return WORKFLOW_STEPS.map((step, position) =>
    position < index
      ? theme.fg("success", `✓ ${step}`)
      : position === index
        ? theme.fg("accent", theme.bold(`● ${step}`))
        : theme.fg("dim", `○ ${step}`),
  ).join(theme.fg("dim", " ─ "));
}

/** Title (bold) and dim context on the left, workflow steps on the right when they fit. */
export function titleLine(theme: Theme, width: number, title: string, context = "", step?: WorkflowStep) {
  const left = ` ${theme.bold(title)}${context ? `  ${theme.fg("muted", context)}` : ""}`;
  const right = step ? `${stepBar(theme, step)} ` : "";
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (right && gap >= 2) return `${left}${" ".repeat(gap)}${right}`;
  return truncateToWidth(left, width);
}

/** A labelled field such as ` Task  Add a cache layer`. */
export function fieldLine(theme: Theme, width: number, label: string, value: string) {
  return truncateToWidth(` ${theme.fg("dim", label.padEnd(5))} ${value}`, width);
}

export function rule(theme: Theme, width: number, color: ThemeColor = "borderMuted") {
  return theme.fg(color, "─".repeat(Math.max(0, width)));
}

/** `── left ─────────── right ──` */
export function labeledRule(theme: Theme, width: number, left: string, right = "", color: ThemeColor = "borderMuted") {
  const head = visibleWidth(left) > 0 ? `${theme.fg(color, "──")} ${left} ` : "";
  const tail = visibleWidth(right) > 0 ? ` ${right} ${theme.fg(color, "──")}` : "";
  const fill = width - visibleWidth(head) - visibleWidth(tail);
  if (fill < 1) return truncateToWidth(`${head}${tail}`, width);
  return `${head}${theme.fg(color, "─".repeat(fill))}${tail}`;
}

/**
 * Key hints in the given order. When space runs out, the least important hints go first (from the
 * end), but the primary action and the way out (esc) always stay.
 */
export function hintLine(theme: Theme, width: number, hints: readonly Hint[]) {
  const render = (hint: Hint) =>
    hint.primary
      ? `${theme.fg("accent", theme.bold(hint.key))} ${theme.fg("text", hint.label)}`
      : `${theme.fg("accent", hint.key)} ${theme.fg("muted", hint.label)}`;
  const kept = [...hints];
  const join = () => ` ${kept.map(render).join("   ")}`;
  for (let index = kept.length - 1; index >= 0 && visibleWidth(join()) > width; index -= 1) {
    const hint = kept[index];
    if (hint && !hint.primary && hint.key !== "esc") kept.splice(index, 1);
  }
  return truncateToWidth(join(), width, "…");
}

/** Highlight a whole row as the selection. */
export function selectedRow(theme: Theme, width: number, line: string) {
  return theme.bg("selectedBg", padVisible(line, width));
}

const EFFORT_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

/** Effort (thinking level) in Pi's own thinking colors; `default` when the model's default applies. */
export function effortText(theme: Theme, level: string | undefined) {
  if (!level) return theme.fg("dim", "default");
  const color = EFFORT_COLORS[level];
  if (!color) return level;
  try {
    return theme.fg(color, level);
  } catch {
    // Optional theme colors (thinkingMax) may be missing.
    return theme.fg("thinkingXhigh", level);
  }
}

export type AgentState = "waiting" | "starting" | "running" | "done" | "failed" | "cancelled" | "timeout";

export function stateIcon(theme: Theme, state: AgentState, now = Date.now()) {
  switch (state) {
    case "running":
    case "starting":
      return theme.fg("accent", spinner(now));
    case "done":
      return theme.fg("success", "✓");
    case "failed":
    case "timeout":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("dim", "–");
    default:
      return theme.fg("dim", "·");
  }
}

export interface Column<T> {
  header: string;
  get(row: T): string;
  align?: "left" | "right";
  /** May be truncated (down to `min`) when the table is too wide; the last flexible column absorbs the rest. */
  flex?: boolean;
  min?: number;
}

/**
 * Fit rows into columns: every column is as wide as its widest cell, flexible columns shrink when
 * the table is too wide, and empty columns disappear.
 */
export function renderTable<T>(theme: Theme, rows: readonly T[], columns: readonly Column<T>[], width: number) {
  const cells = rows.map((row) => columns.map((column) => column.get(row)));
  const used = columns.map((_column, index) => cells.some((row) => visibleWidth(row[index] ?? "") > 0));
  const visible = columns.map((column, index) => ({ column, index })).filter(({ index }) => used[index]);
  const gap = 2;
  const widths = visible.map(({ column, index }) =>
    Math.max(visibleWidth(column.header), ...cells.map((row) => visibleWidth(row[index] ?? ""))),
  );
  let overflow = widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, visible.length - 1) - width;
  // Take one column at a time from the widest flexible column, so long cells give way first.
  const mins = visible.map(({ column }) => Math.max(column.min ?? 6, visibleWidth(column.header)));
  while (overflow > 0) {
    let widest = -1;
    for (let position = 0; position < visible.length; position += 1) {
      if (!visible[position]?.column.flex || (widths[position] ?? 0) <= (mins[position] ?? 0)) continue;
      if (widest < 0 || (widths[position] ?? 0) > (widths[widest] ?? 0)) widest = position;
    }
    if (widest < 0) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    overflow -= 1;
  }
  const format = (texts: readonly string[]) =>
    visible
      .map(({ column }, position) => {
        const text = texts[position] ?? "";
        const target = widths[position] ?? 0;
        const fitted = visibleWidth(text) > target ? truncateToWidth(text, target, "…") : text;
        const pad = " ".repeat(Math.max(0, target - visibleWidth(fitted)));
        const isLast = position === visible.length - 1;
        return column.align === "right" ? pad + fitted : isLast ? fitted : fitted + pad;
      })
      .join(" ".repeat(gap));
  return {
    header: theme.fg("dim", format(visible.map(({ column }) => column.header))),
    lines: cells.map((row) => format(visible.map(({ index }) => row[index] ?? ""))),
  };
}

export function padVisible(text: string, width: number) {
  const visible = visibleWidth(text);
  return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

/** Placeholder text in an input: lighter than what you type, but still easy to read. */
export function placeholderStyle(theme: Theme) {
  return (text: string) => theme.fg("muted", text);
}

export function padLines(lines: readonly string[], height: number) {
  return lines.length >= height ? lines.slice(0, height) : [...lines, ...Array(height - lines.length).fill("")];
}

/** Scroll state for one scrollable text area: `undefined` top means "follow the end". */
export class ScrollState {
  private readonly tops = new Map<string, number | undefined>();

  top(id: string) {
    return this.tops.get(id);
  }

  following(id: string) {
    return this.tops.get(id) === undefined;
  }

  /** Scroll by `delta` lines within `total` lines shown `height` at a time. */
  scrollBy(id: string, delta: number, total: number, height: number) {
    const maxTop = Math.max(0, total - height);
    // Everything fits: nothing to scroll, keep following.
    if (maxTop === 0) return this.tops.set(id, undefined);
    const current = this.tops.get(id) ?? maxTop;
    const next = current + delta;
    this.tops.set(id, next >= maxTop ? undefined : Math.max(0, next));
  }

  toTop(id: string) {
    this.tops.set(id, 0);
  }

  follow(id: string) {
    this.tops.set(id, undefined);
  }

  /** The window to draw and where it sits, for scroll indicators. */
  window<T>(id: string, lines: readonly T[], height: number) {
    const maxTop = Math.max(0, lines.length - height);
    const stored = this.tops.get(id);
    const start = stored === undefined ? maxTop : Math.min(stored, maxTop);
    return { lines: lines.slice(start, start + height), start, below: Math.max(0, lines.length - start - height) };
  }
}
