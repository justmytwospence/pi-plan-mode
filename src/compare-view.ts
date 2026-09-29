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
import { formatCost, formatDuration, formatTokens, type PlanCandidate } from "./multi-plan.js";
import {
  type Column,
  effortText,
  fieldLine,
  type Hint,
  hintLine,
  labeledRule,
  padLines,
  renderTable,
  rule,
  ScrollState,
  selectedRow,
  stateIcon,
  titleLine,
} from "./ui-kit.js";

export type CompareResult =
  | { kind: "use"; id: string }
  | { kind: "synthesize"; ids: string[] }
  | { kind: "traces" }
  | { kind: "close" };

export interface CompareViewOptions {
  task: string;
  candidates: readonly PlanCandidate[];
  describe(candidate: PlanCandidate): { name: string; effort?: string };
  hasTraces: boolean;
  renderMarkdown(text: string, width: number): string[];
  rows(): number;
  requestRender(): void;
  onDone(result: CompareResult): void;
}

/**
 * Step 4: pick a plan. The table compares every planner's run; below it the highlighted plan is
 * previewed and scrolls on its own. → opens it full screen, Enter uses it, and with several plans
 * Space marks plans and `m` merges the marked ones.
 */
export class CompareView implements Component {
  private cursor = 0;
  private reading = false;
  private readonly marked: Set<string>;
  private readonly scroll = new ScrollState();
  private readonly cache = new Map<string, { width: number; lines: string[] }>();
  private previewHeight = 10;
  private readerHeight = 10;
  private message: string | undefined;
  private tableTop = 0;
  private previewTop = 0;
  private previewBottom = 0;

  constructor(
    private readonly theme: Theme,
    private readonly options: CompareViewOptions,
  ) {
    this.marked = new Set(this.ready().map((candidate) => candidate.id));
    const first = options.candidates.findIndex(isReady);
    this.cursor = Math.max(0, first);
  }

  invalidate() {
    this.cache.clear();
  }

  private ready() {
    return this.options.candidates.filter(isReady);
  }

