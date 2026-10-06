// /plan: a full-screen planning app. Settings → Tools → Planning → Review → Implement, with one or
// two planners. Each planner is an in-process Pi session (planner/agent.ts) seeded with your
// conversation; your main session is untouched until you implement, when it (or a fresh session)
// receives the plan.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type TUI } from "@earendil-works/pi-tui";
import { FULL_SCREEN } from "./app/frame.js";
import { type LaneAction, LanesPage, type MergerPane } from "./app/lanes-page.js";
import { type OptionRow, OptionsPage, type TextArea } from "./app/options-page.js";
import { formatImplementationPrompt } from "./handoff.js";
import { holdWorking } from "./herdr-blocked.js";
import {
  formatModelKey,
  formatModelSpec,
  type ImplementationContextChoice,
  type ModelSpec,
  parseModelSpec,
  sameModel,
} from "./implementation-models.js";
import { type JevToolPick, pickToolsWithJev } from "./jev-tool-picker.js";
import { buildMcpCatalog, readConfiguredMcpServers } from "./mcp-tools.js";
import { modelCatalog } from "./model-catalog.js";
import { exportPlanToFile } from "./plan-export.js";
import { expandHome, runPlanCompleteHook } from "./plan-hook.js";
import { type OtherTool, otherTools, otherToolsNode, resolveAccess } from "./planner/access.js";
import { type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import {
  MERGER_COMPARE_MESSAGE,
  MERGER_WRAP_UP_MESSAGE,
  type MergerSource,
  mergerBriefing,
  mergerMessage,
  mergerSystemPrompt,
  plannerSystemPrompt,
  plannerTaskPrompt,
} from "./planner/prompt.js";
import type { PlannerSessionFactory } from "./planner/session.js";
import { buildPlannerTranscript } from "./planners.js";
import { extensionsForProvider, resolveProviderExtensions } from "./provider-extensions.js";
import {
  configuredImplementationContext,
  configuredPlanExportPath,
  configuredPlanModeToggleShortcut,
  configuredPlanners,
  configuredPlannerTimeoutSeconds,
  type PlanModeSettings,
  readPlanModeSettings,
  updatePlanModeSettings,
} from "./settings.js";
import { applyAlwaysOffer, applyJevPick, buildToolTree, leafCapabilities, type ToolNode } from "./tool-tree.js";
import { type ToolPreselection, ToolTreeView } from "./tool-tree-view.js";
import { effortText } from "./ui-kit.js";

const EXTENSION_ENTRY_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const RUN_ENTRY = "plan-run";
const RUNTIME_ENTRY = "plan-implementation-runtime";
const RUNTIME_CONSUMED_ENTRY = "plan-implementation-runtime-consumed";
const STATUS_KEY = "plan";
const IDS = ["A", "B"] as const;
/** The merger's id: M talks two plans over with you and merges them when you ask. */
const MERGER_ID = "M";
const TIME_LIMITS = [15, 30, 45, 60, 90, 120, 180] as const;

export interface PlanDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  createSession?: PlannerSessionFactory;
  pickTools?: typeof pickToolsWithJev;
}

/** What a planner may use, stored so a restored planner gets the same tools. */
interface StoredAccess {
  tools: string[];
  extensions: string[];
  skills: string[];
  mcpAllow?: string[];
  grantPrefixes: string[];
  scouts?: { spec: string; extensions: string[]; tools: string[]; mcpAllow?: string[] };
}

interface StoredPlanner {
  id: string;
  spec: string;
  name: string;
  access?: StoredAccess;
  sessionFile?: string;
  plan?: string;
  revision?: number;
}

interface StoredRun {
  id: string;
  createdAt: number;
  task: string;
  state: "active" | "discarded" | "implemented";
  planners: StoredPlanner[];
  /** The merger, once you have talked to it, and the plan versions it has been given. */
  merger?: StoredPlanner & { seen?: Record<string, number> };
}

/** One planning run: the task, its planners, and the merger once you talk to it. */
interface PlanRun {
  id: string;
  createdAt: number;
  task: string;
  agents: PlannerAgent[];
  merger?: PlannerAgent;
  /** The plan version of each planner the merger has been given. */
  mergerSeen: Map<string, number>;
  /** How to start another planner with the same tools. */
  launch?: { roots: ToolNode[]; others: OtherTool[]; seed: readonly unknown[] };
}

interface Draft {
  task: string;
  planners: [ModelSpec, ModelSpec | undefined];
  /** The merger's model; undefined uses planner A's. */
  merger: ModelSpec | undefined;
  scouts: Record<string, ModelSpec | undefined>;
  timeLimit: number;
}

type ThinkingLevel = NonNullable<ModelSpec["thinkingLevel"]>;

