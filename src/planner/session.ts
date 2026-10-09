// A planner is an in-process Pi agent session: its own model, effort, tools and read-only policy,
// running next to your main session in the same Pi process (as pi-btw and pi-subagents run theirs).
// The policy is this package's planner extension, passed as an inline factory; provider auth comes
// from the providers your session registered, so subscriptions and custom providers work unchanged.

import { existsSync } from "node:fs";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelSpec } from "../implementation-models.js";
import { PLANNER_SEED_END_ENTRY } from "../planners.js";

/** What a planner session runs with. */
export interface PlannerSessionOptions {
  cwd: string;
  spec: ModelSpec;
  /** Tool names the session starts with (`--tools`). */
  tools: string[];
  /** Extension paths for toolsets (web research, "Other tools"); `builtin:mcp` and `builtin:codemode` too. */
  extensions: string[];
  /** Skills granted commands rely on. */
  skills: string[];
  /** The planner policy extension for this planner. */
  policy: ExtensionFactory;
  /** Appended to the system prompt. */
  appendSystemPrompt: string[];
  /** A new session seeded with these messages, or an existing session file to continue. */
  storage: { kind: "new"; dir: string; seed: readonly unknown[] } | { kind: "open"; file: string };
}

export interface PlannerSessionHandle {
  session: AgentSession;
  /** The session file, to continue after a reload. */
  file: string | undefined;
  /** The session's entries on its current branch (what you said to a planner goes to your main conversation). */
  entries?(): readonly unknown[];
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

export type PlannerSessionFactory = (
  host: ExtensionContext,
  options: PlannerSessionOptions,
) => Promise<PlannerSessionHandle>;

/** One planner session creation at a time, so their extension loading never interleaves. */
let loading: Promise<unknown> = Promise.resolve();

export const createPlannerSession: PlannerSessionFactory = async (host, options) => {
  const run = loading.catch(() => undefined).then(() => openSession(host, options));
  loading = run;
  return run;
};

async function openSession(host: ExtensionContext, options: PlannerSessionOptions): Promise<PlannerSessionHandle> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const builtins: ExtensionFactory[] = [];
  const paths: string[] = [];
  for (const extension of options.extensions) {
    if (extension === "builtin:mcp") builtins.push(createMcpExtension() as ExtensionFactory);
    else if (extension === "builtin:codemode") builtins.push(createCodemodeExtension() as ExtensionFactory);
    else paths.push(extension);
  }
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noSkills: options.skills.length === 0,
    additionalSkillPaths: options.skills,
    additionalExtensionPaths: paths,
    extensionFactories: [options.policy, ...builtins] as never,
    appendSystemPrompt: options.appendSystemPrompt,
  });
  await loader.reload();

  const modelRuntime = await ModelRuntime.create();
  inheritProviders(host, modelRuntime);
  await modelRuntime.refresh({ allowNetwork: false });
  const model = host.modelRegistry.find(options.spec.provider, options.spec.modelId);
  if (!model) throw new Error(`Model ${options.spec.provider}/${options.spec.modelId} is not available.`);

  let sessionManager: SessionManager;
  if (options.storage.kind === "open") {
    sessionManager = SessionManager.open(options.storage.file, undefined, options.cwd);
  } else {
    sessionManager = SessionManager.create(options.cwd, options.storage.dir);
    for (const message of options.storage.seed) {
      try {
        sessionManager.appendMessage(message as never);
      } catch {
        // A message Pi will not store (e.g. a custom extension message) is just left out.
      }
    }
    sessionManager.appendCustomEntry(PLANNER_SEED_END_ENTRY, {});
  }

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    model,
    ...(options.spec.thinkingLevel ? { thinkingLevel: options.spec.thinkingLevel as never } : {}),
    tools: options.tools,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });
  await session.bindExtensions({ mode: "print" });
  return {
    session,
    file: sessionManager.getSessionFile(),
    entries: () => sessionManager.getBranch(),
    subscribe: (listener) => session.subscribe(listener),
    dispose: () => session.dispose(),
  };
}

/** A stored planner session's entries, read without opening it as an agent session. */
export function readSessionEntries(file: string, cwd: string): readonly unknown[] {
  if (!existsSync(file)) return [];
  try {
    return SessionManager.open(file, undefined, cwd).getBranch();
  } catch {
    return [];
  }
}

/** The planner reaches models the way your session does: the same registered providers. */
export function inheritProviders(host: ExtensionContext, runtime: ModelRuntime) {
  const registry = host.modelRegistry as unknown as {
    getRegisteredProviderIds?(): readonly string[];
    getRegisteredNativeProvider?(id: string): unknown;
    getRegisteredProviderConfig?(id: string): unknown;
  };
  for (const id of new Set(registry.getRegisteredProviderIds?.() ?? [])) {
    try {
      const native = registry.getRegisteredNativeProvider?.(id);
      if (native) {
        runtime.registerNativeProvider(native as never);
        continue;
      }
      const config = registry.getRegisteredProviderConfig?.(id);
      if (config) runtime.registerProvider(id, config as never);
    } catch {
      // A provider that cannot be copied stays as Pi configures it by default.
    }
  }
}
