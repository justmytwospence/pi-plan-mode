import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { CommandGrant } from "./command-grants.js";
import {
  formatModelSpec,
  IMPLEMENTATION_CONTEXT_CHOICES,
  type ImplementationContextChoice,
  type ImplementationModelOverride,
  isPendingImplementationModelIdentifier,
  type ModelSpec,
  parseModelSpec,
} from "./implementation-models.js";
import type { PlannerToolset } from "./multi-plan.js";
import type { SafeSubcommands } from "./tool-policy.js";

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-mode.json";
const LEGACY_PLAN_MODE_SETTINGS_FILE = "plan-mode.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
export const PLAN_MODE_THINKING_LEVELS = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const IMPLEMENTATION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const IMPLEMENTATION_PLAN_RETENTIONS = ["clear-on-start", "clear-after-first-run", "keep"] as const;
export const DEFAULT_PLAN_EXPORT_PATH = "PLAN.md";
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);
const MAX_PLAN_EXPORT_PATH_LENGTH = 4096;
export const DEFAULT_PLANNER_TIMEOUT_SECONDS = 45 * 60;
const MAX_PLANNER_TIMEOUT_SECONDS = 4 * 60 * 60;
const MAX_PLANNERS = 8;

export type PlanModeThinkingLevel = (typeof PLAN_MODE_THINKING_LEVELS)[number];
export type ImplementationPlanRetention = (typeof IMPLEMENTATION_PLAN_RETENTIONS)[number];
export type PlanModeFixedThinkingLevel = (typeof IMPLEMENTATION_THINKING_LEVELS)[number];
export interface PlanModeSettings {
  thinkingLevel: PlanModeThinkingLevel;
  defaultPlanTools?: string[];
  implementationPlanRetention?: ImplementationPlanRetention;
  defaultImplementationModel?: ImplementationModelOverride;
  defaultImplementationThinkingLevel?: PlanModeFixedThinkingLevel;
  defaultPlanExportPath?: string;
  safeSubcommands?: SafeSubcommands;
  toggleShortcut?: KeyId;
  /** Planning model (`provider/modelId`) to the default implementation model for its plans. */
  implementationModelMap?: Record<string, ModelSpec>;
  /** Whether implementation keeps the planning conversation or starts a fresh session. */
  defaultImplementationContext?: ImplementationContextChoice;
  /** Models preselected for `/plan multi`. */
  planners?: ModelSpec[];
  /** Planner model (`provider/modelId`) to the model its read-only subagents (plan_subagents) run on. */
  scoutModelMap?: Record<string, ModelSpec>;
  plannerTimeoutSeconds?: number;
  /** Load the user's extensions in planner subprocesses (needed for extension-provided models). */
  plannerLoadExtensions?: boolean;
  /** Named bundles of extensions and tools planners can be given, chosen per run in the planner picker. */
  plannerToolsets?: Record<string, PlannerToolset>;
  /** Commands Plan mode's read-only bash policy lets through when granted (e.g. marimo-pair's scripts). */
  commandGrants?: Record<string, CommandGrant>;
  /** Let Jev pick tools from the task, for planners and for Plan mode itself (default true; needs TYPESAFE_API_KEY). */
  jevToolSelection?: boolean;
  /** Jev probability at or above which a tool is preselected (default 0.5). */
  jevThreshold?: number;
  /** TypeSafe model for tool selection (default jev-latest). */
  jevModel?: string;
  /** Command (argv) run with Claude-style hook JSON on stdin whenever a plan is accepted. */
  planCompleteCommand?: string[];
}
export interface PlanModeSettingsPatch {
  thinkingLevel?: PlanModeThinkingLevel;
  defaultPlanTools?: readonly string[] | null;
  implementationPlanRetention?: ImplementationPlanRetention;
  defaultImplementationModel?: ImplementationModelOverride | null;
  defaultImplementationThinkingLevel?: PlanModeFixedThinkingLevel | null;
  defaultPlanExportPath?: string | null;
  toggleShortcut?: KeyId | null;
  implementationModelMap?: Readonly<Record<string, ModelSpec>> | null;
  defaultImplementationContext?: ImplementationContextChoice | null;
  planners?: readonly ModelSpec[] | null;
}
export interface UpdatePlanModeSettingsOptions {
  settingsPath?: string;
  legacySettingsPath?: string;
  signal?: AbortSignal;
  beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}