  private current() {
    return this.options.candidates[this.cursor];
  }

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    this.message = undefined;
    const candidate = this.current();
    const count = this.options.candidates.length;
    if (this.reading && candidate) {
      const page = Math.max(1, this.readerHeight - 2);
      if (is("escape", "q", "left", "h")) this.reading = false;
      else if (is("enter")) return this.use(candidate);
      else if (is("up", "k")) this.scrollPlan(candidate, -1, this.readerHeight);
      else if (is("down", "j")) this.scrollPlan(candidate, 1, this.readerHeight);
      else if (is("pageUp", "ctrl+u", "shift+space")) this.scrollPlan(candidate, -page, this.readerHeight);
      else if (is("pageDown", "ctrl+d", "space")) this.scrollPlan(candidate, page, this.readerHeight);
      else if (is("home", "g")) this.scroll.toTop(candidate.id);
      else if (is("end", "shift+g")) this.scroll.follow(candidate.id);
      else if (is("tab", "shift+tab")) this.cursor = (this.cursor + (is("tab") ? 1 : -1) + count) % count;
      else return;
      this.options.requestRender();
      return;
    }
    const half = Math.max(1, Math.floor(this.previewHeight / 2));
    if (is("escape", "q", "ctrl+c")) return this.options.onDone({ kind: "close" });
    if (is("up", "k")) this.cursor = Math.max(0, this.cursor - 1);
    else if (is("down", "j")) this.cursor = Math.min(count - 1, this.cursor + 1);
    else if (candidate && is("enter")) return this.use(candidate);
    else if (candidate && is("right", "l", "o")) {
      if (isReady(candidate)) {
        this.reading = true;
        this.scroll.toTop(candidate.id);
      } else this.message = `${candidate.id} produced no plan.`;
    } else if (candidate && is("space", "x") && this.ready().length > 1) {
      if (!isReady(candidate)) this.message = `${candidate.id} produced no plan to merge.`;
      else if (this.marked.has(candidate.id)) this.marked.delete(candidate.id);
      else this.marked.add(candidate.id);
    } else if (is("m") && this.ready().length > 1) {
      const ids = this.ready()
        .filter((plan) => this.marked.has(plan.id))
        .map((plan) => plan.id);
      if (ids.length < 2) this.message = "Mark at least two plans with Space to merge them.";
      else return this.options.onDone({ kind: "synthesize", ids });
    } else if (is("t") && this.options.hasTraces) return this.options.onDone({ kind: "traces" });
    else if (candidate && is("pageUp", "ctrl+u")) this.scrollPlan(candidate, -half, this.previewHeight);
    else if (candidate && is("pageDown", "ctrl+d")) this.scrollPlan(candidate, half, this.previewHeight);
    else if (candidate && is("home", "g")) this.scroll.toTop(candidate.id);
    else return;
    this.options.requestRender();
  }

  private use(candidate: PlanCandidate) {
    if (!isReady(candidate)) {
      this.message = `${candidate.id} produced no plan: ${candidate.error ?? candidate.status}`;
      this.options.requestRender();
      return;
    }
    this.options.onDone({ kind: "use", id: candidate.id });
  }

  private scrollPlan(candidate: PlanCandidate, delta: number, height: number) {
    const total = this.cache.get(candidate.id)?.lines.length ?? 0;
    this.scroll.scrollBy(candidate.id, delta, total, height);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const candidate = this.current();
    const wheel = event.type === "wheel" ? (event.wheelDelta ?? 0) : 0;
    if (this.reading) {
      if (event.type === "wheel" && candidate) {
        this.scrollPlan(candidate, wheel, this.readerHeight);
        this.options.requestRender();
      }
      return event.type === "move" || event.type === "release" ? undefined : { handled: true };
    }
    const count = this.options.candidates.length;
    const inTable = event.y >= this.tableTop && event.y < this.tableTop + count;
    const inPreview = event.y >= this.previewTop && event.y < this.previewBottom;
    if (event.type === "wheel") {
      if (inPreview && candidate) this.scrollPlan(candidate, wheel, this.previewHeight);
      else this.cursor = Math.min(count - 1, Math.max(0, this.cursor + Math.sign(wheel)));
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      if (inTable) {
        const index = event.y - this.tableTop;
        const target = this.options.candidates[index];
        if (target && index === this.cursor && event.x < 7 && this.ready().length > 1 && isReady(target)) {
          if (this.marked.has(target.id)) this.marked.delete(target.id);
          else this.marked.add(target.id);
        }
        this.cursor = index;
        if ((event.clickCount ?? 1) >= 2 && target && isReady(target)) {
          this.reading = true;
          this.scroll.toTop(target.id);
        }
      } else if (inPreview && candidate && isReady(candidate) && (event.clickCount ?? 1) >= 2) {
        this.reading = true;
      }
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "press" ? { handled: true } : undefined;
  }

  render(width: number): string[] {
    const height = Math.max(14, this.options.rows());
    const candidate = this.current();
    const lines =
      this.reading && candidate ? this.renderReader(candidate, width, height) : this.renderList(width, height);
    return padLines(lines, height).map((line) => truncateToWidth(line, width));
  }

  private planLines(candidate: PlanCandidate, width: number) {
    const cached = this.cache.get(candidate.id);
    if (cached && cached.width === width) return cached.lines;
    let lines: string[];
    try {
      lines = this.options.renderMarkdown(candidate.plan ?? "", width);
    } catch {
      lines = (candidate.plan ?? "")
        .split("\n")
        .flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
    }
    this.cache.set(candidate.id, { width, lines });
    return lines;
  }

  private renderList(width: number, height: number) {
    const theme = this.theme;
    const candidates = this.options.candidates;
    const ready = this.ready();
    const canMerge = ready.length > 1;
    const failed = candidates.length - ready.length;
    const header = [
      rule(theme, width),
      titleLine(
        theme,
        width,
        "Compare plans",
        `${ready.length} ready${failed ? ` · ${failed} without a plan` : ""}`,
        "Compare",
      ),
      ...(this.options.task.trim()
        ? [fieldLine(theme, width, "Task", this.options.task.trim().split("\n")[0] ?? "")]
        : []),
      "",
    ];
    const columns: Column<PlanCandidate>[] = [
      ...(canMerge
        ? [
            {
              header: "MERGE",
              get: (plan: PlanCandidate) =>
                !isReady(plan) ? "" : this.marked.has(plan.id) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]"),
            },
          ]
        : []),
      {
        header: "PLAN",
        get: (plan) =>
          `${isReady(plan) ? theme.fg("success", "✓") : stateIcon(theme, plan.status === "cancelled" ? "cancelled" : "failed")} ${theme.bold(plan.id)}`,
      },
      { header: "MODEL", flex: true, min: 12, get: (plan) => this.options.describe(plan).name },
      {
        header: "EFFORT",
        get: (plan) => (plan.origin === "session" ? "" : effortText(theme, this.options.describe(plan).effort)),
      },
      {
        header: "TIME",
        align: "right",
        get: (plan) => (plan.durationMs !== undefined ? formatDuration(plan.durationMs) : ""),
      },
      { header: "TOOLS", align: "right", get: (plan) => (plan.toolCalls !== undefined ? String(plan.toolCalls) : "") },
      { header: "SUBAGENTS", align: "right", get: (plan) => (plan.subagentTasks ? String(plan.subagentTasks) : "") },
      { header: "TOKENS", align: "right", get: (plan) => (plan.totalTokens ? formatTokens(plan.totalTokens) : "") },
      { header: "COST", align: "right", get: (plan) => (plan.costUsd ? formatCost(plan.costUsd) : "") },
      {
        header: "NOTE",
        flex: true,
        min: 8,
        get: (plan) =>
          !isReady(plan)
            ? theme.fg("error", `no plan: ${(plan.error ?? plan.status).replace(/\s+/gu, " ")}`)
            : plan.origin === "session"
              ? theme.fg("muted", "the plan from this session")
              : plan.planFromText
                ? theme.fg("warning", "taken from its reply text")
                : `${planSize(plan.plan ?? "")}`,
      },
    ];
    const table = renderTable(theme, candidates, columns, width - 3);
    this.tableTop = header.length + 1;
    const tableLines = [
      `   ${table.header}`,
      ...candidates.map((plan, index) => {
        const text = table.lines[index] ?? "";
        return index === this.cursor
          ? selectedRow(theme, width, `${theme.fg("accent", " › ")}${text}`)
          : `   ${isReady(plan) ? text : theme.fg("dim", text)}`;
      }),
      "",
    ];
    const footer = [
      rule(theme, width),
      ...(this.message ? [` ${theme.fg("warning", this.message)}`] : []),
      hintLine(theme, width, this.hints()),
    ];
    const previewArea = Math.max(3, height - header.length - tableLines.length - footer.length);
    this.previewHeight = previewArea - 1;
    const candidate = this.current();
    this.previewTop = header.length + tableLines.length + 1;
    this.previewBottom = this.previewTop + this.previewHeight;
    let preview: string[];
    if (candidate && isReady(candidate)) {
      const lines = this.planLines(candidate, width - 2);
      this.startAtTop(candidate.id);
      const view = this.scroll.window(candidate.id, lines, this.previewHeight);
      const shown = view.lines;
      const where =
        lines.length > this.previewHeight
          ? `${view.start + 1}–${view.start + shown.length} of ${lines.length} lines`
          : "";
      preview = [
        labeledRule(
          theme,
          width,
          theme.fg("accent", theme.bold(`Plan ${candidate.id} · ${this.options.describe(candidate).name}`)),
          theme.fg("dim", where),
          "borderAccent",
        ),
        ...shown.map((line) => ` ${line}`),
      ];
    } else if (candidate) {
      preview = [
        labeledRule(theme, width, theme.fg("error", `${candidate.id} · ${this.options.describe(candidate).name}`)),
        ...wrapTextWithAnsi(
          theme.fg("muted", `No plan. ${candidate.error ?? candidate.status}`),
          Math.max(10, width - 2),
        ).map((line) => ` ${line}`),
        ...(this.options.hasTraces ? ["", theme.fg("dim", " Press t to see what it did.")] : []),
      ];
    } else preview = [];
    return [...header, ...tableLines, ...padLines(preview, previewArea), ...footer];
  }

  private readonly opened = new Set<string>();

  /** Plans are read from the top (a ScrollState without a position follows the end). */
  private startAtTop(id: string) {
    if (this.opened.has(id)) return;
    this.opened.add(id);
    this.scroll.toTop(id);
  }

  private renderReader(candidate: PlanCandidate, width: number, height: number) {
    const theme = this.theme;
    const described = this.options.describe(candidate);
    const header = [
      rule(theme, width),
      titleLine(
        theme,
        width,
        `Plan ${candidate.id}`,
        [described.name, described.effort ? `effort ${described.effort}` : ""].filter(Boolean).join(" · "),
        "Compare",
      ),
    ];
    const footer = [
      rule(theme, width),
      hintLine(theme, width, [
        { key: "⏎", label: `use plan ${candidate.id}`, primary: true },
        { key: "↑↓", label: "scroll" },
        { key: "space", label: "page" },
        { key: "g/G", label: "top/end" },
        { key: "tab", label: "next plan" },
        { key: "esc", label: "back to all plans" },
      ]),
    ];
    this.readerHeight = Math.max(3, height - header.length - footer.length - 1);
    const lines = isReady(candidate) ? this.planLines(candidate, width - 2) : [theme.fg("muted", "No plan.")];
    this.startAtTop(candidate.id);
    const view = this.scroll.window(candidate.id, lines, this.readerHeight);
    const where = `${view.start + 1}–${view.start + view.lines.length} of ${lines.length} lines`;
    return [
      ...header,
      labeledRule(theme, width, "", theme.fg("dim", where)),
      ...padLines(
        view.lines.map((line) => ` ${line}`),
        this.readerHeight,
      ),
      ...footer,
    ];
  }

  private hints(): Hint[] {
    const candidate = this.current();
    const ready = this.ready();
    const marked = ready.filter((plan) => this.marked.has(plan.id)).map((plan) => plan.id);
    const hints: Hint[] = [];
    if (candidate && isReady(candidate)) {
      hints.push({ key: "⏎", label: `use plan ${candidate.id}`, primary: true }, { key: "→", label: "read it" });
    }
    if (ready.length > 1) {
      hints.push({ key: "m", label: marked.length >= 2 ? `merge ${marked.join("+")}` : "merge (mark 2+)" });
      hints.push({ key: "space", label: candidate && this.marked.has(candidate.id) ? "unmark" : "mark" });
    }
    hints.push({ key: "↑↓", label: "choose" }, { key: "PgUp/PgDn", label: "scroll plan" });
    if (this.options.hasTraces) hints.push({ key: "t", label: "traces" });
    hints.push({ key: "esc", label: "decide later" });
    return hints;
  }
}

function isReady(candidate: PlanCandidate) {
  return candidate.status === "done" && Boolean(candidate.plan);
}

function planSize(plan: string) {
  const steps = plan.split("\n").filter((line) => /^\s*(?:\d+[.)]|[-*])\s+/u.test(line)).length;
  const words = plan.split(/\s+/u).filter(Boolean).length;
  return `${words.toLocaleString("en-US")} words${steps ? ` · ${steps} steps` : ""}`;
}
