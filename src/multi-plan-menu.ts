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
import { type CandidateSet, candidateSummary, formatDuration, formatTokens, type PlanCandidate } from "./multi-plan.js";
import type { PlannerProgress } from "./planner-process.js";

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
          `${selected.size} model${selected.size === 1 ? "" : "s"} selected. Tool rows apply to every planner; planners never edit files or ask you questions.`,
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
            label: `Start planning with ${selected.size} model${selected.size === 1 ? "" : "s"}`,
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
  run(signal: AbortSignal, onProgress: (index: number, progress: PlannerProgress) => void): Promise<PlanCandidate[]>;
}

/**
 * Run the planners behind a cancellable loader while a widget shows each planner's live status.
 * Resolves undefined when the user cancels.
 */
export async function runPlannersWithProgress(
  ctx: ExtensionContext,
  options: RunPlannersWithProgressOptions,
): Promise<PlanCandidate[] | undefined> {
  const progress: Array<PlannerProgress | undefined> = options.specs.map(() => undefined);
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
        options.run(signal, (index, next) => {
          progress[index] = next;
          publish();
        }),
    });
    if (result.kind === "completed") return result.value;
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

export function progressLines(specs: readonly ModelSpec[], progress: ReadonlyArray<PlannerProgress | undefined>) {
  const now = Date.now();
  return [
    "Parallel planners",
    ...specs.map((spec, index) => {
      const current = progress[index];
      const label = safeText(formatModelSpec(spec));
      if (!current) return `  ${label} · waiting`;
      const icon =
        current.state === "done"
          ? "✓"
          : current.state === "failed" || current.state === "timeout"
            ? "✗"
            : current.state === "cancelled"
              ? "–"
              : "…";
      const elapsed = formatDuration((current.endedAt ?? now) - current.startedAt);
      const parts = [
        elapsed,
        `${current.toolCalls} tool calls`,
        ...(current.subagentTasks ? [`${current.subagentTasks} subagents`] : []),
        ...(current.totalTokens ? [`${formatTokens(current.totalTokens)} tokens`] : []),
        ...(current.state === "running" && current.lastActivity ? [safeText(current.lastActivity)] : []),
        ...(current.state !== "running" && current.state !== "starting" ? [current.state] : []),
      ];
      return `${icon} ${label} · ${parts.join(" · ")}`;
    }),
  ];
}

export type ComparisonOutcome =
  | { kind: "use"; candidate: PlanCandidate }
  /** Guidance is written afterwards in the regular prompt editor. */
  | { kind: "synthesize"; candidates: PlanCandidate[] }
  | { kind: "close" };

/** Browse candidate plans, then use one as-is or synthesize a selection with optional guidance. */
export async function showCandidateComparison(
  ctx: ExtensionContext,
  set: CandidateSet,
  lifecycle: Lifecycle,
): Promise<ComparisonOutcome> {
  const ready = set.candidates.filter((candidate) => candidate.status === "done" && candidate.plan);
  const failed = set.candidates.filter((candidate) => !(candidate.status === "done" && candidate.plan));
  let viewing: PlanCandidate | undefined = ready[0];
  const synthesisSelection = new Set(ready.map((candidate) => candidate.id));
  let outcome: ComparisonOutcome = { kind: "close" };
  type Screen = "candidates" | "review" | "synth-select";
  type Action = "view" | "use" | "toggle-synth" | "synthesize";
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
            description: candidateSummary(candidate) || "ready",
            action: "view" as const,
          })),
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