export type PlanModeSettingsLoadResult =
  | { kind: "missing"; notice?: string }
  | { kind: "invalid"; reason: string; notice?: string }
  | { kind: "loaded"; settings: PlanModeSettings; notice?: string };

type SettingsDocument = Record<string, unknown>;
type SettingsSnapshot = {
  result: PlanModeSettingsLoadResult;
  document?: SettingsDocument;
};

const mutationQueues = new Map<string, Promise<void>>();

export function planModeSettingsPath() {
  return join(getAgentDir(), PLAN_MODE_SETTINGS_FILE);
}

function legacyPlanModeSettingsPath() {
  return join(getAgentDir(), LEGACY_PLAN_MODE_SETTINGS_FILE);
}

export function normalizePlanModeSettings(value: unknown): PlanModeSettings | undefined {
  if (!isSettingsDocument(value)) return undefined;
  const thinkingLevel = Object.hasOwn(value, "thinkingLevel") ? Reflect.get(value, "thinkingLevel") : "inherit";
  if (!PLAN_MODE_THINKING_LEVELS.includes(thinkingLevel as PlanModeThinkingLevel)) {
    return undefined;
  }
  const settings: PlanModeSettings = {
    thinkingLevel: thinkingLevel as PlanModeThinkingLevel,
  };
  if (Object.hasOwn(value, "defaultPlanTools")) {
    const defaultPlanTools = normalizeToolNames(Reflect.get(value, "defaultPlanTools"));
    if (!defaultPlanTools) return undefined;
    settings.defaultPlanTools = defaultPlanTools;
  }
  if (Object.hasOwn(value, "implementationPlanRetention")) {
    const implementationPlanRetention = Reflect.get(value, "implementationPlanRetention");
    if (!IMPLEMENTATION_PLAN_RETENTIONS.includes(implementationPlanRetention as ImplementationPlanRetention)) {
      return undefined;
    }
    settings.implementationPlanRetention = implementationPlanRetention as ImplementationPlanRetention;
  }
  if (Object.hasOwn(value, "defaultImplementationModel")) {
    const defaultImplementationModel = normalizeImplementationModel(Reflect.get(value, "defaultImplementationModel"));
    if (!defaultImplementationModel) return undefined;
    settings.defaultImplementationModel = defaultImplementationModel;
  }
  if (Object.hasOwn(value, "defaultImplementationThinkingLevel")) {
    const defaultImplementationThinkingLevel = Reflect.get(value, "defaultImplementationThinkingLevel");
    if (!IMPLEMENTATION_THINKING_LEVELS.includes(defaultImplementationThinkingLevel as PlanModeFixedThinkingLevel)) {
      return undefined;
    }
    settings.defaultImplementationThinkingLevel = defaultImplementationThinkingLevel as PlanModeFixedThinkingLevel;
  }
  if (Object.hasOwn(value, "defaultPlanExportPath")) {
    const defaultPlanExportPath = normalizePlanExportPath(Reflect.get(value, "defaultPlanExportPath"));
    if (!defaultPlanExportPath) return undefined;
    settings.defaultPlanExportPath = defaultPlanExportPath;
  }
  if (Object.hasOwn(value, "toggleShortcut")) {
    const toggleShortcut = normalizeKeyId(Reflect.get(value, "toggleShortcut"));
    if (!toggleShortcut) return undefined;
    settings.toggleShortcut = toggleShortcut;
  }
  if (Object.hasOwn(value, "safeSubcommands")) {
    const safeSubcommands = normalizeSafeSubcommands(Reflect.get(value, "safeSubcommands"));
    if (!safeSubcommands) return undefined;
    settings.safeSubcommands = safeSubcommands;
  }
  if (Object.hasOwn(value, "implementationModelMap")) {
    const implementationModelMap = normalizeImplementationModelMap(Reflect.get(value, "implementationModelMap"));
    if (!implementationModelMap) return undefined;
    settings.implementationModelMap = implementationModelMap;
  }
  if (Object.hasOwn(value, "defaultImplementationContext")) {
    const context = Reflect.get(value, "defaultImplementationContext");
    if (!IMPLEMENTATION_CONTEXT_CHOICES.includes(context as ImplementationContextChoice)) return undefined;
    settings.defaultImplementationContext = context as ImplementationContextChoice;
  }
  if (Object.hasOwn(value, "planners")) {
    const planners = normalizePlanners(Reflect.get(value, "planners"));
    if (!planners) return undefined;
    settings.planners = planners;
  }
  if (Object.hasOwn(value, "scoutModelMap")) {
    const scoutModelMap = normalizeImplementationModelMap(Reflect.get(value, "scoutModelMap"));
    if (!scoutModelMap) return undefined;
    settings.scoutModelMap = scoutModelMap;
  }
  if (Object.hasOwn(value, "plannerTimeoutSeconds")) {
    const timeout = Reflect.get(value, "plannerTimeoutSeconds");
    if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_PLANNER_TIMEOUT_SECONDS) {
      return undefined;
    }
    settings.plannerTimeoutSeconds = timeout as number;
  }
  if (Object.hasOwn(value, "plannerLoadExtensions")) {
    const load = Reflect.get(value, "plannerLoadExtensions");
    if (typeof load !== "boolean") return undefined;
    settings.plannerLoadExtensions = load;
  }
  if (Object.hasOwn(value, "commandGrants")) {
    const grants = normalizeCommandGrants(Reflect.get(value, "commandGrants"));
    if (!grants) return undefined;
    settings.commandGrants = grants;
  }
  if (Object.hasOwn(value, "plannerToolsets")) {
    const toolsets = normalizePlannerToolsets(Reflect.get(value, "plannerToolsets"));
    if (!toolsets) return undefined;
    settings.plannerToolsets = toolsets;
  }
  if (Object.hasOwn(value, "jevToolSelection")) {
    const enabled = Reflect.get(value, "jevToolSelection");
    if (typeof enabled !== "boolean") return undefined;
    settings.jevToolSelection = enabled;
  }
  if (Object.hasOwn(value, "jevThreshold")) {
    const threshold = Reflect.get(value, "jevThreshold");
    if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) return undefined;
    settings.jevThreshold = threshold;
  }
  if (Object.hasOwn(value, "jevModel")) {
    const model = Reflect.get(value, "jevModel");
    if (typeof model !== "string" || !model.trim() || model.length > 200) return undefined;
    settings.jevModel = model.trim();
  }
  if (Object.hasOwn(value, "planCompleteCommand")) {
    const command = normalizeCommand(Reflect.get(value, "planCompleteCommand"));
    if (!command) return undefined;
    settings.planCompleteCommand = command;
  }
  return settings;
}

