import { type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { defineMenu, runMenu, runTask, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { CompareView } from "./compare-view.js";
import {
  type AvailableImplementationModel,
  formatModelKey,
  formatModelSpec,
  MODEL_SPEC_THINKING_LEVELS,
  type ModelSpec,
  type ModelSpecThinkingLevel,
  parseModelSpec,
  sameModel,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { type ModelPickerRow, ModelPickerView } from "./model-picker-view.js";
import { alignColumns, type CandidateSet, candidateSummary, type PlanCandidate, statsCells } from "./multi-plan.js";
import type { PlannerProgress } from "./planner-process.js";
import { PlannerTrace } from "./planner-trace.js";
import type { SubagentView } from "./subagent-progress.js";
import { leaves, type ToolNode } from "./tool-tree.js";
import { type ToolPreselection, type ToolTreeResult, ToolTreeView } from "./tool-tree-view.js";
import { type TracePane, TraceView } from "./trace-view.js";

interface Lifecycle {
  signal: AbortSignal;
  isCurrent(): boolean;
}

const PROGRESS_WIDGET_KEY = "plan-mode-planners";

/**
 * The planning screens are overlays, so every key (PgUp, Home, ...) and wheel event reaches them
 * even in Pi's fullscreen mode. Dashboards take the whole terminal; pickers rise from the bottom
 * and are only as tall as their content.
 */
const FULL_SCREEN = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
} as const;
const SHEET = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center", margin: 0 },
} as const;

function terminalRows(tui: unknown) {
  const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
  return typeof rows === "number" && rows > 0 ? rows : 40;
}

type RegistryModel = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
  contextWindow?: number;
  cost?: { input?: number; output?: number };
};

/** Friendly names and supported efforts from the model registry. */
export function modelCatalog(ctx: ExtensionContext) {
  let available: RegistryModel[] = [];
  try {
    available = snapshotAvailableImplementationModels(ctx) as RegistryModel[];
  } catch {
    available = [];
  }
  const find = (spec: { provider: string; modelId: string }) =>
    available.find((model) => model.provider === spec.provider && model.id === spec.modelId);
  return {
    available,
    name(spec: { provider: string; modelId: string }) {
      return safeText(find(spec)?.name || spec.modelId);
    },
    /** Effort levels a model accepts, mirroring Pi's own rules; `undefined` is the model default. */
    efforts(spec: { provider: string; modelId: string }): Array<ModelSpecThinkingLevel | undefined> {
      const model = find(spec);
      if (!model?.reasoning) return [undefined];
      const levels = MODEL_SPEC_THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        if (level === "xhigh" || level === "max") return mapped !== undefined;
        return true;
      });
      return [undefined, ...levels];
    },
    /** `anthropic/claude-opus-5-5 · 200k context · $5 in / $25 out per M tokens` */
    details(spec: { provider: string; modelId: string }) {
      const model = find(spec);
      const parts = [`${spec.provider}/${spec.modelId}`];
      if (model?.contextWindow) parts.push(`${formatContext(model.contextWindow)} context`);
      const input = model?.cost?.input;
      const output = model?.cost?.output;
      if (input || output) parts.push(`$${trimCost(input ?? 0)} in / $${trimCost(output ?? 0)} out per M tokens`);
      return safeText(parts.join(" · "));
    },
    /** `Claude Opus 5.5 · high` for a spec string or spec. */
    describe(value: string | ModelSpec) {
      const spec = typeof value === "string" ? parseModelSpec(value) : value;
      if (!spec) return { name: safeText(String(value)), effort: undefined as string | undefined };
      return { name: this.name(spec), effort: spec.thinkingLevel as string | undefined };
    },
  };
}

export interface PlannerCapabilityRow {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
}

export interface ChoosePlannersOptions extends Lifecycle {
  title: string;
  lines?: readonly string[];
  preselected: readonly ModelSpec[];
  /** Tool access toggles shown above the models; the chosen ids are returned. */
  capabilities?: readonly PlannerCapabilityRow[];
  /** Label of the confirm row (default "Start planning with N models"). */
  startLabel?: string;
  /** Full-screen view: the task line, extra notes, and each planner's subagent model. */
  task?: string;
  notes?: readonly string[];
  subagentsFor?(spec: ModelSpec): ModelSpec | undefined;
}

export interface PlannerChoice {
  specs: ModelSpec[];
  capabilities: string[];
}

