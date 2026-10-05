/**
 * Extensions a planner or scout loads because of the provider its model runs on.
 *
 * Planners and scouts start with `--no-extensions`, so an extension that changes how the parent
 * session talks to a provider is missing from them. The case that costs money: a Claude Pro/Max
 * subscription in Pi needs an extension such as pi-anthropic-auth to shape requests as Claude Code
 * usage. Without it, Anthropic bills the subprocess's requests to extra usage, per token, instead
 * of the subscription. Forwarding the extension the parent loaded keeps planners on the
 * subscription; when none is loaded (an API key, or no such extension installed), nothing is
 * forwarded and the subprocess uses Pi's own provider as before.
 */

/** Provider id to the extensions (paths or package directories) loaded with models on it. */
export type ProviderExtensions = Readonly<Record<string, readonly string[]>>;

/**
 * Known provider extensions, found in the parent session by a command each one registers: the
 * command's source is the extension entry point the parent loaded.
 */
export const KNOWN_PROVIDER_EXTENSIONS: ReadonlyArray<{ provider: string; command: string; name: string }> = [
  // Claude Pro/Max OAuth: shapes requests so the subscription, not extra usage, pays for them.
  { provider: "anthropic", command: "anthropic-auth:status", name: "pi-anthropic-auth" },
];

interface CommandLike {
  name: string;
  source?: string;
  sourceInfo?: { path?: string };
}

/**
 * The extensions planners and scouts load per provider: the configured `providerExtensions`
 * (an entry replaces detection for its provider, so `[]` turns forwarding off), else the known
 * provider extensions the parent session has loaded.
 */
export function resolveProviderExtensions(
  commands: readonly CommandLike[],
  configured: Readonly<Record<string, readonly string[]>> | undefined,
  resolvePath: (path: string) => string = (path) => path,
): ProviderExtensions {
  const result: Record<string, string[]> = {};
  for (const known of KNOWN_PROVIDER_EXTENSIONS) {
    const command = commands.find((item) => item.name === known.command && item.source !== "prompt");
    const path = command?.sourceInfo?.path;
    if (!path || path.startsWith("<")) continue;
    result[known.provider] = [...new Set([...(result[known.provider] ?? []), path])];
  }
  for (const [provider, paths] of Object.entries(configured ?? {})) {
    result[provider] = [...new Set(paths.map(resolvePath))];
  }
  return result;
}

/** The extensions a subprocess on `provider` loads, minus any it already loads. */
export function extensionsForProvider(
  providerExtensions: ProviderExtensions | undefined,
  provider: string | undefined,
  already: readonly string[] = [],
): string[] {
  if (!providerExtensions || !provider) return [];
  return (providerExtensions[provider] ?? []).filter((path) => !already.includes(path));
}