function normalizeImplementationModelMap(value: unknown): Record<string, ModelSpec> | undefined {
  if (!isSettingsDocument(value)) return undefined;
  const entries: [string, ModelSpec][] = [];
  for (const [key, target] of Object.entries(value)) {
    const source = parseModelSpec(key);
    const spec = parseModelSpec(target);
    if (!source || source.thinkingLevel || !spec) return undefined;
    entries.push([`${source.provider}/${source.modelId}`, spec]);
  }
  return Object.fromEntries(entries);
}

function normalizePlannerToolsets(value: unknown): Record<string, PlannerToolset> | undefined {
  if (!isSettingsDocument(value)) return undefined;
  const toolsets: Record<string, PlannerToolset> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/u.test(id) || id === "shell" || id === "subagents" || !isSettingsDocument(raw)) {
      return undefined;
    }
    const extensions = raw.extensions === undefined ? [] : normalizeCommand(raw.extensions);
    const tools = normalizeToolNames(raw.tools);
    if (raw.mcp !== undefined && typeof raw.mcp !== "boolean") return undefined;
    const toolDescriptions =
      raw.toolDescriptions === undefined
        ? undefined
        : isSettingsDocument(raw.toolDescriptions) &&
            Object.values(raw.toolDescriptions).every((value) => typeof value === "string")
          ? (raw.toolDescriptions as Record<string, string>)
          : null;
    if (toolDescriptions === null) return undefined;
    if (!extensions || !tools || tools.length === 0) return undefined;
    if (raw.label !== undefined && (typeof raw.label !== "string" || !raw.label.trim())) return undefined;
    if (raw.description !== undefined && (typeof raw.description !== "string" || !raw.description.trim())) {
      return undefined;
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return undefined;
    if (raw.scouts !== undefined && typeof raw.scouts !== "boolean") return undefined;
    toolsets[id] = {
      label: typeof raw.label === "string" ? raw.label.trim() : id,
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      ...(toolDescriptions ? { toolDescriptions } : {}),
      ...(raw.mcp === true ? { mcp: true } : {}),
      extensions,
      tools,
      enabled: raw.enabled !== false,
      scouts: raw.scouts !== false,
    };
  }
  return toolsets;
}