/**
 * Let the user confirm or change which models plan in parallel. Configured specs (which may carry
 * an effort suffix) come first, then every other available model.
 */
export async function choosePlanners(
  ctx: ExtensionContext,
  options: ChoosePlannersOptions,
): Promise<PlannerChoice | undefined> {
  if (ctx.mode === "tui" && !options.capabilities?.length) return choosePlannersFullScreen(ctx, options);
  const available = snapshotAvailableImplementationModels(ctx);
  const rows = plannerRows(options.preselected, available);
  const selected = new Set(rows.filter((row) => row.selected).map((row) => row.id));
  const capabilityRows = (options.capabilities ?? []).map((row) => ({ ...row, itemId: `capability:${row.id}` }));
  const enabledCapabilities = new Set(capabilityRows.filter((row) => row.selected).map((row) => row.itemId));
  let outcome: PlannerChoice | undefined;
  type Screen = "planners";
  type Action = "toggle" | "start";
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "planners",
    screens: {
      planners: () => ({
        kind: "multiSelect",
        title: `${options.title} · 1/2 models`,
        lines: [
          ...(options.lines ?? []),
          capabilityRows.length > 0
            ? `${selected.size} model${selected.size === 1 ? "" : "s"} selected. Tool rows apply to every planner; planners never edit files or ask you questions.`
            : `${selected.size} model${selected.size === 1 ? "" : "s"} selected. Planners never edit files or ask you questions; you choose their tools next.`,
        ],
        enableSearch: true,
        viewportSize: 12,
        items: [
          ...capabilityRows.map((row) => ({
            id: row.itemId,
            label: `Tool · ${safeText(row.label)}`,
            ...(row.description ? { description: safeText(row.description) } : {}),
            searchText: `tool ${safeText(row.label)}`,
            selected: enabledCapabilities.has(row.itemId),
          })),
          ...rows.map((row) => ({
            id: row.id,
            label: row.label,
            ...(row.name ? { description: row.name } : {}),
            searchText: row.searchText,
            selected: selected.has(row.id),
          })),
        ],
        action: "toggle",
        actions: [
          {
            id: "start",
            label: options.startLabel ?? `Start planning with ${selected.size} model${selected.size === 1 ? "" : "s"}`,
            action: "start",
            ...(selected.size === 0 ? { disabled: true, disabledReason: "Select at least one model" } : {}),
          },
        ],
        hint: "close",
      }),
    },
    actions: {
      toggle: async ({ itemId, selected: isSelected }) => {
        if (capabilityRows.some((row) => row.itemId === itemId)) {
          if (isSelected) enabledCapabilities.add(itemId);
          else enabledCapabilities.delete(itemId);
          return { kind: "stay" };
        }
        if (!rows.some((row) => row.id === itemId)) return { kind: "rejected" };
        if (isSelected) selected.add(itemId);
        else selected.delete(itemId);
        return { kind: "stay" };
      },
      start: async () => {
        if (selected.size === 0) return { kind: "rejected" };
        outcome = {
          specs: rows.filter((row) => selected.has(row.id)).map((row) => row.spec),
          capabilities: capabilityRows.filter((row) => enabledCapabilities.has(row.itemId)).map((row) => row.id),
        };
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal: options.signal, isCurrent: options.isCurrent });
  return outcome;
}

