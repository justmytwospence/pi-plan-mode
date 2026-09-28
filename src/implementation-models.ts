import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH = 512;

export const MODEL_SPEC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelSpecThinkingLevel = (typeof MODEL_SPEC_THINKING_LEVELS)[number];

export interface ImplementationModelOverride {
  provider: string;
  modelId: string;
}

/** A model plus an optional thinking level, written as `provider/modelId[:thinking]`. */
export interface ModelSpec extends ImplementationModelOverride {
  thinkingLevel?: ModelSpecThinkingLevel;
}

export type ImplementationContextChoice = "keep" | "clear";
export const IMPLEMENTATION_CONTEXT_CHOICES = ["keep", "clear"] as const;

export interface AvailableImplementationModel {
  provider: string;
  id: string;
  name?: string;
}

export function isPendingImplementationModelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH
  );
}

/**
 * Parse `provider/modelId[:thinking]`. The provider ends at the first slash, so model IDs may
 * contain slashes (OpenRouter-style IDs). A trailing `:level` is only treated as a thinking
 * suffix when it names a known level, so IDs such as `model:0` survive intact.
 */
export function parseModelSpec(value: unknown): ModelSpec | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  let thinkingLevel: ModelSpecThinkingLevel | undefined;
  const colon = text.lastIndexOf(":");
  if (colon > 0) {
    const suffix = text.slice(colon + 1).toLowerCase();
    if ((MODEL_SPEC_THINKING_LEVELS as readonly string[]).includes(suffix)) {
      thinkingLevel = suffix as ModelSpecThinkingLevel;
      text = text.slice(0, colon);
    }
  }
  const slash = text.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = text.slice(0, slash).trim();
  const modelId = text.slice(slash + 1).trim();
  if (!isPendingImplementationModelIdentifier(provider) || !isPendingImplementationModelIdentifier(modelId)) {
    return undefined;
  }
  return { provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function formatModelKey(model: ImplementationModelOverride) {
  return `${model.provider}/${model.modelId}`;
}

export function formatModelSpec(spec: ModelSpec) {
  return spec.thinkingLevel ? `${formatModelKey(spec)}:${spec.thinkingLevel}` : formatModelKey(spec);
}

export function sameModel(
  left: ImplementationModelOverride | undefined,
  right: ImplementationModelOverride | undefined,
) {
  return (
    left !== undefined && right !== undefined && left.provider === right.provider && left.modelId === right.modelId
  );
}

export function snapshotAvailableImplementationModels(ctx: ExtensionContext): AvailableImplementationModel[] {
  const getAvailable = ctx.modelRegistry.getAvailable;
  const availableModels = typeof getAvailable === "function" ? getAvailable.call(ctx.modelRegistry) : [];
  const scopedModels = ctx.scopedModels ?? [];
  if (scopedModels.length === 0) return availableModels;
  return scopedModels.flatMap((entry) => {
    const availableModel = availableModels.find(
      (model) => model.provider === entry.model.provider && model.id === entry.model.id,
    );
    return availableModel ? [availableModel] : [];
  });
}

export function findAvailableImplementationModel(
  models: readonly AvailableImplementationModel[],
  configured: ImplementationModelOverride | undefined,
): AvailableImplementationModel | undefined {
  if (!configured) return undefined;
  return models.find((model) => model.provider === configured.provider && model.id === configured.modelId);
}

export interface ImplementationDefaultsInput {
  /** The model that authored the plan being implemented. */
  planModel: ImplementationModelOverride | undefined;
  /** The session's current model; a default equal to it is reported as "current model". */
  sessionModel: ImplementationModelOverride | undefined;
  /** Plan-model key (`provider/modelId`) to implementation model spec. */
  modelMap: Readonly<Record<string, ModelSpec>> | undefined;
  defaultModel: ImplementationModelOverride | undefined;
  defaultThinkingLevel: ModelSpecThinkingLevel | undefined;
  defaultContext: ImplementationContextChoice | undefined;
  available: readonly AvailableImplementationModel[];
}

export type ImplementationModelSource = "map" | "default" | "plan";

export interface ResolvedImplementationDefaults {
  /** Undefined means "keep the session's current model". */
  model?: ImplementationModelOverride;
  thinkingLevel?: ModelSpecThinkingLevel;
  context: ImplementationContextChoice;
  modelSource: ImplementationModelSource;
  /** Configured targets skipped because they are not currently available. */
  unavailable: ImplementationModelOverride[];
}

/**
 * Pick the implementation defaults for a plan: the plan model's entry in the model map wins, then
 * the global default implementation model, then the planning model itself.
 */
export function resolveImplementationDefaults(input: ImplementationDefaultsInput): ResolvedImplementationDefaults {
  const unavailable: ImplementationModelOverride[] = [];
  const context = input.defaultContext ?? "keep";
  const mapped = input.planModel ? input.modelMap?.[formatModelKey(input.planModel)] : undefined;
  if (mapped) {
    const available = findAvailableImplementationModel(input.available, mapped);
    if (available) {
      const thinkingLevel = mapped.thinkingLevel ?? input.defaultThinkingLevel;
      return {
        ...(sameModel(mapped, input.sessionModel)
          ? {}
          : { model: { provider: mapped.provider, modelId: mapped.modelId } }),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        context,
        modelSource: "map",
        unavailable,
      };
    }
    unavailable.push({ provider: mapped.provider, modelId: mapped.modelId });
  }
  if (input.defaultModel) {
    if (findAvailableImplementationModel(input.available, input.defaultModel)) {
      return {
        ...(sameModel(input.defaultModel, input.sessionModel) ? {} : { model: { ...input.defaultModel } }),
        ...(input.defaultThinkingLevel ? { thinkingLevel: input.defaultThinkingLevel } : {}),
        context,
        modelSource: "default",
        unavailable,
      };
    }
    unavailable.push({ ...input.defaultModel });
  }
  // A plan picked from another model's candidate falls back to that model, not the session's.
  const planModel =
    input.planModel &&
    !sameModel(input.planModel, input.sessionModel) &&
    findAvailableImplementationModel(input.available, input.planModel)
      ? { provider: input.planModel.provider, modelId: input.planModel.modelId }
      : undefined;
  return {
    ...(planModel ? { model: planModel } : {}),
    ...(input.defaultThinkingLevel ? { thinkingLevel: input.defaultThinkingLevel } : {}),
    context,
    modelSource: "plan",
    unavailable,
  };
}