function normalizeCommandGrants(value: unknown): Record<string, CommandGrant> | undefined {
  if (!isSettingsDocument(value)) return undefined;
  const grants: Record<string, CommandGrant> = {};
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((item) => typeof item === "string" && item.trim().length > 0)
      ? (list as string[]).map((item) => item.trim())
      : undefined;
  for (const [id, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/u.test(id) || !isSettingsDocument(raw)) return undefined;
    const commands = strings(raw.commands);
    const skills = raw.skills === undefined ? [] : strings(raw.skills);
    if (!commands || commands.length === 0 || !skills) return undefined;
    if (raw.label !== undefined && (typeof raw.label !== "string" || !raw.label.trim())) return undefined;
    if (raw.description !== undefined && (typeof raw.description !== "string" || !raw.description.trim())) {
      return undefined;
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return undefined;
    if (raw.planMode !== undefined && typeof raw.planMode !== "boolean") return undefined;
    grants[id] = {
      label: typeof raw.label === "string" ? raw.label.trim() : id,
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      commands,
      skills,
      enabled: raw.enabled === true,
      planMode: raw.planMode === true,
    };
  }
  return grants;
}

function normalizePlanners(value: unknown): ModelSpec[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PLANNERS) return undefined;
  const planners: ModelSpec[] = [];
  for (const item of value) {
    const spec = parseModelSpec(item);
    if (!spec) return undefined;
    if (planners.some((existing) => formatModelSpec(existing) === formatModelSpec(spec))) continue;
    planners.push(spec);
  }
  return planners;
}

function normalizeCommand(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 4096)
  ) {
    return undefined;
  }
  return [...value];
}

export function serializeImplementationModelMap(map: Readonly<Record<string, ModelSpec>>) {
  return Object.fromEntries(Object.entries(map).map(([key, spec]) => [key, formatModelSpec(spec)]));
}

function normalizeImplementationModel(value: unknown): ImplementationModelOverride | undefined {
  if (!isSettingsDocument(value) || Object.keys(value).some((key) => key !== "provider" && key !== "modelId")) {
    return undefined;
  }
  const provider = typeof value.provider === "string" ? value.provider.trim() : value.provider;
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : value.modelId;
  if (!isPendingImplementationModelIdentifier(provider) || !isPendingImplementationModelIdentifier(modelId)) {
    return undefined;
  }
  return { provider, modelId };
}