async function choosePlannersFullScreen(
  ctx: ExtensionContext,
  options: ChoosePlannersOptions,
): Promise<PlannerChoice | undefined> {
  const catalog = modelCatalog(ctx);
  const rows: ModelPickerRow[] = [];
  const subagents = (row: { provider: string; modelId: string }) => () => {
    const scout = options.subagentsFor?.({ provider: row.provider, modelId: row.modelId });
    if (!scout) return undefined;
    return `${catalog.name(scout)}${scout.thinkingLevel ? ` · ${scout.thinkingLevel}` : ""}`;
  };
  for (const spec of options.preselected) {
    if (rows.some((row) => row.provider === spec.provider && row.modelId === spec.modelId)) continue;
    rows.push({
      provider: spec.provider,
      modelId: spec.modelId,
      name: catalog.name(spec),
      details: catalog.details(spec),
      efforts: catalog.efforts(spec),
      ...(spec.thinkingLevel ? { effort: spec.thinkingLevel } : {}),
      selected: true,
      subagents: subagents(spec),
    });
  }
  for (const model of catalog.available) {
    const spec = { provider: model.provider, modelId: model.id };
    if (rows.some((row) => row.provider === spec.provider && row.modelId === spec.modelId)) continue;
    rows.push({
      ...spec,
      name: catalog.name(spec),
      details: catalog.details(spec),
      efforts: catalog.efforts(spec),
      selected: false,
      subagents: subagents(spec),
    });
  }
  const result = await ctx.ui.custom<{ kind: "next"; specs: ModelSpec[] } | { kind: "cancel" }>(
    (tui, theme, _keybindings, done) => {
      const view = new ModelPickerView(theme, {
        title: options.title,
        ...(options.task ? { task: options.task } : {}),
        notes: options.notes ?? [],
        rows,
        height: () => terminalRows(tui),
        requestRender: () => tui.requestRender(),
        onDone: done,
      });
      return {
        render: (width: number) => view.render(width),
        handleInput: (data: string) => view.handleInput(data),
        handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
        invalidate: () => view.invalidate(),
      };
    },
    SHEET,
  );
  if (result?.kind !== "next" || !options.isCurrent()) return undefined;
  return { specs: result.specs, capabilities: [] };
}

function plannerRows(preselected: readonly ModelSpec[], available: readonly AvailableImplementationModel[]) {
  const rows: Array<{
    id: string;
    spec: ModelSpec;
    label: string;
    name?: string;
    searchText: string;
    selected: boolean;
  }> = [];
  for (const spec of preselected) {
    const key = formatModelSpec(spec);
    if (rows.some((row) => row.id === key)) continue;
    const model = available.find((candidate) =>
      sameModel({ provider: candidate.provider, modelId: candidate.id }, spec),
    );
    rows.push({
      id: key,
      spec,
      label: safeText(`${spec.modelId} [${spec.provider}]${spec.thinkingLevel ? ` · ${spec.thinkingLevel}` : ""}`),
      ...(model?.name ? { name: safeText(model.name) } : {}),
      searchText: safeText(key),
      selected: true,
    });
  }
  for (const model of available) {
    const spec = { provider: model.provider, modelId: model.id };
    const key = formatModelKey(spec);
    if (rows.some((row) => row.id === key)) continue;
    rows.push({
      id: key,
      spec,
      label: safeText(`${model.id} [${model.provider}]`),
      ...(model.name ? { name: safeText(model.name) } : {}),
      searchText: safeText(`${key} ${model.name ?? ""}`),
      selected: false,
    });
  }
  return rows;
}

export interface RunPlannersWithProgressOptions extends Lifecycle {
  specs: readonly ModelSpec[];
  /** Candidate ids in the same order as `specs`. */
  ids: readonly string[];
  run(
    signal: AbortSignal,
    onProgress: (index: number, progress: PlannerProgress) => void,
    onTrace: (index: number, trace: PlannerTrace) => void,
    onSubagents: (index: number, subagents: readonly SubagentView[]) => void,
  ): Promise<PlanCandidate[]>;
}

export interface PlannerRunResult {
  candidates: PlanCandidate[];
  /** Traces by candidate id, for watching again after the run. */
  traces: Map<string, TracePane>;
}

/**
 * Run the planners while showing their live traces (TUI: side by side, or one at a time; other
 * modes: a cancellable loader plus a status widget). Resolves undefined when the user cancels.
 */