export default function plan(pi: ExtensionAPI, dependencies: PlanDependencies = {}) {
  let settings: PlanModeSettings = { thinkingLevel: "inherit" };
  let run: PlanRun | undefined;
  let app: { close(): void; render(): void } | undefined;
  let releaseWorking: (() => void) | undefined;
  let hostCtx: ExtensionContext | undefined;
  let lastNotified = "";

  const loadSettings = async () => {
    if (dependencies.readSettings) {
      settings = await dependencies.readSettings();
      return;
    }
    const loaded = await readPlanModeSettings();
    settings = loaded.kind === "loaded" ? loaded.settings : { thinkingLevel: "inherit" };
  };

  const saveSettings = (patch: Parameters<typeof updatePlanModeSettings>[0]) => {
    if (dependencies.readSettings) return;
    void updatePlanModeSettings(patch)
      .then((saved) => {
        settings = saved;
      })
      .catch(() => undefined);
  };

  // --- Run state -------------------------------------------------------------------------------

  const persistRun = (state: StoredRun["state"] = "active") => {
    if (!run) return;
    const stored: StoredRun = {
      id: run.id,
      createdAt: run.createdAt,
      task: run.task,
      state,
      planners: run.agents.map(storePlanner),
      ...(run.merger ? { merger: { ...storePlanner(run.merger), seen: Object.fromEntries(run.mergerSeen) } } : {}),
    };
    pi.appendEntry(RUN_ENTRY, stored);
  };

  /** What each agent last saved: its plan version and session file. */
  const saved = new Map<string, string>();
  const onAgentChange = () => {
    if (!run) return;
    // Save a run whenever a session file or a plan arrives or changes, so it survives a reload.
    let changed = false;
    for (const agent of everyone(run)) {
      const signature = `${agent.revision}|${agent.sessionFile ?? ""}`;
      const previous = saved.get(agent.id);
      if (previous === signature) continue;
      saved.set(agent.id, signature);
      changed = true;
      // A planner revised a plan the merger has seen: say when M will get it.
      const seen = run.mergerSeen.get(agent.id);
      const revised = previous?.split("|")[0] !== String(agent.revision);
      if (
        run.merger &&
        agent !== run.merger &&
        agent.plan &&
        seen !== undefined &&
        seen !== agent.revision &&
        revised
      ) {
        run.merger.trace.note(`Plan ${agent.id} v${agent.revision} is in; M gets it with your next message.`);
      }
    }
    if (changed) persistRun();
    const working = everyone(run).some((agent) => agent.working);
    if (working && !releaseWorking) releaseWorking = holdWorking(pi.events, "Planning");
    if (!working && releaseWorking) {
      releaseWorking();
      releaseWorking = undefined;
    }
    updateStatus();
    app?.render();
  };

  const updateStatus = () => {
    const ctx = hostCtx;
    if (!ctx?.hasUI) return;
    if (!run || app) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const agents = everyone(run);
    const parts = agents.map(
      (agent) =>
        `${agent.id} ${agent.status === "asking" ? "asking you" : agent.working ? "working" : agent.plan ? "ready" : agent.status === "failed" ? "failed" : "waiting"}`,
    );
    ctx.ui.setStatus(STATUS_KEY, `plan: ${parts.join(" · ")} (/plan)`);
    const notice = agents
      .filter((agent) => agent.status === "asking" || (!agent.working && agent.plan))
      .map((agent) => `${agent.id}:${agent.status}:${agent.revision}`)
      .join(",");
    if (notice && notice !== lastNotified) {
      lastNotified = notice;
      const asking = agents.find((agent) => agent.status === "asking");
      ctx.ui.notify(
        asking
          ? `${asking.id === MERGER_ID ? "The merger" : `Planner ${asking.id}`} is asking you something. /plan to answer.`
          : "A plan is ready. /plan to review it.",
        "info",
      );
    }
  };

  const disposeRun = (state: StoredRun["state"]) => {
    if (!run) return;
    persistRun(state);
    for (const agent of everyone(run)) agent.dispose();
    releaseWorking?.();
    releaseWorking = undefined;
    run = undefined;
    saved.clear();
    updateStatus();
  };

  const restoreRun = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === RUN_ENTRY)
      ?.data as StoredRun | undefined;
    if (latest?.state !== "active" || !Array.isArray(latest.planners)) return;
    const restore = (stored: StoredPlanner, role: "planner" | "merger") => {
      const spec = parseModelSpec(stored.spec);
      if (!spec) return undefined;
      return new PlannerAgent({
        id: stored.id,
        spec,
        name: stored.name,
        cwd: ctx.cwd,
        access: restoreAccess(stored.access, settings, role),
        timeoutMs: configuredPlannerTimeoutSeconds(settings) * 1000,
        ...(role === "merger" ? { wrapUpMessage: MERGER_WRAP_UP_MESSAGE } : {}),
        sessionDir: plannerSessionDir(),
        seed: [],
        ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
        ...(stored.plan ? { plan: stored.plan, revision: stored.revision ?? 1 } : {}),
        onChange: onAgentChange,
        ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
      });
    };
    const agents = latest.planners.flatMap((stored) => restore(stored, "planner") ?? []);
    if (agents.length === 0) return;
    // A merger without a session file never had its briefing saved: the next message briefs a new one.
    const merger = agents.length > 1 && latest.merger?.sessionFile ? restore(latest.merger, "merger") : undefined;
    run = {
      id: latest.id,
      createdAt: latest.createdAt,
      task: latest.task,
      agents,
      ...(merger ? { merger } : {}),
      mergerSeen: new Map(merger ? Object.entries(latest.merger?.seen ?? {}) : []),
    };
    for (const agent of everyone(run)) saved.set(agent.id, `${agent.revision}|${agent.sessionFile ?? ""}`);
  };

  // --- Events ------------------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    hostCtx = ctx;
    for (const agent of run ? everyone(run) : []) agent.dispose();
    run = undefined;
    saved.clear();
    await loadSettings();
    await applyPendingRuntime(ctx);
    restoreRun(ctx);
    updateStatus();
  });

  pi.on("session_shutdown", () => {
    for (const agent of run ? everyone(run) : []) agent.dispose();
    releaseWorking?.();
    releaseWorking = undefined;
  });

  pi.registerCommand("plan", {
    description: "Plan with one or two models in a full-screen planner, then implement",
    handler: async (args, ctx) => {
      hostCtx = ctx;
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/plan needs the interactive terminal UI.", "warning");
        return;
      }
      await loadSettings();
      await openApp(ctx, args.trim());
    },
  });

  // The shortcut opens /plan (a command, so the screen can start a fresh session later).
  void (async () => {
    try {
      await loadSettings();
    } catch {
      // Defaults.
    }
    const shortcut = configuredPlanModeToggleShortcut(settings);
    if (!shortcut) return;
    pi.registerShortcut(shortcut, {
      description: "Open the planner (/plan)",
      handler: () => {
        pi.sendUserMessage("/plan", { expandPromptTemplates: true });
      },
    });
  })();

  // --- The app -----------------------------------------------------------------------------------

  async function openApp(ctx: ExtensionCommandContext, task: string) {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const rows = () => Math.max(12, (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40);
      const render = () => tui.requestRender();
      let page: Component & { typing?: boolean } = undefined as never;
      const ticker = setInterval(() => {
        if (run && everyone(run).some((agent) => agent.working)) render();
      }, 250);
      ticker.unref?.();
      const close = () => {
        clearInterval(ticker);
        app = undefined;
        updateStatus();
        done();
      };
      app = { close, render };
      updateStatus();

      /** The task editor: pi's multi-line editor, wrapping and scrolling inside its borders. */
      const createTextArea = (): TextArea =>
        new Editor(
          tui,
          {
            borderColor: (text) => theme.fg("borderAccent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("dim", text),
            },
          },
          { paddingX: 1 },
        );

      const show = (next: Component) => {
        page = next;
        render();
      };

      const lanes = (): LanesPage => {
        const lanesPage: LanesPage = new LanesPage(theme, {
          title: "Plan",
          task: () => run?.task ?? "",
          agents: () => run?.agents ?? [],
          merger: () => mergerPane(),
          actions: () => laneActions(),
          onAction: (id, text) => onLaneAction(id, text),
          say: (agent, text) => void agent.say(text, ctx),
          sayToMerger: (text) => talkToMerger(ctx, text),
          hide: close,
          stopAll: () => {
            for (const agent of run ? everyone(run) : []) void agent.stop();
          },
          rowsAvailable: rows,
          requestRender: render,
        });
        return lanesPage;
      };

      // --- The merger -------------------------------------------------------------------------

      /** The merger pane, with two planners: M once you have talked to it, else what it will run on. */
      const mergerPane = (): MergerPane | undefined => {
        if (!run || run.agents.length < 2) return undefined;
        const spec = run.merger?.spec ?? mergerSpec();
        if (!spec) return undefined;
        return {
          agent: run.merger,
          name: `${catalog.name(spec)}${spec.thinkingLevel ? ` ${spec.thinkingLevel}` : ""}`,
          ready: run.agents.every((agent) => agent.plan !== undefined),
        };
      };
      const mergerSpec = () => draft.merger ?? run?.agents[0]?.spec;

      /**
       * Talk to the merger. The first message briefs it (both plans and what you told each planner)
       * and starts its session; later ones carry the plans revised since it last saw them.
       */
      const talkToMerger = (context: ExtensionCommandContext, text: string) => {
        const current = run;
        if (!current || current.agents.length < 2) return;
        const sources = current.agents.flatMap((agent): MergerSource[] =>
          agent.plan ? [{ id: agent.id, label: agent.label, plan: agent.plan, revision: agent.revision }] : [],
        );
        if (!current.merger && sources.length < current.agents.length) return;
        const message = text.trim() || MERGER_COMPARE_MESSAGE;
        const shown = text.trim() || "Compare the two plans.";
        let merger = current.merger;
        let full: string;
        if (!merger) {
          const spec = mergerSpec();
          const base = current.agents[0];
          if (!spec || !base) return;
          merger = new PlannerAgent({
            id: MERGER_ID,
            spec,
            name: catalog.name(spec),
            cwd: context.cwd,
            access: { ...base.access, systemPrompt: [mergerSystemPrompt()] },
            timeoutMs: draft.timeLimit * 60_000,
            wrapUpMessage: MERGER_WRAP_UP_MESSAGE,
            sessionDir: plannerSessionDir(),
            seed: current.launch?.seed ?? context.sessionManager.buildSessionProjection().messages,
            onChange: onAgentChange,
            ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
          });
          current.merger = merger;
          current.mergerSeen.clear();
          const briefed = sources.map((source) => {
            const conversation = current.agents.find((agent) => agent.id === source.id)?.conversation();
            return conversation ? { ...source, conversation } : source;
          });
          full = mergerBriefing(current.task, briefed, message);
        } else {
          const revised = sources.filter((source) => current.mergerSeen.get(source.id) !== source.revision);
          if (revised.length > 0) {
            merger.trace.note(
              `Sent M the latest ${revised.map((source) => `${source.id} v${source.revision}`).join(" and ")}.`,
            );
          }
          full = mergerMessage(revised, message);
        }
        for (const source of sources) current.mergerSeen.set(source.id, source.revision);
        persistRun();
        void merger.say(full, context, shown);
        render();
      };

      const laneActions = (): LaneAction[] => {
        const agents = run?.agents ?? [];
        // The merged plan comes first: once there is one, it is usually the one to build.
        const ready = [...(run?.merger?.plan ? [run.merger] : []), ...agents.filter((agent) => agent.plan)];
        const actions: LaneAction[] = [];
        for (const agent of ready) {
          actions.push({
            id: `implement:${agent.id}`,
            label: `Implement ${agent.id}…`,
            description: `Implement ${agent === run?.merger ? "the merged plan M" : `plan ${agent.id}`}${agent.revision > 1 ? ` v${agent.revision}` : ""}: choose the model, effort, and context next.`,
          });
        }
        if (agents.length === 1) {
          actions.push({
            id: "add",
            label: "Add a planner…",
            description: "Plan the same task with a second model in parallel; the first keeps its plan and context.",
          });
        }
        for (const agent of ready) {
          actions.push({
            id: `export:${agent.id}`,
            label: `Export ${agent.id}…`,
            description: `Write plan ${agent.id} to a Markdown file.`,
            input: { placeholder: "path", initial: configuredPlanExportPath(settings) },
          });
        }
        if (agents.length > 0) {
          actions.push(
            {
              id: "close",
              label: "Save & close",
              description: "Close the planner; the plans are kept (planners keep working). /plan reopens it.",
            },
            {
              id: "discard",
              label: "Discard",
              description: "Stop the planners and throw these plans away.",
            },
          );
        }
        return actions;
      };

      const onLaneAction = (id: string, text?: string) => {
        const [kind, agentId] = id.split(":");
        const agent = run ? everyone(run).find((candidate) => candidate.id === agentId) : undefined;
        if (kind === "implement" && agent?.plan) return show(implementPage(agent));
        if (kind === "export" && agent?.plan) {
          const plan = agent.plan;
          void exportPlanToFile(
            plan,
            text || undefined,
            ctx.cwd,
            undefined,
            () => true,
            configuredPlanExportPath(settings),
          )
            .then((result) => {
              ctx.ui.notify(`Plan ${agent.id} exported to ${result.path}.`, "info");
              hook(ctx, agent);
            })
            .catch((error: unknown) => ctx.ui.notify(`Export failed: ${errorText(error)}`, "error"));
          return;
        }
        if (kind === "add") return show(settingsPage("add"));
        if (kind === "close") return close();
        if (kind === "discard") {
          disposeRun("discarded");
          return close();
        }
      };

      // --- Settings ----------------------------------------------------------------------------

      const catalog = modelCatalog(ctx);
      const models = availableModels(ctx);
      const sessionLevel = pi.getThinkingLevel() as ThinkingLevel;
      const effortsOf = (spec: ModelSpec): ThinkingLevel[] =>
        catalog.efforts(spec).filter((level): level is ThinkingLevel => level !== undefined);
      const withEffort = (spec: ModelSpec, level?: ThinkingLevel): ModelSpec => {
        const levels = effortsOf(spec);
        if (levels.length === 0) return { provider: spec.provider, modelId: spec.modelId };
        const wanted = level ?? spec.thinkingLevel ?? sessionLevel;
        const chosen = levels.includes(wanted)
          ? wanted
          : levels.includes(sessionLevel)
            ? sessionLevel
            : levels[levels.length - 1];
        return { provider: spec.provider, modelId: spec.modelId, ...(chosen ? { thinkingLevel: chosen } : {}) };
      };
      const configured = configuredPlanners(settings);
      const sessionSpec: ModelSpec | undefined = ctx.model
        ? { provider: ctx.model.provider, modelId: ctx.model.id }
        : undefined;
      const firstPlanner = configured[0] ?? sessionSpec ?? models[0];
      if (!firstPlanner) {
        ctx.ui.notify("No models are available to plan with.", "error");
        close();
        return { render: () => [], invalidate() {}, handleInput() {} };
      }
      const draft: Draft = {
        task,
        planners: [withEffort(firstPlanner), configured[1] ? withEffort(configured[1]) : undefined],
        merger: settings.merger ? withEffort(settings.merger) : undefined,
        scouts: Object.fromEntries(
          Object.entries(settings.scoutModelMap ?? {}).map(([key, spec]) => [
            key,
            withEffort(spec, spec.thinkingLevel ?? "high"),
          ]),
        ),
        timeLimit: Math.round(configuredPlannerTimeoutSeconds(settings) / 60),
      };
      const describe = (spec: ModelSpec | undefined) => (spec ? catalog.name(spec) : theme.fg("dim", "none"));
      const cycleModel = (current: ModelSpec | undefined, direction: 1 | -1, allowNone: boolean) => {
        const options: Array<ModelSpec | undefined> = [...(allowNone ? [undefined] : []), ...models];
        const index = options.findIndex((option) =>
          option && current ? sameModel(option, current) : option === current,
        );
        const next = options[(index + direction + options.length) % options.length];
        return next ? withEffort(next, current?.thinkingLevel) : undefined;
      };
      const cycleEffort = (spec: ModelSpec, direction: 1 | -1) => {
        const levels = effortsOf(spec);
        if (levels.length === 0) return spec;
        const index = Math.max(0, levels.indexOf(spec.thinkingLevel ?? sessionLevel));
        return { ...spec, thinkingLevel: levels[(index + direction + levels.length) % levels.length] };
      };
      const scoutFor = (spec: ModelSpec | undefined) => (spec ? draft.scouts[formatModelKey(spec)] : undefined);
      const setScout = (spec: ModelSpec | undefined, direction: 1 | -1) => {
        if (!spec) return;
        const current = scoutFor(spec);
        const options: Array<ModelSpec | undefined> = [undefined, ...models];
        const index = options.findIndex((option) =>
          option && current ? sameModel(option, current) : option === current,
        );
        const next = options[(index + direction + options.length) % options.length];
        draft.scouts[formatModelKey(spec)] = next ? withEffort(next, current?.thinkingLevel ?? "high") : undefined;
      };
      const setScoutEffort = (spec: ModelSpec | undefined, direction: 1 | -1) => {
        const scout = scoutFor(spec);
        if (spec && scout) draft.scouts[formatModelKey(spec)] = cycleEffort(scout, direction);
      };
      const plannerRows = (index: 0 | 1, adding: boolean): OptionRow[] => {
        const id = IDS[index];
        const get = () => draft.planners[index];
        return [
          {
            id: `planner-${id}`,
            label: `Planner ${id}`,
            ...(index === 0 && !adding ? { section: "Planners" } : {}),
            value: () => describe(get()),
            cycle: (direction) => {
              const next = cycleModel(get(), direction, index === 1);
              if (index === 0) draft.planners[0] = next ?? draft.planners[0];
              else draft.planners[1] = next;
            },
            description:
              index === 0
                ? `The model that plans. ${get() ? catalog.details(get() as ModelSpec) : ""}`
                : `A second model planning the same task in parallel, to compare or merge. "none" plans with one. ${get() ? catalog.details(get() as ModelSpec) : ""}`,
            ...(adding && index === 0 ? { hidden: () => true } : {}),
          },
          {
            id: `effort-${id}`,
            label: `  effort`,
            value: () => {
              const spec = get();
              return spec
                ? effortsOf(spec).length
                  ? effortText(theme, spec.thinkingLevel)
                  : theme.fg("dim", "n/a")
                : "";
            },
            cycle: (direction) => {
              const spec = get();
              if (spec) draft.planners[index] = cycleEffort(spec, direction);
            },
            description: `How hard planner ${id} thinks (its thinking level).`,
            hidden: () => !get() || (adding && index === 0),
          },
          {
            id: `scouts-${id}`,
            label: `  subagents`,
            value: () => describe(scoutFor(get())),
            cycle: (direction) => setScout(get(), direction),
            description: `Read-only helpers planner ${id} can fan out for broad investigations (plan_subagents), on this model. "none" turns them off.`,
            hidden: () => !get() || (adding && index === 0),
          },
          {
            id: `scouts-effort-${id}`,
            label: `    effort`,
            value: () => {
              const scout = scoutFor(get());
              if (!scout) return "";
              return effortsOf(scout).length ? effortText(theme, scout.thinkingLevel) : theme.fg("dim", "n/a");
            },
            cycle: (direction) => setScoutEffort(get(), direction),
            description: `How hard planner ${id}'s subagents think (their thinking level).`,
            hidden: () => !scoutFor(get()) || (adding && index === 0),
          },
        ];
      };

      const settingsPage = (mode: "new" | "add") => {
        const adding = mode === "add";
        if (adding && !draft.planners[1]) {
          const first = run?.agents[0]?.spec;
          draft.planners[1] = withEffort(
            models.find((model) => !first || !sameModel(model, first)) ?? (models[0] as ModelSpec),
          );
        }
        const optionRows: OptionRow[] = [
          {
            id: "task",
            label: "Task",
            value: () => (draft.task ? (draft.task.split("\n")[0] ?? "") : theme.fg("dim", "(from the conversation)")),
            text: {
              get: () => draft.task,
              set: (value) => (draft.task = value),
              placeholder: "(from the conversation) ⏎ to write what to plan",
              multiline: true,
            },
            description:
              "What to plan. ⏎ edits it here (shift+⏎ for a new line). Leave it empty to plan what the conversation so far is about.",
            hidden: () => adding,
          },
          ...plannerRows(0, adding),
          ...plannerRows(1, adding),
          {
            id: "merger",
            label: "Merger",
            value: () => {
              if (draft.merger) return describe(draft.merger);
              const first = run?.agents[0]?.spec ?? draft.planners[0];
              return `${catalog.name(first)} ${theme.fg("dim", "(as planner A)")}`;
            },
            cycle: (direction) => {
              draft.merger = cycleModel(draft.merger, direction, true);
            },
            description:
              'M, a third model: once both plans are in, it talks them over with you and merges them into one when you ask. "as planner A" uses planner A\'s model and effort.',
            hidden: () => !draft.planners[1],
          },
          {
            id: "merger-effort",
            label: "  effort",
            value: () => {
              const spec = draft.merger;
              if (!spec) return "";
              return effortsOf(spec).length ? effortText(theme, spec.thinkingLevel) : theme.fg("dim", "n/a");
            },
            cycle: (direction) => {
              if (draft.merger) draft.merger = cycleEffort(draft.merger, direction);
            },
            description: "How hard M, the merger, thinks (its thinking level).",
            hidden: () => !draft.planners[1] || !draft.merger,
          },
          {
            id: "time",
            label: "Time limit",
            value: () => `${draft.timeLimit} min`,
            cycle: (direction) => {
              const index = Math.max(0, TIME_LIMITS.indexOf(draft.timeLimit as never));
              draft.timeLimit =
                TIME_LIMITS[Math.min(TIME_LIMITS.length - 1, Math.max(0, index + direction))] ?? draft.timeLimit;
            },
            description:
              "How long a planner may work on one turn. At 80% it is asked to wrap up; at the limit it is stopped.",
            hidden: () => adding,
          },
          {
            id: "jev",
            label: "Jev picks tools",
            section: "Preferences",
            value: () => (settings.jevToolSelection === false ? "off" : "on"),
            cycle: () => {
              const next = settings.jevToolSelection === false;
              settings = { ...settings, jevToolSelection: next };
              saveSettings({ jevToolSelection: next });
            },
            description: "Let Jev (TypeSafe) preselect the planners' tools from the task on the next step.",
            hidden: () => adding,
          },
          {
            id: "context",
            label: "Implement in",
            value: () =>
              configuredImplementationContext(settings) === "clear" ? "a fresh session" : "this conversation",
            cycle: () => {
              const next: ImplementationContextChoice =
                configuredImplementationContext(settings) === "clear" ? "keep" : "clear";
              settings = { ...settings, defaultImplementationContext: next };
              saveSettings({ defaultImplementationContext: next });
            },
            description:
              "Where implementation starts by default: this conversation with the plan, or a fresh session with only the plan.",
            hidden: () => adding,
          },
          {
            id: "export",
            label: "Export to",
            value: () => configuredPlanExportPath(settings),
            text: {
              get: () => configuredPlanExportPath(settings),
              set: (value) => {
                settings = { ...settings, defaultPlanExportPath: value || undefined };
                saveSettings({ defaultPlanExportPath: value || null });
              },
              placeholder: "PLAN.md",
            },
            description: "Default file for Export (relative to the project).",
            hidden: () => adding,
          },
          {
            id: "shortcut",
            label: "Shortcut",
            value: () => configuredPlanModeToggleShortcut(settings) ?? theme.fg("dim", "none"),
            text: {
              get: () => configuredPlanModeToggleShortcut(settings) ?? "",
              set: (value) => {
                saveSettings({ toggleShortcut: (value || null) as never });
                ctx.ui.notify("The shortcut changes after /reload.", "info");
              },
              placeholder: "e.g. shift+tab",
            },
            description: "Key that opens the planner. Takes effect after /reload.",
            hidden: () => adding,
          },
        ];
        const optionsPage = new OptionsPage(theme, {
          title: adding ? "Add a planner" : "Plan",
          context: () =>
            adding ? `plans ${run?.task ? `"${run.task.split("\n")[0]}"` : "the same task"} in parallel` : "settings",
          step: "Settings",
          rows: optionRows,
          next: adding
            ? { label: "start planner B", run: () => void addPlanner(ctx) }
            : { label: "next: tools", run: () => show(toolsPage()) },
          back: adding ? { label: "back", run: () => show(lanes()) } : { label: "close", run: close },
          rowsAvailable: rows,
          requestRender: render,
          createTextArea,
          onChange: (row) => {
            if (row.id.startsWith("merger")) {
              const { merger: _previous, ...rest } = settings;
              settings = draft.merger ? { ...rest, merger: draft.merger } : rest;
              saveSettings({ merger: draft.merger ?? null });
            }
            if (row.id.startsWith("planner") || row.id.startsWith("effort")) {
              const planners = draft.planners.filter((spec): spec is ModelSpec => spec !== undefined);
              if (!adding) saveSettings({ planners });
            }
            if (row.id.startsWith("scouts")) {
              const map = Object.fromEntries(
                Object.entries(draft.scouts).filter((entry): entry is [string, ModelSpec] => entry[1] !== undefined),
              );
              settings = { ...settings, scoutModelMap: map };
              saveSettings({ scoutModelMap: map });
            }
            if (row.id === "time") saveSettings({ plannerTimeoutSeconds: draft.timeLimit * 60 });
          },
        });
        if (adding) optionsPage.focus("planner-B");
        return optionsPage;
      };

      // --- Tools -------------------------------------------------------------------------------

      let tree: { roots: ToolNode[]; others: OtherTool[]; touched: boolean; pick?: Promise<JevToolPick> } | undefined;
      const toolsPage = () => {
        if (!tree) {
          const toolsets = settings.plannerToolsets ?? {};
          const catalogMcp = Object.values(toolsets).some((toolset) => toolset.mcp)
            ? buildMcpCatalog(safeAllTools(pi), readConfiguredMcpServers(ctx.cwd, getAgentDir()))
            : [];
          const scoutTargets = Object.values(draft.scouts)
            .filter(Boolean)
            .map((spec) => formatModelSpec(spec as ModelSpec));
          const roots = buildToolTree({
            toolsets,
            mcpCatalog: catalogMcp,
            scoutTargets,
            grants: settings.commandGrants ?? {},
          });
          const covered = new Set(Object.values(toolsets).flatMap((toolset) => toolset.tools));
          const others = otherTools(safeAllTools(pi), covered, EXTENSION_ENTRY_PATH);
          const otherNode = otherToolsNode(others);
          if (otherNode) roots.push(otherNode);
          applyAlwaysOffer(roots, settings.alwaysOffer);
          tree = { roots, others, touched: false };
          if (settings.jevToolSelection !== false) {
            tree.pick = (dependencies.pickTools ?? pickToolsWithJev)({
              task: draft.task,
              conversation: buildPlannerTranscript(ctx.sessionManager.getBranch()),
              cwd: ctx.cwd,
              capabilities: leafCapabilities(roots),
              registry: ctx.modelRegistry,
              ...(settings.jevThreshold !== undefined ? { threshold: settings.jevThreshold } : {}),
              ...(settings.jevProvider ? { provider: settings.jevProvider } : {}),
              ...(settings.jevModel ? { model: settings.jevModel } : {}),
            });
          }
        }
        const current = tree;
        const preselection: ToolPreselection | undefined = current.pick
          ? {
              pending: current.pick.then((result) => ({
                message:
                  result.kind === "jev"
                    ? `Picked ${Object.values(result.selected).filter(Boolean).length} tools for this task.`
                    : `Not used (${result.reason}); the defaults from settings apply.`,
                apply: (keep: boolean) => applyJevPick(current.roots, result, keep),
              })),
            }
          : undefined;
        current.pick = undefined;
        const count = draft.planners.filter(Boolean).length;
        return new ToolTreeView(theme, {
          title: "Plan",
          ...(draft.task ? { task: draft.task.split("\n")[0] } : {}),
          notes: [],
          roots: current.roots,
          startLabel: `Start planning with ${count} planner${count === 1 ? "" : "s"}`,
          ...(preselection ? { preselection } : {}),
          rows,
          requestRender: render,
          onDone: (result) => {
            if (result.kind === "back" || result.kind === "cancel") return show(settingsPage("new"));
            void startRun(ctx);
          },
        });
      };

      // --- Implement ---------------------------------------------------------------------------

      const implementPage = (first: PlannerAgent) => {
        let author = first;
        const ready = () => [
          ...(run?.merger?.plan ? [run.merger] : []),
          ...(run?.agents ?? []).filter((agent) => agent.plan),
        ];
        const defaults = (agent: PlannerAgent) => {
          const mapped = settings.implementationModelMap?.[formatModelKey(agent.spec)];
          const base = mapped ?? sessionSpec ?? agent.spec;
          return withEffort(base, mapped?.thinkingLevel);
        };
        let target = defaults(author);
        let context: ImplementationContextChoice = configuredImplementationContext(settings);
        const optionRows: OptionRow[] = [
          {
            id: "plan",
            label: "Plan",
            value: () =>
              `${author.id}${author.id === MERGER_ID ? " (merged)" : ""} · ${author.name}${author.revision > 1 ? ` v${author.revision}` : ""}`,
            cycle: (direction) => {
              const list = ready();
              const index = list.indexOf(author);
              author = list[(index + direction + list.length) % list.length] ?? author;
              target = defaults(author);
            },
            description: "Which plan to implement.",
            hidden: () => ready().length < 2,
          },
          {
            id: "model",
            label: "Model",
            value: () => catalog.name(target),
            cycle: (direction) => {
              target = cycleModel(target, direction, false) ?? target;
            },
            description: `The model that implements. ${catalog.details(target)}`,
          },
          {
            id: "effort",
            label: "Effort",
            value: () => (effortsOf(target).length ? effortText(theme, target.thinkingLevel) : theme.fg("dim", "n/a")),
            cycle: (direction) => {
              target = cycleEffort(target, direction);
            },
            description: "How hard the implementing model thinks.",
          },
          {
            id: "context",
            label: "Context",
            value: () =>
              context === "clear" ? "fresh session with only the plan" : "this conversation, plus the plan",
            cycle: () => {
              context = context === "clear" ? "keep" : "clear";
            },
            description: "Keep your conversation and add the plan, or start a fresh session that gets only the plan.",
          },
        ];
        return new OptionsPage(theme, {
          title: "Implement",
          context: () => `plan ${author.id}`,
          step: "Implement",
          rows: optionRows,
          intro: () => [],
          next: {
            label: "implement",
            run: () => {
              close();
              void implement(ctx, author, target, context);
            },
          },
          back: { label: "back to the plans", run: () => show(lanes()) },
          rowsAvailable: rows,
          requestRender: render,
        });
      };

      // --- Starting and adding planners --------------------------------------------------------

      const startRun = async (context: ExtensionCommandContext) => {
        const current = tree;
        if (!current) return;
        const seed = context.sessionManager.buildSessionProjection().messages;
        const runId = randomUUID();
        run = {
          id: runId,
          createdAt: Date.now(),
          task: draft.task,
          agents: [],
          mergerSeen: new Map(),
          launch: { roots: current.roots, others: current.others, seed },
        };
        const specs = draft.planners.filter((spec): spec is ModelSpec => spec !== undefined);
        const lanesPage = lanes();
        show(lanesPage);
        for (const [index, spec] of specs.entries()) launchPlanner(context, IDS[index] ?? "A", spec, specs.length);
        persistRun();
      };

      const launchPlanner = (context: ExtensionCommandContext, id: string, spec: ModelSpec, count: number) => {
        if (!run?.launch) return;
        const scout = scoutFor(spec);
        const access = resolveAccess({
          roots: run.launch.roots,
          toolsets: settings.plannerToolsets ?? {},
          grants: settings.commandGrants ?? {},
          others: run.launch.others,
          scout,
          ...(settings.safeSubcommands ? { safeSubcommands: settings.safeSubcommands } : {}),
          guardExtensionPath: EXTENSION_ENTRY_PATH,
          expandPath: expandHome,
          scoutProviderExtensions: extensionsForProvider(
            resolveProviderExtensions(safeCommands(pi), settings.providerExtensions, expandHome),
            scout?.provider,
          ),
        });
        const agent = new PlannerAgent({
          id,
          spec,
          name: catalog.name(spec),
          cwd: context.cwd,
          access: access.config,
          timeoutMs: draft.timeLimit * 60_000,
          sessionDir: plannerSessionDir(),
          seed: run.launch.seed,
          onChange: onAgentChange,
          ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
        });
        run.agents.push(agent);
        const prompt = plannerTaskPrompt({
          task: run.task,
          planners: count,
          ...(access.scoutLabel ? { scoutLabel: access.scoutLabel } : {}),
          tools: access.extraTools,
          ...(access.mcpAllow ? { mcpAllow: access.mcpAllow } : {}),
          grants: access.grants,
        });
        void agent.start(prompt, context);
      };

      const addPlanner = async (context: ExtensionCommandContext) => {
        const spec = draft.planners[1];
        if (!run || !spec) return show(lanes());
        if (!run.launch) {
          // A restored run: give the new planner the default tools.
          const toolsets = settings.plannerToolsets ?? {};
          const roots = buildToolTree({
            toolsets,
            mcpCatalog: [],
            scoutTargets: [],
            grants: settings.commandGrants ?? {},
          });
          applyAlwaysOffer(roots, settings.alwaysOffer);
          run.launch = { roots, others: [], seed: context.sessionManager.buildSessionProjection().messages };
        }
        launchPlanner(context, IDS[run.agents.length] ?? "B", spec, 2);
        persistRun();
        show(lanes());
      };

      // Open where you left off: the plans, or a new plan's settings.
      page = run ? lanes() : settingsPage("new");
      const component: Component = {
        render: (width) => page.render(width),
        invalidate: () => page.invalidate?.(),
        handleInput: (data) => page.handleInput?.(data),
      };
      (component as { handleMouse?: unknown }).handleMouse = (event: unknown) =>
        (page as { handleMouse?(event: unknown): unknown }).handleMouse?.(event);
      return component;
    }, FULL_SCREEN as never);
  }

  // --- Talking and implementing --------------------------------------------------------------

  function hook(ctx: ExtensionContext, agent: PlannerAgent) {
    if (!settings.planCompleteCommand || !agent.plan) return;
    void runPlanCompleteHook({
      command: settings.planCompleteCommand,
      plan: agent.plan,
      cwd: ctx.cwd,
      model: { provider: agent.spec.provider, modelId: agent.spec.modelId },
    });
  }

  async function implement(
    ctx: ExtensionCommandContext,
    agent: PlannerAgent,
    target: ModelSpec,
    context: ImplementationContextChoice,
  ) {
    const plan = agent.plan;
    if (!plan) return;
    hook(ctx, agent);
    disposeRun("implemented");
    if (context === "clear") {
      const parentSession = ctx.sessionManager.getSessionFile();
      try {
        await ctx.waitForIdle();
        await ctx.newSession({
          ...(parentSession ? { parentSession } : {}),
          setup: async (sessionManager) => {
            sessionManager.appendCustomEntry(RUNTIME_ENTRY, { model: formatModelSpec(target) });
          },
          withSession: async (fresh) => {
            await fresh.sendUserMessage(formatImplementationPrompt(plan, true));
          },
        });
      } catch (error: unknown) {
        ctx.ui.notify(`Could not start a fresh session: ${errorText(error)}`, "error");
      }
      return;
    }
    await applyRuntime(ctx, target);
    pi.sendUserMessage(formatImplementationPrompt(plan, false));
  }

  async function applyRuntime(ctx: ExtensionContext, target: ModelSpec) {
    const current = ctx.model;
    if (!current || current.provider !== target.provider || current.id !== target.modelId) {
      const model = ctx.modelRegistry.find(target.provider, target.modelId);
      if (!model || !(await pi.setModel(model))) {
        ctx.ui.notify(
          `Could not switch to ${formatModelSpec(target)}; implementing with the current model.`,
          "warning",
        );
      }
    }
    if (target.thinkingLevel) pi.setThinkingLevel(target.thinkingLevel as never);
  }

  /** A fresh implementation session applies the model and effort chosen for it, once. */
  async function applyPendingRuntime(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const pending = [...entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === RUNTIME_ENTRY);
    if (!pending) return;
    if (entries.some((entry) => entry.type === "custom" && entry.customType === RUNTIME_CONSUMED_ENTRY)) return;
    const spec = parseModelSpec((pending.data as { model?: unknown } | undefined)?.model);
    pi.appendEntry(RUNTIME_CONSUMED_ENTRY, {});
    if (spec) await applyRuntime(ctx, spec);
  }
}