function normalizeToolNames(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string" && item.trim().length > 0)
  ) {
    return undefined;
  }
  return Array.from(new Set(value));
}

function normalizePlanExportPath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_PLAN_EXPORT_PATH_LENGTH ||
    !/[^@\s]/u.test(normalized) ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return undefined;
  }
  return normalized;
}

export function normalizeKeyId(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const base = [...BASE_KEYS]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalized === candidate || normalized.endsWith(`+${candidate}`));
  if (!base) return undefined;
  const prefix = normalized.slice(0, normalized.length - base.length);
  if (!prefix) return base as KeyId;
  if (/^f(?:[1-9]|1[0-2])$/.test(base) || !prefix.endsWith("+")) return undefined;
  const modifiers = prefix.slice(0, -1).split("+");
  if (
    modifiers.length === 0 ||
    modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return undefined;
  }
  return normalized as KeyId;
}

function normalizeSafeSubcommands(value: unknown): SafeSubcommands | undefined {
  if (!isSettingsDocument(value)) return undefined;
  const entries: [string, string[]][] = [];
  for (const [command, subcommands] of Object.entries(value)) {
    const normalizedCommand = command.trim();
    if (
      !normalizedCommand ||
      !Array.isArray(subcommands) ||
      !subcommands.every((item): item is string => typeof item === "string" && item.trim().length > 0)
    ) {
      return undefined;
    }
    const normalizedSubcommands = Array.from(new Set(subcommands.map((subcommand) => subcommand.trim())));
    const existing = entries.find(([existingCommand]) => existingCommand === normalizedCommand);
    if (existing) existing[1] = Array.from(new Set([...existing[1], ...normalizedSubcommands]));
    else entries.push([normalizedCommand, normalizedSubcommands]);
  }
  return Object.fromEntries(entries);
}

export async function readPlanModeSettings(settingsPath?: string): Promise<PlanModeSettingsLoadResult> {
  if (settingsPath) {
    await awaitPlanModeSettingsWrites(settingsPath);
    return (await readSettingsSnapshot(settingsPath)).result;
  }
  const canonicalPath = planModeSettingsPath();
  await awaitPlanModeSettingsWrites(canonicalPath);
  const canonical = await readSettingsSnapshot(canonicalPath);
  const legacyPath = legacyPlanModeSettingsPath();
  if (canonical.result.kind !== "missing") {
    return (await pathExists(legacyPath))
      ? {
          ...canonical.result,
          notice: `${LEGACY_PLAN_MODE_SETTINGS_FILE} ignored because ${PLAN_MODE_SETTINGS_FILE} takes precedence.`,
        }
      : canonical.result;
  }

  const legacy = await readSettingsSnapshot(legacyPath);
  const raced = await readSettingsSnapshot(canonicalPath);
  if (raced.result.kind !== "missing") return raced.result;
  return legacy.result.kind === "loaded"
    ? {
        ...legacy.result,
        notice: `Using legacy ${LEGACY_PLAN_MODE_SETTINGS_FILE}; rename it to ${PLAN_MODE_SETTINGS_FILE}. The legacy file was not modified.`,
      }
    : legacy.result;
}

