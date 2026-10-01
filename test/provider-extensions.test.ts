import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_PLANNER_ACCESS, SCOUT_EXTENSIONS_ENV } from "../src/multi-plan.js";
import { plannerArgs, plannerEnv } from "../src/planner-process.js";
import { extensionsForProvider, resolveProviderExtensions } from "../src/provider-extensions.js";
import { normalizePlanModeSettings } from "../src/settings.js";

const AUTH = "/pkgs/pi-anthropic-auth/src/index.ts";
const authCommand = {
  name: "anthropic-auth:status",
  source: "extension",
  sourceInfo: { path: AUTH },
};
const extensionArgs = (args: string[]) =>
  args.flatMap((arg, index) => (args[index - 1] === "--extension" ? [arg] : []));

test("the loaded Anthropic subscription extension is found from its command", () => {
  assert.deepEqual(resolveProviderExtensions([authCommand], undefined), { anthropic: [AUTH] });
  // Not loaded (no subscription extension installed): nothing to forward, Pi's own provider is used.
  assert.deepEqual(resolveProviderExtensions([{ name: "other", sourceInfo: { path: "/x.ts" } }], undefined), {});
  // A prompt template with the same name is not an extension.
  assert.deepEqual(
    resolveProviderExtensions([{ name: "anthropic-auth:status", source: "prompt", sourceInfo: { path: "/p.md" } }], {}),
    {},
  );
});

test("configured provider extensions replace detection per provider and expand paths", () => {
  const resolved = resolveProviderExtensions(
    [authCommand],
    { "anthropic-2": ["~/auth"], "openai-codex": ["~/codex", "~/codex"] },
    (path) => path.replace("~", "/home"),
  );
  assert.deepEqual(resolved, { anthropic: [AUTH], "anthropic-2": ["/home/auth"], "openai-codex": ["/home/codex"] });
  assert.deepEqual(resolveProviderExtensions([authCommand], { anthropic: [] }), { anthropic: [] });
  assert.deepEqual(extensionsForProvider(resolved, "anthropic", [AUTH]), []);
  assert.deepEqual(extensionsForProvider(resolved, "openai-codex"), ["/home/codex"]);
  assert.deepEqual(extensionsForProvider(resolved, undefined), []);
});

test("an Anthropic planner loads the subscription extension; other providers do not", () => {
  const providerExtensions = { anthropic: [AUTH] };
  const anthropic = plannerArgs({
    spec: { provider: "anthropic", modelId: "claude-fable-5-1", thinkingLevel: "xhigh" },
    extensionPath: "/ext/index.ts",
    loadUserExtensions: false,
    providerExtensions,
    access: { ...DEFAULT_PLANNER_ACCESS, extensions: ["/web"] },
  });
  assert.ok(anthropic.includes("--no-extensions"));
  assert.deepEqual(extensionArgs(anthropic), ["/ext/index.ts", "/web", AUTH]);

  const codex = plannerArgs({
    spec: { provider: "openai-codex", modelId: "gpt-6-astra" },
    extensionPath: "/ext/index.ts",
    loadUserExtensions: false,
    providerExtensions,
  });
  assert.deepEqual(extensionArgs(codex), ["/ext/index.ts"]);

  // With the user's extensions loaded the planner already has it.
  const ambient = plannerArgs({
    spec: { provider: "anthropic", modelId: "claude-fable-5-1" },
    extensionPath: "/ext/index.ts",
    loadUserExtensions: true,
    providerExtensions,
  });
  assert.deepEqual(extensionArgs(ambient), []);
});

test("scouts get their own provider's extension, whatever the planner runs on", () => {
  const providerExtensions = { anthropic: [AUTH] };
  const scoutExtensions = (env: NodeJS.ProcessEnv) => JSON.parse(env[SCOUT_EXTENSIONS_ENV] ?? "[]");
  const access = { ...DEFAULT_PLANNER_ACCESS, scoutExtensions: ["/web"] };
  assert.deepEqual(
    scoutExtensions(
      plannerEnv({ access, providerExtensions, scoutSpec: { provider: "anthropic", modelId: "claude-opus-5-5" } }),
    ),
    ["/web", AUTH],
  );
  assert.deepEqual(
    scoutExtensions(
      plannerEnv({ access, providerExtensions, scoutSpec: { provider: "openai-codex", modelId: "gpt-6.1-sol" } }),
    ),
    ["/web"],
  );
  assert.deepEqual(scoutExtensions(plannerEnv({ access, providerExtensions })), ["/web"]);
});

test("providerExtensions settings normalize and reject malformed entries", () => {
  assert.deepEqual(normalizePlanModeSettings({ providerExtensions: { anthropic: [" ~/a ", "~/a"], x: [] } }), {
    thinkingLevel: "inherit",
    providerExtensions: { anthropic: ["~/a"], x: [] },
  });
  for (const invalid of [
    { providerExtensions: [] },
    { providerExtensions: { anthropic: "~/a" } },
    { providerExtensions: { anthropic: [""] } },
    { providerExtensions: { anthropic: [3] } },
  ]) {
    assert.equal(normalizePlanModeSettings(invalid), undefined, JSON.stringify(invalid));
  }
});