export async function runPlannersWithProgress(
  ctx: ExtensionContext,
  options: RunPlannersWithProgressOptions,
): Promise<PlannerRunResult | undefined> {
  const progress: Array<PlannerProgress | undefined> = options.specs.map(() => undefined);
  const catalog = modelCatalog(ctx);
  const panes: TracePane[] = options.specs.map((spec, index) => ({
    id: options.ids[index] ?? String(index + 1),
    model: safeText(formatModelSpec(spec)),
    name: catalog.name(spec),
    ...(spec.thinkingLevel ? { effort: spec.thinkingLevel } : {}),
    trace: new PlannerTrace(),
  }));
  const subagentPane = subagentPaneFactory(catalog);
  const traces = () => new Map(panes.map((pane) => [pane.id, pane]));
  if (ctx.mode === "tui") return runWithTraceView(ctx, options, panes, progress, traces, subagentPane);

  let renderTimer: ReturnType<typeof setInterval> | undefined;
  const publish = () => {
    try {
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, progressLines(options.specs, progress));
    } catch {
      // The context can go stale while planners run; the loader result still reports the outcome.
    }
  };
  publish();
  if (ctx.hasUI) {
    renderTimer = setInterval(publish, 1000);
    renderTimer.unref?.();
  }
  try {
    const result = await runTask(ctx, {
      label: `Planning with ${options.specs.length} model${options.specs.length === 1 ? "" : "s"} in parallel…`,
      signal: options.signal,
      isCurrent: options.isCurrent,
      cancellable: true,
      task: ({ signal }) =>
        options.run(
          signal,
          (index, next) => {
            progress[index] = next;
            const pane = panes[index];
            if (pane) pane.progress = next;
            publish();
          },
          (index, trace) => {
            const pane = panes[index];
            if (pane) pane.trace = trace;
          },
          (index, subagents) => {
            const pane = panes[index];
            if (pane) pane.children = subagents.map(subagentPane);
          },
        ),
    });
    if (result.kind === "completed") return { candidates: result.value, traces: traces() };
    if (result.kind === "error") throw result.error;
    return undefined;
  } finally {
    if (renderTimer) clearInterval(renderTimer);
    try {
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
    } catch {
      // Stale context.
    }
  }
}

async function runWithTraceView(
  ctx: ExtensionContext,
  options: RunPlannersWithProgressOptions,
  panes: TracePane[],
  progress: Array<PlannerProgress | undefined>,
  traces: () => Map<string, TracePane>,
  subagentPane: (view: SubagentView) => TracePane,
): Promise<PlannerRunResult | undefined> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  let running = true;
  let result: PlanCandidate[] | undefined;
  const outcome = await ctx.ui.custom<"done" | "cancelled">((tui, theme, _keybindings, done) => {
    let renderQueued = false;
    let finished = false;
    const requestRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      setTimeout(() => {
        renderQueued = false;
        tui.requestRender();
      }, 80).unref?.();
    };
    // Fast enough for the spinners; the diff renderer only repaints changed rows.
    const ticker = setInterval(requestRender, 250);
    ticker.unref?.();
    const view = new TraceView(theme, {
      title: "Planning",
      getPanes: () => panes,
      isLive: () => running,
      rows: () => terminalRows(tui),
      requestRender,
      onCancel: () => {
        controller.abort(new DOMException("Planners cancelled", "AbortError"));
      },
      onClose: () => {
        if (finished) done(signal.aborted ? "cancelled" : "done");
      },
    });
    options
      .run(
        signal,
        (index, next) => {
          progress[index] = next;
          const pane = panes[index];
          if (pane) pane.progress = next;
          requestRender();
        },
        (index, trace) => {
          const pane = panes[index];
          if (pane) pane.trace = trace;
          requestRender();
        },
        (index, subagents) => {
          const pane = panes[index];
          if (pane) pane.children = subagents.map(subagentPane);
          requestRender();
        },
      )
      .then((candidates) => {
        result = candidates;
      })
      .finally(() => {
        running = false;
        finished = true;
        clearInterval(ticker);
        // Move on to comparing plans, unless the user is reading a trace: then offer it instead.
        if (signal.aborted || !view.isBusy()) done(signal.aborted ? "cancelled" : "done");
        else view.markFinished();
      });
    return {
      render: (width: number) => view.render(width),
      handleInput: (data: string) => view.handleInput(data),
      handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
      invalidate: () => view.invalidate(),
      dispose: () => {
        clearInterval(ticker);
        if (running) controller.abort(new DOMException("Trace view closed", "AbortError"));
      },
    };
  }, FULL_SCREEN);
  if (outcome !== "done" || !result || signal.aborted) return undefined;
  return { candidates: result, traces: traces() };
}

/** Re-open the finished traces of a run. */
export async function showTraces(ctx: ExtensionContext, panes: readonly TracePane[], title: string) {
  if (ctx.mode !== "tui" || panes.length === 0) return;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const view = new TraceView(theme, {
      title,
      getPanes: () => panes,
      isLive: () => false,
      rows: () => terminalRows(tui),
      requestRender: () => tui.requestRender(),
      onCancel: () => done(),
      onClose: () => done(),
    });
    return {
      render: (width: number) => view.render(width),
      handleInput: (data: string) => view.handleInput(data),
      handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
      invalidate: () => view.invalidate(),
    };
  }, FULL_SCREEN);
}