export function updatePlanModeSettings(
  patch: PlanModeSettingsPatch,
  options: UpdatePlanModeSettingsOptions = {},
): Promise<PlanModeSettings> {
  const settingsPath = options.settingsPath ?? planModeSettingsPath();
  const legacySettingsPath =
    options.legacySettingsPath ?? (options.settingsPath ? undefined : legacyPlanModeSettingsPath());
  return enqueueMutation(settingsPath, async () => {
    options.signal?.throwIfAborted();
    const current = await readSettingsDocumentForUpdate(settingsPath, legacySettingsPath);
    const updated: SettingsDocument = { ...current };
    if (patch.thinkingLevel !== undefined) updated.thinkingLevel = patch.thinkingLevel;
    if (patch.defaultPlanTools === null) delete updated.defaultPlanTools;
    else if (patch.defaultPlanTools !== undefined) {
      updated.defaultPlanTools = [...patch.defaultPlanTools];
    }
    if (patch.implementationPlanRetention !== undefined) {
      updated.implementationPlanRetention = patch.implementationPlanRetention;
    }
    if (patch.defaultImplementationModel === null) delete updated.defaultImplementationModel;
    else if (patch.defaultImplementationModel !== undefined) {
      const model = normalizeImplementationModel(patch.defaultImplementationModel);
      if (!model) throw invalidSettingsError(settingsPath, "invalid implementation model");
      updated.defaultImplementationModel = model;
    }
    if (patch.defaultImplementationThinkingLevel === null) {
      delete updated.defaultImplementationThinkingLevel;
    } else if (patch.defaultImplementationThinkingLevel !== undefined) {
      updated.defaultImplementationThinkingLevel = patch.defaultImplementationThinkingLevel;
    }
    if (patch.defaultPlanExportPath === null) delete updated.defaultPlanExportPath;
    else if (patch.defaultPlanExportPath !== undefined) {
      updated.defaultPlanExportPath = patch.defaultPlanExportPath;
    }
    if (patch.toggleShortcut === null) delete updated.toggleShortcut;
    else if (patch.toggleShortcut !== undefined) {
      updated.toggleShortcut = patch.toggleShortcut;
    }
    if (
      patch.implementationModelMap === null ||
      (patch.implementationModelMap && !Object.keys(patch.implementationModelMap).length)
    ) {
      delete updated.implementationModelMap;
    } else if (patch.implementationModelMap !== undefined) {
      updated.implementationModelMap = serializeImplementationModelMap(patch.implementationModelMap);
    }
    if (patch.defaultImplementationContext === null) delete updated.defaultImplementationContext;
    else if (patch.defaultImplementationContext !== undefined) {
      updated.defaultImplementationContext = patch.defaultImplementationContext;
    }
    if (patch.planners === null || (patch.planners && patch.planners.length === 0)) delete updated.planners;
    else if (patch.planners !== undefined) {
      updated.planners = patch.planners.map(formatModelSpec);
    }
    const settings = normalizePlanModeSettings(updated);
    if (!settings) throw invalidSettingsError(settingsPath, "invalid settings shape");
    await publishSettings(settingsPath, updated, options.signal, options.beforeRename);
    return settings;
  });
}

export async function awaitPlanModeSettingsWrites(settingsPath = planModeSettingsPath()): Promise<void> {
  await mutationQueues.get(settingsPath);
}