function storeAccess(access: PlannerAccessConfig): StoredAccess {
  const scouts = access.policy.scouts;
  return {
    tools: access.tools,
    extensions: access.extensions,
    skills: access.skills,
    ...(access.policy.mcpAllow ? { mcpAllow: [...access.policy.mcpAllow] } : {}),
    grantPrefixes: [...access.policy.grantPrefixes],
    ...(scouts
      ? {
          scouts: {
            spec: formatModelSpec(scouts.spec),
            extensions: [...scouts.extensions],
            tools: [...scouts.tools],
            ...(scouts.mcpAllow ? { mcpAllow: [...scouts.mcpAllow] } : {}),
          },
        }
      : {}),
  };
}

/** The planners, then the merger once it has started. */
function everyone(run: PlanRun): PlannerAgent[] {
  return run.merger ? [...run.agents, run.merger] : run.agents;
}

function storePlanner(agent: PlannerAgent): StoredPlanner {
  return {
    id: agent.id,
    spec: agent.label,
    name: agent.name,
    access: storeAccess(agent.access),
    ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
    ...(agent.plan ? { plan: agent.plan, revision: agent.revision } : {}),
  };
}

/** A restored planner's tools; without a record (older runs), it may read, search and run safe commands. */
function restoreAccess(
  stored: StoredAccess | undefined,
  settings: PlanModeSettings,
  role: "planner" | "merger" = "planner",
): PlannerAccessConfig {
  const tools = stored?.tools ?? ["read", "grep", "find", "ls", "bash", "plan_mode_question", "plan_mode_complete"];
  const scoutSpec = stored?.scouts ? parseModelSpec(stored.scouts.spec) : undefined;
  return {
    tools,
    extensions: stored?.extensions ?? [],
    skills: stored?.skills ?? [],
    systemPrompt: [role === "merger" ? mergerSystemPrompt() : plannerSystemPrompt()],
    policy: {
      tools: new Set(tools),
      ...(stored?.mcpAllow ? { mcpAllow: stored.mcpAllow } : {}),
      grantPrefixes: stored?.grantPrefixes ?? [],
      ...(settings.safeSubcommands ? { safeSubcommands: settings.safeSubcommands } : {}),
      ...(stored?.scouts && scoutSpec
        ? {
            scouts: {
              spec: scoutSpec,
              extensions: stored.scouts.extensions,
              tools: stored.scouts.tools,
              ...(stored.scouts.mcpAllow ? { mcpAllow: stored.scouts.mcpAllow } : {}),
            },
          }
        : {}),
      guardExtensionPath: EXTENSION_ENTRY_PATH,
    },
  };
}

function plannerSessionDir() {
  return join(getAgentDir(), "plan-mode", "planners");
}

function availableModels(ctx: ExtensionContext): ModelSpec[] {
  const scoped = (ctx.scopedModels ?? []).map((entry) => ({ provider: entry.model.provider, modelId: entry.model.id }));
  if (scoped.length > 0) return scoped;
  try {
    return ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, modelId: model.id }));
  } catch {
    return [];
  }
}

function safeCommands(pi: ExtensionAPI) {
  try {
    return pi.getCommands();
  } catch {
    return [];
  }
}

function safeAllTools(pi: ExtensionAPI) {
  try {
    return pi.getAllTools();
  } catch {
    return [];
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type { TUI };