/** Subagent views keep their identity, so a pane per subagent can be reused across updates. */
function subagentPaneFactory(catalog: ReturnType<typeof modelCatalog>) {
  const panes = new WeakMap<SubagentView, TracePane>();
  return (view: SubagentView): TracePane => {
    let pane = panes.get(view);
    if (!pane) {
      const described = catalog.describe(view.model);
      pane = {
        id: view.id,
        model: view.model,
        name: described.name,
        ...(described.effort ? { effort: described.effort } : {}),
        label: safeText(view.label),
        task: view.task,
        trace: view.trace,
        progress: view.stats,
      };
      panes.set(view, pane);
    }
    return pane;
  };
}

export interface ChooseToolsOptions extends Lifecycle {
  title: string;
  task?: string;
  /** Short notes under the task (e.g. the Jev summary when it is already known). */
  notes: readonly string[];
  roots: ToolNode[];
  startLabel: string;
  timeLimitMinutes: number;
  timeLimitChoices: readonly number[];
  /** Jev's picks, arriving after the screen opens (TUI) or awaited first (other modes). */
  preselection?: ToolPreselection;
}

/**
 * The tools screen. TUI shows a collapsible tree (toolsets, MCP servers, tools); other modes get a
 * flat list of every tool. Mutates the tree's selection in place.
 */
export async function chooseTools(ctx: ExtensionContext, options: ChooseToolsOptions): Promise<ToolTreeResult> {
  if (ctx.mode === "tui") {
    const result = await ctx.ui.custom<ToolTreeResult>((tui, theme, _keybindings, done) => {
      let pending = options.preselection !== undefined;
      const ticker = setInterval(() => {
        if (pending) tui.requestRender();
      }, 150);
      ticker.unref?.();
      options.preselection?.pending.finally(() => {
        pending = false;
        clearInterval(ticker);
      });
      const view = new ToolTreeView(theme, {
        title: options.title,
        ...(options.task ? { task: options.task } : {}),
        notes: options.notes,
        roots: options.roots,
        startLabel: options.startLabel,
        timeLimitMinutes: options.timeLimitMinutes,
        timeLimitChoices: options.timeLimitChoices,
        ...(options.preselection ? { preselection: options.preselection } : {}),
        rows: () => terminalRows(tui),
        requestRender: () => tui.requestRender(),
        onDone: done,
      });
      return {
        render: (width: number) => view.render(width),
        handleInput: (data: string) => view.handleInput(data),
        handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
        invalidate: () => view.invalidate(),
        dispose: () => clearInterval(ticker),
      };
    }, SHEET);
    return result ?? { kind: "cancel" };
  }
  const notes = [...options.notes];
  if (options.preselection) {
    try {
      const picked = await options.preselection.pending;
      picked.apply(false);
      notes.unshift(picked.message);
    } catch {
      notes.unshift("Jev could not pick tools; using the defaults from settings.");
    }
  }
  const flat = leaves(options.roots);
  let outcome: ToolTreeResult = { kind: "cancel" };
  const menu = defineMenu<undefined, "tools", "toggle" | "start" | "back", ExtensionContext>({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: `${options.title} · 2/2 tools`,
        lines: [...(options.task ? [`Task: ${options.task}`] : []), ...notes],
        enableSearch: true,
        viewportSize: 14,
        items: flat.map((leaf) => ({
          id: leaf.id,
          label: safeText(leaf.id.replace(/^(?:toolset|mcp):/u, "")),
          ...(leaf.jev !== undefined ? { description: `Jev ${Math.round(leaf.jev * 100)}%` } : {}),
          selected: leaf.selected === true,
        })),
        action: "toggle",
        actions: [
          { id: "start", label: options.startLabel, action: "start" },
          { id: "back", label: "Back to models", action: "back" },
        ],
        hint: "close",
      }),
    },
    actions: {
      toggle: async ({ itemId, selected }) => {
        const leaf = flat.find((candidate) => candidate.id === itemId);
        if (!leaf) return { kind: "rejected" };
        leaf.selected = selected === true;
        return { kind: "stay" };
      },
      start: async () => {
        outcome = { kind: "start", timeLimitMinutes: options.timeLimitMinutes };
        return { kind: "close" };
      },
      back: async () => {
        outcome = { kind: "back" };
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal: options.signal, isCurrent: options.isCurrent });
  return outcome;
}