function enqueueMutation<T>(settingsPath: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(settingsPath) ?? Promise.resolve();
  const result = previous.then(mutation, mutation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(settingsPath, settled);
  void settled.finally(() => {
    if (mutationQueues.get(settingsPath) === settled) mutationQueues.delete(settingsPath);
  });
  return result;
}

async function readSettingsDocumentForUpdate(
  settingsPath: string,
  legacySettingsPath: string | undefined,
): Promise<SettingsDocument> {
  const canonical = await readSettingsSnapshot(settingsPath);
  if (canonical.result.kind === "loaded") return canonical.document ?? {};
  if (canonical.result.kind === "invalid") {
    throw invalidSettingsError(settingsPath, canonical.result.reason);
  }
  if (!legacySettingsPath) return {};

  const legacy = await readSettingsSnapshot(legacySettingsPath);
  const raced = await readSettingsSnapshot(settingsPath);
  if (raced.result.kind === "loaded") return raced.document ?? {};
  if (raced.result.kind === "invalid") {
    throw invalidSettingsError(settingsPath, raced.result.reason);
  }
  if (legacy.result.kind === "invalid") {
    throw invalidSettingsError(legacySettingsPath, legacy.result.reason);
  }
  return legacy.document ?? {};
}

async function readSettingsSnapshot(settingsPath: string): Promise<SettingsSnapshot> {
  let contents: string;
  try {
    contents = await readSettingsContents(settingsPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
    return { result: { kind: "invalid", reason: safeReadError(error) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { result: { kind: "invalid", reason: "invalid JSON" } };
  }
  const settings = normalizePlanModeSettings(parsed);
  if (!settings || !isSettingsDocument(parsed)) {
    return { result: { kind: "invalid", reason: "invalid settings shape" } };
  }
  return { document: parsed, result: { kind: "loaded", settings } };
}

async function readSettingsContents(settingsPath: string): Promise<string> {
  // Follow symlinks so a settings file managed by a dotfiles tool such as GNU stow keeps working.
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(settingsPath, flags);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT" && (await isSymlink(settingsPath))) {
      throw new Error("settings path is a symlink whose target is missing, not a regular file");
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("settings path is not a regular file");
    if (stats.size > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error("settings file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

async function publishSettings(
  settingsPath: string,
  document: SettingsDocument,
  signal?: AbortSignal,
  beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  // Replace the symlink target rather than the link so stow-managed settings stay linked.
  const targetPath = await resolveWriteTarget(settingsPath);
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const temporaryPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal,
    });
    await beforeRename?.(temporaryPath, settingsPath);
    signal?.throwIfAborted();
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function resolveWriteTarget(settingsPath: string) {
  try {
    return await realpath(settingsPath);
  } catch (error: unknown) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    if (await isSymlink(settingsPath)) {
      throw new Error("settings path is a symlink whose target is missing; refusing to replace it");
    }
    return settingsPath;
  }
}

async function isSymlink(path: string) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string) {
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    await handle.close();
    return true;
  } catch (error: unknown) {
    return !(isNodeError(error) && error.code === "ENOENT");
  }
}

function invalidSettingsError(settingsPath: string, reason: string) {
  return new Error(`pi-plan-mode settings at ${settingsPath} are invalid: ${reason}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeReadError(error: unknown) {
  if (isNodeError(error) && error.code === "ELOOP") return "settings path is not a regular file";
  return error instanceof Error ? error.message : String(error);
}

export function configuredThinkingLevel(settings: PlanModeSettings): PlanModeFixedThinkingLevel | undefined {
  return settings.thinkingLevel === "inherit" ? undefined : settings.thinkingLevel;
}

export function configuredImplementationPlanRetention(settings: PlanModeSettings): ImplementationPlanRetention {
  return settings.implementationPlanRetention ?? "clear-on-start";
}

export function configuredImplementationModel(settings: PlanModeSettings): ImplementationModelOverride | undefined {
  return settings.defaultImplementationModel;
}

export function configuredImplementationThinkingLevel(
  settings: PlanModeSettings,
): PlanModeFixedThinkingLevel | undefined {
  return settings.defaultImplementationThinkingLevel;
}

export function configuredImplementationModelMap(settings: PlanModeSettings): Record<string, ModelSpec> {
  return settings.implementationModelMap ?? {};
}

export function configuredImplementationContext(settings: PlanModeSettings): ImplementationContextChoice {
  return settings.defaultImplementationContext ?? "keep";
}

export function configuredPlanners(settings: PlanModeSettings): ModelSpec[] {
  return settings.planners ?? [];
}

export function configuredScoutModel(settings: PlanModeSettings, planner: ImplementationModelOverride) {
  return settings.scoutModelMap?.[`${planner.provider}/${planner.modelId}`];
}

export function configuredPlannerTimeoutSeconds(settings: PlanModeSettings) {
  return settings.plannerTimeoutSeconds ?? DEFAULT_PLANNER_TIMEOUT_SECONDS;
}

export function configuredPlanExportPath(settings: PlanModeSettings) {
  return settings.defaultPlanExportPath ?? DEFAULT_PLAN_EXPORT_PATH;
}

export function configuredPlanModeToggleShortcut(settings: PlanModeSettings): KeyId | undefined {
  return settings.toggleShortcut;
}
