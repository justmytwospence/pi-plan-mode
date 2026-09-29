import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MODEL_SPEC_THINKING_LEVELS,
  type ModelSpec,
  type ModelSpecThinkingLevel,
  parseModelSpec,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";

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

function formatContext(tokens: number) {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Math.round(tokens / 1_000)}k`;
}

function trimCost(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "");
}

function safeText(value: string) {
  const printable = [...stripVTControlCharacters(value)].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : char;
  });
  return printable.join("").replace(/\s+/gu, " ").trim();
}