export function progressLines(specs: readonly ModelSpec[], progress: ReadonlyArray<PlannerProgress | undefined>) {
  const now = Date.now();
  const rows = specs.map((spec, index) => {
    const current = progress[index];
    const label = safeText(formatModelSpec(spec));
    if (!current) return [`· ${label}`, ...statsCells({}), "waiting"];
    const icon =
      current.state === "done"
        ? "✓"
        : current.state === "failed" || current.state === "timeout"
          ? "✗"
          : current.state === "cancelled"
            ? "–"
            : "…";
    return [
      `${icon} ${label}`,
      ...statsCells({
        durationMs: (current.endedAt ?? now) - current.startedAt,
        toolCalls: current.toolCalls,
        subagents: current.subagentTasks,
        tokens: current.totalTokens,
        cost: current.costUsd,
      }),
      current.state === "running"
        ? safeText(current.wrappingUp ? "wrapping up" : (current.lastActivity ?? ""))
        : current.state === "starting"
          ? "starting"
          : current.state,
    ];
  });
  return ["Parallel planners", ...alignColumns(rows)];
}

export type ComparisonOutcome =
  | { kind: "use"; candidate: PlanCandidate }
  | { kind: "traces" }
  /** Guidance is written afterwards in the regular prompt editor. */
  | { kind: "synthesize"; candidates: PlanCandidate[] }
  | { kind: "close" };

/** Browse candidate plans, then use one as-is or synthesize a selection with optional guidance. */
export async function showCandidateComparison(
  ctx: ExtensionContext,
  set: CandidateSet,
  lifecycle: Lifecycle,
  options: { hasTraces?: boolean } = {},
): Promise<ComparisonOutcome> {
  if (ctx.mode === "tui") return compareFullScreen(ctx, set, lifecycle, options);
  const ready = set.candidates.filter((candidate) => candidate.status === "done" && candidate.plan);
  const summaries = new Map(
    alignColumns(
      ready.map((candidate) =>
        statsCells({
          ...(candidate.durationMs !== undefined ? { durationMs: candidate.durationMs } : {}),
          ...(candidate.toolCalls !== undefined ? { toolCalls: candidate.toolCalls } : {}),
          subagents: candidate.subagentTasks ?? 0,
          tokens: candidate.totalTokens ?? 0,
          cost: candidate.costUsd ?? 0,
        }).concat(candidate.planFromText ? ["plan taken from prose"] : []),
      ),
      // Menu descriptions collapse every kind of whitespace, so pad with blank braille cells.
      "\u2800\u2800",
      "\u2800",
    ).map((line, index) => [ready[index]?.id ?? "", line]),
  );
  const failed = set.candidates.filter((candidate) => !(candidate.status === "done" && candidate.plan));
  let viewing: PlanCandidate | undefined = ready[0];
  const synthesisSelection = new Set(ready.map((candidate) => candidate.id));
  let outcome: ComparisonOutcome = { kind: "close" };
  type Screen = "candidates" | "review" | "synth-select";
  type Action = "view" | "use" | "toggle-synth" | "synthesize" | "traces";
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "candidates",
    screens: {
      candidates: () => ({
        kind: "actions",
        title: `Compare ${ready.length} plan${ready.length === 1 ? "" : "s"}`,
        lines: [
          ...(set.task.trim() ? [`Task: ${truncate(safeText(set.task.trim().split("\n")[0] ?? ""), 160)}`] : []),
          ...failed.map(
            (candidate) =>
              `${candidate.id} · ${safeText(candidate.label)} produced no plan: ${truncate(safeText(candidate.error ?? candidate.status), 200)}`,
          ),
          "Open a plan to read it and use it, or synthesize several into one.",
        ],
        items: [
          ...ready.map((candidate) => ({
            id: `view:${candidate.id}`,
            label: `${candidate.id} · ${safeText(candidate.label)}`,
            description: summaries.get(candidate.id) || candidateSummary(candidate) || "ready",
            action: "view" as const,
          })),
          ...(options.hasTraces && ctx.mode === "tui"
            ? [
                {
                  id: "traces",
                  label: "Watch planner traces",
                  description: "Replay what each planner read, searched, and thought.",
                  action: "traces" as const,
                },
              ]
            : []),
          ...(ready.length > 1
            ? [
                {
                  id: "synthesize",
                  label: "Synthesize…",
                  description: "Merge chosen plans in this session; you write optional guidance next.",
                  to: "synth-select" as const,
                },
              ]
            : []),
        ],
        hint: "close",
      }),
      review: () => ({
        kind: "review",
        title: viewing ? `Plan ${viewing.id} · ${safeText(viewing.label)}` : "Plan",
        lines: viewing ? [candidateSummary(viewing)].filter(Boolean) : [],
        content: viewing?.plan ?? "",
        format: { kind: "markdown" },
        viewportSize: "adaptive",
        confirm: { id: "use", label: "Use this plan", action: "use" },
        hint: "back",
      }),
      "synth-select": () => ({
        kind: "multiSelect",
        title: "Plans to synthesize",
        lines: [
          "The current session model merges the selected plans and may ask you questions.",
          "Next, write optional guidance in the prompt editor, then press Enter.",
        ],
        items: ready.map((candidate) => ({
          id: candidate.id,
          label: `${candidate.id} · ${safeText(candidate.label)}`,
          selected: synthesisSelection.has(candidate.id),
        })),
        action: "toggle-synth",
        actions: [
          {
            id: "guidance",
            label: "Continue",
            action: "synthesize",
            ...(synthesisSelection.size < 2 ? { disabled: true, disabledReason: "Select at least two plans" } : {}),
          },
        ],
        hint: "back",
      }),
    },
    actions: {
      traces: async () => {
        outcome = { kind: "traces" };
        return { kind: "close" };
      },
      view: async ({ itemId }) => {
        viewing = ready.find((candidate) => `view:${candidate.id}` === itemId);
        return viewing ? { kind: "to", screen: "review" } : { kind: "rejected" };
      },
      use: async () => {
        if (!viewing) return { kind: "rejected" };
        outcome = { kind: "use", candidate: viewing };
        return { kind: "close" };
      },
      "toggle-synth": async ({ itemId, selected }) => {
        if (!ready.some((candidate) => candidate.id === itemId)) return { kind: "rejected" };
        if (selected) synthesisSelection.add(itemId);
        else synthesisSelection.delete(itemId);
        return { kind: "stay" };
      },
      synthesize: async () => {
        const candidates = ready.filter((candidate) => synthesisSelection.has(candidate.id));
        if (candidates.length < 2) return { kind: "rejected" };
        outcome = { kind: "synthesize", candidates };
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal: lifecycle.signal, isCurrent: lifecycle.isCurrent });
  return outcome;
}

