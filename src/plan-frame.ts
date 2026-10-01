import { type ExtensionContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { parseModelSpec } from "./implementation-models.js";
import { modelCatalog } from "./model-catalog.js";
import { type CandidateSet, candidateSummary, type PlanCandidate } from "./multi-plan.js";
import { fieldLine, labeledRule, padVisible, rule, ScrollState, titleLine } from "./ui-kit.js";

/** One plan shown above a decision menu. */
export interface FramedPlan {
  id: string;
  /** `A · Claude Fable 5.1` */
  title: string;
  /** Short stats on the lane's rule, e.g. `4m 12s · 23 tools · $1.20`. */
  detail?: string;
  plan: string;
}

/** What you are deciding about: the task you gave and the plan(s) it produced. */
export interface PlanFrame {
  title: string;
  task?: string;
  plans: readonly FramedPlan[];
  /** The plan the menu's actions are about, highlighted. */
  focus?: string;
}

/** Every plan in a multi-model run, side by side, with `focus` highlighted. */
export function candidatePlanFrame(ctx: ExtensionContext, set: CandidateSet, title: string, focus?: string): PlanFrame {
  const catalog = modelCatalog(ctx);
  const name = (candidate: PlanCandidate) => {
    // Planner labels are model specs (`provider/model:effort`); the session plan names its model.
    const spec = parseModelSpec(candidate.label);
    if (spec) return `${catalog.name(spec)}${spec.thinkingLevel ? ` ${spec.thinkingLevel}` : ""}`;
    if (candidate.model) return `current plan · ${catalog.name(candidate.model)}`;
    return candidate.label;
  };
  const plans = set.candidates.flatMap((candidate) =>
    candidate.status === "done" && candidate.plan
      ? [
          {
            id: candidate.id,
            title: `${candidate.id} · ${name(candidate)}${candidate.revision && candidate.revision > 1 ? ` · v${candidate.revision}` : ""}`,
            detail: [candidateSummary(candidate), talkNote(candidate)].filter(Boolean).join(" · "),
            plan: candidate.plan,
          },
        ]
      : [],
  );
  return { title, task: set.task, plans, ...(focus ? { focus } : {}) };
}

function talkNote(candidate: PlanCandidate) {
  const yours = (candidate.thread ?? []).filter((entry) => entry.role === "user").length;
  return yours ? `you talked ${yours}×` : "";
}

const FULL_SCREEN = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
} as const;
const LANE_GAP = " │ ";
const MIN_LANE_WIDTH = 36;
const MAX_TASK_LINES = 3;
/** Plan rows (with their rule) that always stay visible above the menu. */
const MIN_LANE_ROWS = 5;

/**
 * Show a decision menu (a pi-tui-kit menu) under the context it decides about: your task at the
 * top, then the plans side by side, each scrolling on its own, then the menu. Only plain menu
 * screens are framed; anything opened with its own layout passes through unchanged.
 */
