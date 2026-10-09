// /plan: a full-screen planning app. Settings → Tools → Planning → Review → Implement, with one or
// two planners. Each planner is an in-process Pi session (planner/agent.ts) seeded with your
// conversation. M, the pane below the lanes, is your main agent: each plan lands in your main
// conversation in full, and there your agent can question a planner or record the merged plan
// (main-chat.ts).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  LoginDialogComponent,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { FULL_SCREEN } from "./app/frame.js";
import { type LaneAction, LanesPage } from "./app/lanes-page.js";
import { type OptionRow, OptionsPage, type TextArea } from "./app/options-page.js";
import { formatImplementationPrompt } from "./handoff.js";
import { holdBlocked, holdWorking } from "./herdr-blocked.js";
import {
  formatModelKey,
  formatModelSpec,
  type ImplementationContextChoice,
  type ModelSpec,
  parseModelSpec,
  sameModel,
} from "./implementation-models.js";
import { type JevToolPick, pickToolsWithJev } from "./jev-tool-picker.js";
import { isAuthError, loginInDialog, providerName } from "./login.js";
import {
  MainAgentView,
  type MergedPlan,
  PLAN_MESSAGE_TYPE,
  type PlanMessageDetails,
  registerMainChat,
  setMainToolsActive,
} from "./main-chat.js";
import { buildMcpCatalog, readConfiguredMcpServers } from "./mcp-tools.js";
import { modelCatalog } from "./model-catalog.js";
import { exportPlanToFile } from "./plan-export.js";
import { expandHome, runPlanCompleteHook } from "./plan-hook.js";
import { type OtherTool, otherTools, otherToolsNode, resolveAccess } from "./planner/access.js";
import { type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import {
  planDeliveryText,
  planFailureText,
  plannerSystemPrompt,
  plannerTaskPrompt,
  resumeMessage,
  writeMergedRequest,
} from "./planner/prompt.js";
import { inheritProviders, type PlannerSessionFactory } from "./planner/session.js";
import { buildPlannerTranscript } from "./planners.js";
import { extensionsForProvider, resolveProviderExtensions } from "./provider-extensions.js";
import {
  configuredAlwaysOffer,
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
/** The merged plan your main agent records. */
const MERGED_ID = "M";
/** The effort a subagent model starts at until you change it. */
const SUBAGENT_EFFORT = "medium";
const TIME_LIMITS = [15, 30, 45, 60, 90, 120, 180] as const;

export interface PlanDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  createSession?: PlannerSessionFactory;
  pickTools?: typeof pickToolsWithJev;
  /** Log in to a provider again, showing the login dialog through `show`; rejects if it fails. */
  login?(providerId: string, show: (dialog: Component) => void): Promise<void>;
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
  /** Its turn was in progress (or had failed) when last saved: restoring the run resumes it. */
  turn?: TurnState;
  /** The plan version last delivered to your main conversation, and where its conversation stood. */
  delivered?: Delivered;
}

interface Delivered {
  revision: number;
  /** Planner session entries already covered, so the next delivery adds only what is new. */
  mark: number;
}

type TurnState = "interrupted" | "failed";

interface StoredRun {
  id: string;
  createdAt: number;
  task: string;
  state: "active" | "discarded" | "implemented";
  planners: StoredPlanner[];
  merged?: StoredMerged;
}

/** Plan M, with the model that wrote it (your session's), for implementation defaults. */
interface StoredMerged extends MergedPlan {
  spec?: string;
}

/** One planning run: the task, its planners, and the plan your main agent merged, if any. */
interface PlanRun {
  id: string;
  createdAt: number;
  task: string;
  agents: PlannerAgent[];
  merged?: StoredMerged;
  /** What each planner has delivered to your main conversation. */
  delivered: Map<string, Delivered>;
  /** Failures already reported to your main conversation. */
  failuresReported: Set<string>;
  /** How to start another planner with the same tools. */
  launch?: { roots: ToolNode[]; others: OtherTool[]; seed: readonly unknown[] };
}

interface Draft {
  task: string;
  planners: [ModelSpec, ModelSpec | undefined];
  scouts: Record<string, ModelSpec | undefined>;
  timeLimit: number;
}

type ThinkingLevel = NonNullable<ModelSpec["thinkingLevel"]>;

export default function plan(pi: ExtensionAPI, dependencies: PlanDependencies = {}) {
  let settings: PlanModeSettings = { thinkingLevel: "inherit" };
  let run: PlanRun | undefined;
  let app: { close(): void; render(): void } | undefined;
  let releaseWorking: (() => void) | undefined;
  let releaseBlocked: (() => void) | undefined;
  let hostCtx: ExtensionContext | undefined;
  /** Where you dragged the divider above M (a share of the space), for the rest of this process. */
  let mergerShare: number | undefined;
  /** Plan versions and question sets you have been told about (or saw on screen). */
  const notifiedPlans = new Map<string, number>();
  const notifiedQuestions = new WeakSet<object>();

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
    const current = run;
    const stored: StoredRun = {
      id: current.id,
      createdAt: current.createdAt,
      task: current.task,
      state,
      planners: current.agents.map((agent) => storePlanner(agent, current.delivered.get(agent.id))),
      ...(current.merged ? { merged: current.merged } : {}),
    };
    pi.appendEntry(RUN_ENTRY, stored);
  };

  /** What each planner last saved: its plan version, session file, and whether a turn was underway. */
  const saved = new Map<string, string>();
  const onAgentChange = () => {
    if (!run) return;
    // Save a run whenever a session file, a plan, or a turn starts or ends, so a reload can restore
    // it and resume the turns it cut off.
    let changed = deliver();
    for (const agent of run.agents) {
      const signature = savedSignature(agent);
      if (saved.get(agent.id) === signature) continue;
      saved.set(agent.id, signature);
      changed = true;
    }
    if (changed) persistRun();
    const working = run.agents.some((agent) => agent.working);
    if (working && !releaseWorking) releaseWorking = holdWorking(pi.events, "Planning");
    if (!working && releaseWorking) {
      releaseWorking();
      releaseWorking = undefined;
    }
    // A planner waiting for your answers shows in herdr as blocked, over the working hold.
    const asking = run.agents.some((agent) => agent.status === "asking");
    if (asking && !releaseBlocked) releaseBlocked = holdBlocked(pi.events, "Planner question");
    if (!asking && releaseBlocked) {
      releaseBlocked();
      releaseBlocked = undefined;
    }
    updateStatus();
    app?.render();
  };

  /**
   * Deliver new plans (and revisions), in full, to your main conversation, with what you and the
   * planner said since its last delivery; report failures there too. Returns whether anything was
   * delivered (so the run is saved).
   */
  const deliver = () => {
    const current = run;
    if (!current) return false;
    let delivered = false;
    for (const agent of current.agents) {
      const last = current.delivered.get(agent.id);
      const model = `${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}`;
      if (agent.plan && last?.revision !== agent.revision && !agent.working) {
        const conversation = agent.conversation(last?.mark ?? 0);
        const others = current.agents.filter((other) => other !== agent).map(otherPlannerLine);
        sendToMain(
          planDeliveryText({
            id: agent.id,
            model,
            revision: agent.revision,
            plan: agent.plan,
            task: current.task,
            conversation: conversation.text,
            others,
          }),
          { kind: "plan", id: agent.id, model, revision: agent.revision, lines: agent.plan.split("\n").length },
        );
        current.delivered.set(agent.id, { revision: agent.revision, mark: conversation.mark });
        mainAgent.trace.note(
          `Plan ${agent.id}${agent.revision > 1 ? ` v${agent.revision}` : ""} delivered to your agent.`,
        );
        delivered = true;
      }
      if (agent.status === "failed" && agent.error) {
        const key = `${agent.id}:${agent.stats.startedAt}:${agent.error}`;
        if (!current.failuresReported.has(key)) {
          current.failuresReported.add(key);
          sendToMain(planFailureText(agent.id, model, agent.error), { kind: "failure", id: agent.id, model });
          mainAgent.trace.note(`Planner ${agent.id} failed; your agent was told.`, "warning");
        }
      }
    }
    return delivered;
  };

  /** A message in your main conversation: shown, and read by your agent on its next turn. */
  const sendToMain = (content: string, details: PlanMessageDetails) => {
    try {
      pi.sendMessage<PlanMessageDetails>(
        { customType: PLAN_MESSAGE_TYPE, content, display: true, details },
        {
          triggerTurn: false,
        },
      );
    } catch {
      // A session that cannot take messages just misses the delivery; /plan still has the plan.
    }
  };

  const updateStatus = () => {
    const ctx = hostCtx;
    if (!ctx?.hasUI) return;
    if (!run || app) ctx.ui.setStatus(STATUS_KEY, undefined);
    else {
      const parts = run.agents.map(
        (agent) =>
          `${agent.id} ${agent.status === "asking" ? "asking you" : agent.working ? "working" : agent.plan ? "ready" : agent.status === "failed" ? "failed" : "waiting"}`,
      );
      ctx.ui.setStatus(STATUS_KEY, `plan: ${parts.join(" · ")} (/plan)`);
    }
    if (!run) return;
    // Tell you once per new question and once per new plan version; what you already see on the
    // planning screen counts as told.
    for (const agent of run.agents) {
      if (agent.status === "asking" && agent.pending && !notifiedQuestions.has(agent.pending)) {
        notifiedQuestions.add(agent.pending);
        if (!app) ctx.ui.notify(`Planner ${agent.id} is asking you something. /plan to answer.`, "info");
      } else if (agent.plan && !agent.working && notifiedPlans.get(agent.id) !== agent.revision) {
        notifiedPlans.set(agent.id, agent.revision);
        if (!app) {
          const version = agent.revision > 1 ? ` v${agent.revision}` : "";
          ctx.ui.notify(`Plan ${agent.id}${version} is ready, and in this conversation. /plan to review it.`, "info");
        }
      }
    }
  };

  /** Plan M from your main agent  /** Plan M from your main agent: recorded in the run, implemented or exported from /plan. */
  const submitMerged = (plan: string, ctx: ExtensionContext): MergedPlan | undefined => {
    if (!run) return undefined;
    const model = ctx.model;
    run.merged = {
      plan,
      revision: (run.merged?.revision ?? 0) + 1,
      name: model?.name || model?.id || "your main agent",
      ...(model ? { spec: `${model.provider}/${model.id}` } : {}),
    };
    persistRun();
    updateStatus();
    app?.render();
    return run.merged;
  };

  const disposeRun = (state: StoredRun["state"]) => {
    if (!run) return;
    persistRun(state);
    for (const agent of run.agents) agent.dispose();
    releaseWorking?.();
    releaseWorking = undefined;
    releaseBlocked?.();
    releaseBlocked = undefined;
    run = undefined;
    saved.clear();
    notifiedPlans.clear();
    setMainToolsActive(pi, false);
    updateStatus();
  };

  const restoreRun = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === RUN_ENTRY)
      ?.data as StoredRun | undefined;
    if (latest?.state !== "active" || !Array.isArray(latest.planners)) return;
    const agents = latest.planners.flatMap((stored) => {
      const spec = parseModelSpec(stored.spec);
      if (!spec) return [];
      return [
        new PlannerAgent({
          id: stored.id,
          spec,
          name: stored.name,
          cwd: ctx.cwd,
          access: restoreAccess(stored.access, settings),
          timeoutMs: configuredPlannerTimeoutSeconds(settings) * 1000,
          sessionDir: plannerSessionDir(),
          seed: [],
          ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
          ...(stored.plan ? { plan: stored.plan, revision: stored.revision ?? 1 } : {}),
          onChange: onAgentChange,
          ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
        }),
      ];
    });
    if (agents.length === 0) return;
    run = {
      id: latest.id,
      createdAt: latest.createdAt,
      task: latest.task,
      agents,
      ...(latest.merged ? { merged: latest.merged } : {}),
      delivered: new Map(
        latest.planners.flatMap((stored) => (stored.delivered ? [[stored.id, stored.delivered] as const] : [])),
      ),
      failuresReported: new Set(),
    };
    for (const agent of run.agents) {
      saved.set(agent.id, savedSignature(agent));
      if (agent.plan) notifiedPlans.set(agent.id, agent.revision);
    }
    setMainToolsActive(pi, true);
    // Runs saved before plans were delivered to your main conversation deliver them now, once.
    if (deliver()) persistRun();
    // Turns a reload or restart cut off (or that had failed) carry on by themselves.
    for (const agent of run.agents) {
      const turn = latest.planners.find((candidate) => candidate.id === agent.id)?.turn;
      if (!turn || !agent.sessionFile) continue;
      void agent.say(
        resumeMessage(turn),
        ctx,
        turn === "interrupted"
          ? "continue (resumed: the session restarted mid-turn)"
          : "try again (resumed after an error)",
      );
    }
  };

  // --- Events ------------------------------------------------------------------------------------

  // M: your main agent, as the pane below the lanes shows it.
  const mainAgent = new MainAgentView({
    model: () => {
      const model = hostCtx?.model;
      const level = pi.getThinkingLevel();
      const spec: ModelSpec = {
        provider: model?.provider ?? "",
        modelId: model?.id ?? "",
        ...(level && level !== "off" ? { thinkingLevel: level as ThinkingLevel } : {}),
      };
      return { name: model?.name || model?.id || "your agent", spec };
    },
    merged: () => run?.merged,
    onChange: () => app?.render(),
  });
  for (const event of [
    "agent_start",
    "agent_end",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
  ] as const) {
    pi.on(event as "agent_start", (payload) => {
      mainAgent.apply(payload as unknown as Record<string, unknown>);
    });
  }

  // Your main agent's side of a run: plans delivered to it, and its two tools.
  registerMainChat(pi, {
    planners: () => run?.agents,
    submitMerged,
  });

  pi.on("session_start", async (_event, ctx) => {
    hostCtx = ctx;
    for (const agent of run?.agents ?? []) agent.dispose();
    run = undefined;
    saved.clear();
    notifiedPlans.clear();
    setMainToolsActive(pi, false);
    mainAgent.reset(ctx.sessionManager.getBranch());
    await loadSettings();
    await applyPendingRuntime(ctx);
    restoreRun(ctx);
    updateStatus();
  });

  pi.on("session_shutdown", () => {
    for (const agent of run?.agents ?? []) agent.dispose();
    releaseWorking?.();
    releaseWorking = undefined;
    releaseBlocked?.();
    releaseBlocked = undefined;
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
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      const rows = () => Math.max(12, (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40);
      const render = () => tui.requestRender();
      let page: Component & { typing?: boolean } = undefined as never;
      const ticker = setInterval(() => {
        if (run?.agents.some((agent) => agent.working)) render();
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

      /**
       * The task editor: the one your main editor uses (an extension's, such as pi-vim's), else pi's
       * own. It wraps and scrolls inside its borders.
       */
      const createTextArea = (): TextArea => {
        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("borderAccent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("dim", text),
          },
        };
        const factory = ctx.ui.getEditorComponent?.();
        const editor = factory
          ? factory(tui, editorTheme, keybindings)
          : new CustomEditor(tui, editorTheme, keybindings, { paddingX: 1 });
        editor.setPaddingX?.(1);
        // pi-vim's :q would quit pi; here it leaves the task.
        const vim = editor as { setQuitFn?(fn: () => void): void; onEscape?: () => void };
        vim.setQuitFn?.(() => vim.onEscape?.());
        return editor as unknown as TextArea;
      };

      const show = (next: Component) => {
        page = next;
        render();
      };

      const lanes = (): LanesPage => {
        const lanesPage: LanesPage = new LanesPage(theme, {
          title: "Plan",
          task: () => run?.task ?? "",
          agents: () => run?.agents ?? [],
          // With two planners, M is your main agent: you can talk to it while they work.
          merger: () =>
            run && run.agents.length > 1 ? { agent: mainAgent, name: mainAgent.name, ready: true } : undefined,
          actions: () => laneActions(),
          onAction: (id, text) => onLaneAction(id, text),
          say: (agent, text) => void run?.agents.find((candidate) => candidate.id === agent.id)?.say(text, ctx),
          mergerShare: {
            get: () => mergerShare,
            set: (share) => {
              mergerShare = share;
            },
          },
          sayToMerger: (text) => {
            // Like typing in your main editor: a new turn, or a steer while your agent is working.
            pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" });
          },
          hide: close,
          stopAll: () => {
            for (const agent of run?.agents ?? []) void agent.stop();
            if (mainAgent.working) ctx.abort();
          },
          rowsAvailable: rows,
          requestRender: render,
        });
        return lanesPage;
      };

      /** Every plan you can implement or export: plan M (your main agent's) first, then A and B. */
      const sources = (): PlanSource[] => {
        if (!run) return [];
        const merged = run.merged;
        return [
          ...(merged
            ? [
                {
                  id: MERGED_ID,
                  name: merged.name,
                  revision: merged.revision,
                  plan: merged.plan,
                  spec: merged.spec ? parseModelSpec(merged.spec) : undefined,
                },
              ]
            : []),
          ...run.agents.flatMap((agent) =>
            agent.plan
              ? [{ id: agent.id, name: agent.name, revision: agent.revision, plan: agent.plan, spec: agent.spec }]
              : [],
          ),
        ];
      };

      const laneActions = (): LaneAction[] => {
        const agents = run?.agents ?? [];
        // The merged plan comes first: once there is one, it is usually the one to build.
        const ready = sources();
        const actions: LaneAction[] = [];
        // With two plans in, M can merge them: first in line until it has, then right after Implement M.
        const merged = run?.merged;
        const mergeable = agents.length > 1 && agents.filter((agent) => agent.plan).length > 1 && !mainAgent.working;
        const merge: LaneAction = {
          id: "merge",
          label: merged ? "Revise plan M" : "Write plan M",
          description: merged
            ? "Ask M to fold what you have discussed since into plan M, as a new version."
            : "Ask M to merge both plans and what you have discussed into plan M, which you can then implement or export.",
          toMerger: writeMergedRequest(merged !== undefined),
        };
        // A planner its provider turned away for its credentials: log in again, here, and it retries.
        for (const agent of agents) {
          if (agent.status !== "failed" || !isAuthError(agent.error)) continue;
          actions.push({
            id: `login:${agent.id}`,
            label: `Log in to ${agent.spec.provider}…`,
            description: `${agent.id} was refused: ${agent.error}. Log in to ${agent.spec.provider} again (as /login does) and ${agent.id} tries again.`,
          });
        }
        if (mergeable && !merged) actions.push(merge);
        for (const source of ready) {
          actions.push({
            id: `implement:${source.id}`,
            label: `Implement ${source.id}…`,
            description: `Implement ${source.id === MERGED_ID ? "the merged plan M" : `plan ${source.id}`}${source.revision > 1 ? ` v${source.revision}` : ""}: choose the model, effort, and context next.`,
          });
        }
        // Implement M is first once M has a plan; Revise plan M goes right after it.
        if (mergeable && merged) actions.splice(1, 0, merge);
        if (agents.length === 1) {
          actions.push({
            id: "add",
            label: "Add a planner…",
            description: "Plan the same task with a second model in parallel; the first keeps its plan and context.",
          });
        }
        for (const source of ready) {
          actions.push({
            id: `export:${source.id}`,
            label: `Export ${source.id}…`,
            description: `Write plan ${source.id} to a Markdown file.`,
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

      /** Log in to a planner's provider in Pi's login dialog, then have the planner try again. */
      const loginAndRetry = async (agent: PlannerAgent) => {
        const providerId = agent.spec.provider;
        const back = lanes();
        try {
          await (dependencies.login ?? loginWithDialog)(providerId, (dialog) => show(dialog));
          show(back);
          ctx.ui.notify(`Logged in to ${providerId}. Planner ${agent.id} is trying again.`, "info");
          void agent.say(resumeMessage("failed"), ctx, "try again (after logging in)");
        } catch (error: unknown) {
          show(back);
          const message = errorText(error);
          if (message !== "Login cancelled") ctx.ui.notify(`Login to ${providerId} failed: ${message}`, "error");
        }
      };

      const loginWithDialog = async (providerId: string, showDialog: (dialog: Component) => void) => {
        const runtime = await ModelRuntime.create();
        inheritProviders(ctx, runtime);
        const dialog = new LoginDialogComponent(tui, providerId, () => undefined, providerName(runtime, providerId));
        dialog.focused = true;
        showDialog(dialog);
        await loginInDialog(runtime, providerId, dialog, () =>
          SettingsManager.create(ctx.cwd, getAgentDir()).getOrCreateDeviceId(),
        );
      };

      const onLaneAction = (id: string, text?: string) => {
        const [kind, sourceId] = id.split(":");
        const source = sources().find((candidate) => candidate.id === sourceId);
        if (kind === "implement" && source) return show(implementPage(source));
        if (kind === "export" && source) {
          const plan = source.plan;
          void exportPlanToFile(
            plan,
            text || undefined,
            ctx.cwd,
            undefined,
            () => true,
            configuredPlanExportPath(settings),
          )
            .then((result) => {
              ctx.ui.notify(`Plan ${source.id} exported to ${result.path}.`, "info");
              hook(ctx, source);
            })
            .catch((error: unknown) => ctx.ui.notify(`Export failed: ${errorText(error)}`, "error"));
          return;
        }
        if (kind === "login") {
          const agent = run?.agents.find((candidate) => candidate.id === sourceId);
          if (agent) void loginAndRetry(agent);
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
        scouts: Object.fromEntries(
          Object.entries(settings.scoutModelMap ?? {}).map(([key, spec]) => [
            key,
            withEffort(spec, spec.thinkingLevel ?? SUBAGENT_EFFORT),
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
        draft.scouts[formatModelKey(spec)] = next
          ? withEffort(next, current?.thinkingLevel ?? SUBAGENT_EFFORT)
          : undefined;
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
              placeholder: "(from the conversation) tab to write what to plan",
              multiline: true,
            },
            description:
              "What to plan. Tab moves in and out of it; shift+⏎ starts a new line. Leave it empty to plan what the conversation so far is about.",
            hidden: () => adding,
          },
          ...plannerRows(0, adding),
          ...plannerRows(1, adding),
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
          applyAlwaysOffer(roots, configuredAlwaysOffer(settings));
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

      const implementPage = (first: PlanSource) => {
        let author = first;
        const ready = sources;
        const defaults = (source: PlanSource) => {
          const mapped = source.spec ? settings.implementationModelMap?.[formatModelKey(source.spec)] : undefined;
          const base = mapped ?? sessionSpec ?? source.spec ?? (models[0] as ModelSpec);
          return withEffort(base, mapped?.thinkingLevel);
        };
        let target = defaults(author);
        let context: ImplementationContextChoice = configuredImplementationContext(settings);
        const optionRows: OptionRow[] = [
          {
            id: "plan",
            label: "Plan",
            value: () =>
              `${author.id}${author.id === MERGED_ID ? " (merged)" : ""} · ${author.name}${author.revision > 1 ? ` v${author.revision}` : ""}`,
            cycle: (direction) => {
              const list = ready();
              const index = list.findIndex((source) => source.id === author.id);
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
          delivered: new Map(),
          failuresReported: new Set(),
          launch: { roots: current.roots, others: current.others, seed },
        };
        setMainToolsActive(pi, true);
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
          applyAlwaysOffer(roots, configuredAlwaysOffer(settings));
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

  function hook(ctx: ExtensionContext, source: PlanSource) {
    if (!settings.planCompleteCommand) return;
    const spec = source.spec ?? (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined);
    void runPlanCompleteHook({
      command: settings.planCompleteCommand,
      plan: source.plan,
      cwd: ctx.cwd,
      ...(spec ? { model: { provider: spec.provider, modelId: spec.modelId } } : {}),
    } as Parameters<typeof runPlanCompleteHook>[0]);
  }

  async function implement(
    ctx: ExtensionCommandContext,
    source: PlanSource,
    target: ModelSpec,
    context: ImplementationContextChoice,
  ) {
    const plan = source.plan;
    hook(ctx, source);
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

/** A working turn is saved as interrupted: if the process dies, that is what it was. */
function turnState(agent: PlannerAgent): TurnState | undefined {
  if (agent.working) return "interrupted";
  return agent.status === "failed" ? "failed" : undefined;
}

function savedSignature(agent: PlannerAgent) {
  return `${agent.revision}|${agent.sessionFile ?? ""}|${turnState(agent) ?? ""}`;
}

/** A plan you can implement or export: a planner's, or M, the one your main agent merged. */
interface PlanSource {
  id: string;
  name: string;
  revision: number;
  plan: string;
  /** The model that wrote it; for M, your session's model when it was recorded. */
  spec: ModelSpec | undefined;
}

/** How another planner stands, for a delivery message. */
function otherPlannerLine(agent: PlannerAgent) {
  if (agent.status === "asking") return `Planner ${agent.id} is waiting for the user's answers to its questions.`;
  if (agent.working) return `Planner ${agent.id} is still planning.`;
  if (agent.status === "failed") return `Planner ${agent.id} failed${agent.error ? `: ${agent.error}` : ""}.`;
  if (agent.plan)
    return `Planner ${agent.id}'s plan${agent.revision > 1 ? ` v${agent.revision}` : ""} is earlier in this conversation.`;
  return `Planner ${agent.id} has no plan yet.`;
}

function storePlanner(agent: PlannerAgent, delivered: Delivered | undefined): StoredPlanner {
  const turn = turnState(agent);
  return {
    id: agent.id,
    spec: agent.label,
    name: agent.name,
    access: storeAccess(agent.access),
    ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
    ...(agent.plan ? { plan: agent.plan, revision: agent.revision } : {}),
    ...(turn ? { turn } : {}),
    ...(delivered ? { delivered } : {}),
  };
}

/** A restored planner's tools; without a record (older runs), it may read, search and run safe commands. */
function restoreAccess(stored: StoredAccess | undefined, settings: PlanModeSettings): PlannerAccessConfig {
  const tools = stored?.tools ?? ["read", "grep", "find", "ls", "bash", "plan_mode_question", "plan_mode_complete"];
  const scoutSpec = stored?.scouts ? parseModelSpec(stored.scouts.spec) : undefined;
  return {
    tools,
    extensions: stored?.extensions ?? [],
    skills: stored?.skills ?? [],
    systemPrompt: [plannerSystemPrompt()],
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