async function compareFullScreen(
  ctx: ExtensionContext,
  set: CandidateSet,
  lifecycle: Lifecycle,
  options: { hasTraces?: boolean },
): Promise<ComparisonOutcome> {
  const catalog = modelCatalog(ctx);
  const describe = (candidate: PlanCandidate) => {
    // Planner labels are model specs (`provider/model:effort`); the session plan names its model.
    const spec = parseModelSpec(candidate.label);
    if (spec) return { name: catalog.name(spec), ...(spec.thinkingLevel ? { effort: spec.thinkingLevel } : {}) };
    if (candidate.model) return { name: `Current plan · ${catalog.name(candidate.model)}` };
    return { name: safeText(candidate.label) };
  };
  const result = await ctx.ui.custom<import("./compare-view.js").CompareResult>((tui, theme, _keybindings, done) => {
    const view = new CompareView(theme, {
      task: safeText(set.task),
      candidates: set.candidates,
      describe,
      hasTraces: options.hasTraces === true,
      renderMarkdown: (text, width) => new Markdown(text, 0, 0, getMarkdownTheme()).render(width),
      rows: () => terminalRows(tui),
      requestRender: () => tui.requestRender(),
      onDone: done,
    });
    return {
      render: (width: number) => view.render(width),
      handleInput: (data: string) => view.handleInput(data),
      handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
      invalidate: () => view.invalidate(),
    };
  }, FULL_SCREEN);
  if (!result || !lifecycle.isCurrent()) return { kind: "close" };
  if (result.kind === "use") {
    const candidate = set.candidates.find((plan) => plan.id === result.id);
    return candidate ? { kind: "use", candidate } : { kind: "close" };
  }
  if (result.kind === "synthesize") {
    return { kind: "synthesize", candidates: set.candidates.filter((plan) => result.ids.includes(plan.id)) };
  }
  return result.kind === "traces" ? { kind: "traces" } : { kind: "close" };
}

function formatContext(tokens: number) {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Math.round(tokens / 1_000)}k`;
}

function trimCost(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "");
}

function safeText(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