export function withPlanFrame<Context extends ExtensionContext>(ctx: Context, frame: PlanFrame): Context {
  if (ctx.mode !== "tui" || frame.plans.length === 0) return ctx;
  const ui = ctx.ui;
  const custom: typeof ui.custom = (factory, options) => {
    if (options !== undefined) return ui.custom(factory, options);
    return ui.custom((tui, theme, keybindings, done) => {
      const view = new PlanFrameView(
        theme,
        frame,
        () => terminalRows(tui),
        () => tui.requestRender(),
      );
      // The menu sizes itself to the rows left under the plans.
      const menuTui = new Proxy(tui, {
        get(target, property) {
          if (property === "terminal") {
            return new Proxy(target.terminal, {
              get(terminal, key) {
                if (key === "rows") return view.menuRows() + 3;
                const value = Reflect.get(terminal, key, terminal);
                return typeof value === "function" ? value.bind(terminal) : value;
              },
            });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const created = factory(menuTui, theme, keybindings, done);
      const frameIt = (inner: Awaited<typeof created>) => view.wrap(inner);
      return created instanceof Promise ? created.then(frameIt) : frameIt(created);
    }, FULL_SCREEN) as never;
  };
  const framedUi = new Proxy(ui, {
    get(target, property) {
      if (property === "custom") return custom;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "ui") return framedUi;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type Inner = Component & {
  dispose?(): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  focused?: boolean;
};

export class PlanFrameView {
  private focusIndex: number;
  private readonly scroll = new ScrollState();
  private readonly opened = new Set<string>();
  private readonly cache = new Map<string, { width: number; lines: string[] }>();
  private readonly lineCounts = new Map<string, number>();
  private laneHeight = 10;
  private laneTop = 0;
  private laneBottom = 0;
  private laneLayout: Array<{ x: number; width: number; plan: FramedPlan }> = [];
  private menuTop = 0;
  private menuBudget = 12;

  constructor(
    private readonly theme: Theme,
    private readonly frame: PlanFrame,
    private readonly rows: () => number,
    private readonly requestRender: () => void,
  ) {
    this.focusIndex = Math.max(
      0,
      frame.plans.findIndex((plan) => plan.id === frame.focus),
    );
  }

  /** Rows the menu may use: all it needs, as long as a few rows of the plans stay visible. */
  menuRows() {
    return this.menuBudget;
  }

  /** The framed component: the menu keeps every key except plan scrolling and switching. */
  wrap(inner: Inner): Inner {
    if (!(inner as { __piTuiKitScreen?: boolean }).__piTuiKitScreen) return inner;
    const framed: Inner = {
      render: (width) => this.render(width, inner),
      handleInput: (data) => {
        if (!this.handleInput(data)) inner.handleInput?.(data);
      },
      handleMouse: (event) => this.handleMouse(event, inner),
      invalidate: () => {
        this.cache.clear();
        inner.invalidate();
      },
      dispose: () => inner.dispose?.(),
    };
    // Still the same menu screen underneath: keep what callers look for on it.
    Object.defineProperty(framed, "__piTuiKitScreen", { value: true });
    const pending = (inner as { waitForPending?: () => Promise<void> }).waitForPending;
    if (pending) Object.assign(framed, { waitForPending: () => pending.call(inner) });
    if ("focused" in inner) {
      Object.defineProperty(framed, "focused", {
        get: () => inner.focused,
        set: (value: boolean) => {
          inner.focused = value;
        },
      });
    }
    return framed;
  }

  private header(width: number) {
    const theme = this.theme;
    const plans = this.frame.plans;
    const keys =
      plans.length > 1 ? "PgUp/PgDn scroll · tab next plan · wheel scrolls a plan" : "PgUp/PgDn scroll the plan";
    const taskLines = this.frame.task?.trim()
      ? wrapTextWithAnsi(this.frame.task.trim().replace(/\s+/gu, " "), Math.max(10, width - 8))
      : [];
    const shownTask =
      taskLines.length > MAX_TASK_LINES
        ? [...taskLines.slice(0, MAX_TASK_LINES - 1), `${taskLines[MAX_TASK_LINES - 1] ?? ""}…`]
        : taskLines;
    return [
      rule(theme, width),
      titleLine(theme, width, this.frame.title, theme.fg("dim", keys)),
      ...shownTask.map((line, index) => fieldLine(theme, width, index === 0 ? "Task" : "", line)),
      "",
    ];
  }

  render(width: number, inner: Inner): string[] {
    const theme = this.theme;
    const height = Math.max(16, this.rows());
    const header = this.header(width);
    this.menuBudget = Math.max(6, height - header.length - MIN_LANE_ROWS);
    const menu = inner.render(width);
    const laneArea = Math.max(4, height - header.length - menu.length);
    this.laneHeight = laneArea - 1;
    const plans = this.frame.plans;
    const fits = Math.floor((width - (plans.length - 1) * LANE_GAP.length) / Math.max(1, plans.length));
    const sideBySide = plans.length > 1 && plans.length <= 3 && fits >= MIN_LANE_WIDTH;
    const shown = sideBySide ? plans : [plans[this.focusIndex] ?? plans[0]].filter((plan) => plan !== undefined);
    const laneWidth = sideBySide ? fits : width;
    this.laneTop = header.length + 1;
    this.laneBottom = header.length + laneArea;
    this.laneLayout = shown.map((plan, index) => ({
      x: index * (laneWidth + LANE_GAP.length),
      width: laneWidth,
      plan,
    }));
    const lanes = shown.map((plan) => this.lane(plan, laneWidth, plans.length > 1 && !sideBySide));
    const laneLines: string[] = [];
    for (let line = 0; line < laneArea; line += 1) {
      laneLines.push(
        lanes.map((lane) => padVisible(lane[line] ?? "", laneWidth)).join(theme.fg("borderMuted", LANE_GAP)),
      );
    }
    this.menuTop = header.length + laneLines.length;
    return [...header, ...laneLines, ...menu].map((line) => truncateToWidth(line, width));
  }

  private lane(plan: FramedPlan, width: number, paged: boolean) {
    const theme = this.theme;
    const all = this.planLines(plan, width);
    this.lineCounts.set(plan.id, all.length);
    if (!this.opened.has(plan.id)) {
      this.opened.add(plan.id);
      this.scroll.toTop(plan.id);
    }
    const view = this.scroll.window(plan.id, all, this.laneHeight);
    const focused = this.frame.plans[this.focusIndex]?.id === plan.id;
    const index = this.frame.plans.indexOf(plan);
    const title = `${plan.title}${paged ? `  ${index + 1}/${this.frame.plans.length}` : ""}`;
    const right = [
      plan.detail ? theme.fg("dim", plan.detail) : "",
      view.below > 0 ? theme.fg("muted", `${view.below} more ↓`) : "",
    ]
      .filter(Boolean)
      .join(theme.fg("dim", " · "));
    const head = labeledRule(
      theme,
      width,
      focused ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title),
      right,
      focused ? "borderAccent" : "borderMuted",
    );
    return [head, ...view.lines];
  }

  private planLines(plan: FramedPlan, width: number) {
    const key = `${plan.id}`;
    const cached = this.cache.get(key);
    if (cached?.width === width) return cached.lines;
    let lines: string[];
    try {
      lines = new Markdown(plan.plan, 0, 0, getMarkdownTheme()).render(Math.max(1, width));
    } catch {
      lines = plan.plan.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
    }
    this.cache.set(key, { width, lines });
    return lines;
  }

  /** True when the key was for the plans. */
  handleInput(data: string) {
    const plan = this.frame.plans[this.focusIndex];
    if (!plan) return false;
    const page = Math.max(1, this.laneHeight - 2);
    const count = this.frame.plans.length;
    if (matchesKey(data, "pageUp")) this.scrollPlan(plan, -page);
    else if (matchesKey(data, "pageDown")) this.scrollPlan(plan, page);
    else if (count > 1 && matchesKey(data, "tab")) this.focusIndex = (this.focusIndex + 1) % count;
    else if (count > 1 && matchesKey(data, "shift+tab")) this.focusIndex = (this.focusIndex - 1 + count) % count;
    else return false;
    this.requestRender();
    return true;
  }

  private scrollPlan(plan: FramedPlan, delta: number) {
    this.scroll.scrollBy(plan.id, delta, this.lineCounts.get(plan.id) ?? 0, this.laneHeight);
  }

  handleMouse(event: TuiMouseEvent, inner: Inner): TuiMouseEventResult | undefined {
    if (event.y >= this.menuTop) {
      return inner.handleMouse?.({ ...event, y: event.y - this.menuTop }) ?? { handled: true };
    }
    const lane =
      event.y >= this.laneTop && event.y < this.laneBottom
        ? this.laneLayout.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width + 1)
        : undefined;
    if (event.type === "wheel" && lane) {
      this.scrollPlan(lane.plan, Math.sign(event.wheelDelta ?? 0) * 3);
      this.requestRender();
      return { handled: true };
    }
    if (event.type === "click" && lane) {
      this.focusIndex = Math.max(0, this.frame.plans.indexOf(lane.plan));
      this.requestRender();
    }
    return event.type === "move" || event.type === "release" ? undefined : { handled: true };
  }
}

function terminalRows(tui: unknown) {
  const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
  return typeof rows === "number" && rows > 0 ? rows : 40;
}
