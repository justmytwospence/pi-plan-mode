import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import {
  type AvailableImplementationModel,
  formatModelKey,
  formatModelSpec,
  type ModelSpec,
  sameModel,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { alignColumns, type CandidateSet, candidateSummary, type PlanCandidate, statsCells } from "./multi-plan.js";
import type { PlannerProgress } from "./planner-process.js";
import { PlannerTrace } from "./planner-trace.js";
import { leaves, type ToolNode } from "./tool-tree.js";
import { type ToolTreeResult, ToolTreeView } from "./tool-tree-view.js";
import { type TracePane, TraceView } from "./trace-view.js";

interface Lifecycle {
  signal: AbortSignal;
  isCurrent(): boolean;
}

const PROGRESS_WIDGET_KEY = "plan-mode-planners";

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
        title: options.title,
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
  const panes: TracePane[] = options.specs.map((spec, index) => ({
    id: options.ids[index] ?? String(index + 1),
    label: safeText(formatModelSpec(spec)),
    trace: new PlannerTrace(),
  }));
  const traces = () => new Map(panes.map((pane) => [pane.id, pane]));
  if (ctx.mode === "tui") return runWithTraceView(ctx, options, panes, progress, traces);

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
): Promise<PlannerRunResult | undefined> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  let running = true;
  let result: PlanCandidate[] | undefined;
  const outcome = await ctx.ui.custom<"done" | "cancelled">((tui, theme, _keybindings, done) => {
    let renderQueued = false;
    const requestRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      setTimeout(() => {
        renderQueued = false;
        tui.requestRender();
      }, 80).unref?.();
    };
    const ticker = setInterval(requestRender, 1000);
    ticker.unref?.();
    const view = new TraceView(theme, {
      title: `Planning with ${panes.length} model${panes.length === 1 ? "" : "s"} in parallel`,
      getPanes: () => panes,
      isLive: () => running,
      rows: () => Math.max(12, tui.terminal.rows - 9),
      requestRender,
      onCancel: () => {
        controller.abort(new DOMException("Planners cancelled", "AbortError"));
      },
      onClose: () => undefined,
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
      )
      .then((candidates) => {
        result = candidates;
      })
      .finally(() => {
        running = false;
        clearInterval(ticker);
        done(signal.aborted ? "cancelled" : "done");
      });
    return {
      render: (width: number) => view.render(width),
      handleInput: (data: string) => view.handleInput(data),
      invalidate: () => view.invalidate(),
      dispose: () => {
        clearInterval(ticker);
        if (running) controller.abort(new DOMException("Trace view closed", "AbortError"));
      },
    };
  });
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
      rows: () => Math.max(12, tui.terminal.rows - 9),
      requestRender: () => tui.requestRender(),
      onCancel: () => done(),
      onClose: () => done(),
    });
    return {
      render: (width: number) => view.render(width),
      handleInput: (data: string) => view.handleInput(data),
      invalidate: () => view.invalidate(),
    };
  });
}

export interface ChooseToolsOptions extends Lifecycle {
  title: string;
  lines: readonly string[];
  roots: ToolNode[];
  startLabel: string;
  timeLimitMinutes: number;
  timeLimitChoices: readonly number[];
}

/**
 * The tools screen. TUI shows a collapsible tree (toolsets, MCP servers, tools); other modes get a
 * flat list of every tool. Mutates the tree's selection in place.
 */
export async function chooseTools(ctx: ExtensionContext, options: ChooseToolsOptions): Promise<ToolTreeResult> {
  if (ctx.mode === "tui") {
    const result = await ctx.ui.custom<ToolTreeResult>((tui, theme, _keybindings, done) => {
      const view = new ToolTreeView(theme, {
        title: options.title,
        lines: options.lines,
        roots: options.roots,
        startLabel: options.startLabel,
        timeLimitMinutes: options.timeLimitMinutes,
        timeLimitChoices: options.timeLimitChoices,
        rows: () => Math.max(12, tui.terminal.rows - 9),
        requestRender: () => tui.requestRender(),
        onDone: done,
      });
      return {
        render: (width: number) => view.render(width),
        handleInput: (data: string) => view.handleInput(data),
        invalidate: () => view.invalidate(),
      };
    });
    return result ?? { kind: "cancel" };
  }
  const flat = leaves(options.roots);
  let outcome: ToolTreeResult = { kind: "cancel" };
  const menu = defineMenu<undefined, "tools", "toggle" | "start" | "back", ExtensionContext>({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: options.title,
        lines: [...options.lines],
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

function safeText(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
