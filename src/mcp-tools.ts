import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One MCP server and the tools its cached metadata lists. */
export interface McpServerCatalog {
  name: string;
  /** Tools from the adapter's metadata cache; empty when the server was never connected. */
  tools: Array<{ name: string; description: string }>;
  /** False when no cached tool metadata exists yet. */
  known: boolean;
}

/**
 * Read the MCP servers pi-mcp-adapter would load for `cwd` (its config files, in precedence order,
 * minus disabled servers) and their tools from the adapter's metadata cache. Never throws.
 */
export function readMcpCatalog(cwd: string, agentDir: string, home = homedir()): McpServerCatalog[] {
  const sources = [
    join(home, ".config", "mcp", "mcp.json"),
    join(home, ".agents", "mcp.json"),
    join(home, ".agents", "mcp", "mcp.json"),
    join(agentDir, "mcp.json"),
    join(cwd, ".mcp.json"),
    join(cwd, ".pi", "mcp.json"),
  ];
  const servers = new Map<string, { disabled: boolean }>();
  for (const source of sources) {
    const config = readJson(source);
    const entries = isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers : undefined;
    if (!entries) continue;
    for (const [name, definition] of Object.entries(entries)) {
      const previous = servers.get(name);
      const disabled =
        isRecord(definition) && typeof definition.disabled === "boolean" ? definition.disabled : undefined;
      servers.set(name, { disabled: disabled ?? previous?.disabled ?? false });
    }
  }
  const cache = readJson(join(agentDir, "mcp-cache.json"));
  const cached = isRecord(cache) && isRecord(cache.servers) ? cache.servers : {};
  return [...servers]
    .filter(([, server]) => !server.disabled)
    .map(([name]) => {
      const entry = cached[name];
      const tools =
        isRecord(entry) && Array.isArray(entry.tools)
          ? entry.tools.flatMap((tool) =>
              isRecord(tool) && typeof tool.name === "string"
                ? [{ name: tool.name, description: typeof tool.description === "string" ? tool.description : "" }]
                : [],
            )
          : [];
      return { name, tools, known: tools.length > 0 };
    });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

// --- Guard -------------------------------------------------------------------------------------

const BLOCKED_ACTIONS = new Set(["install", "auth-start", "auth-complete"]);

function sanitizeServer(name: string, keepDash: boolean) {
  const valid = keepDash ? /^[A-Za-z0-9_-]$/u : /^[A-Za-z0-9]$/u;
  return Array.from(name, (char) => (valid.test(char) ? char : `_${char.codePointAt(0)?.toString(16)}_`)).join("");
}

/** Every prefix pi-mcp-adapter may put before a server's tool names, across its prefix modes. */
export function serverPrefixes(server: string): string[] {
  const short = server.replace(/-?mcp$/iu, "");
  return [
    ...new Set(
      [
        sanitizeServer(server, true),
        sanitizeServer(server, false),
        server.replace(/[^A-Za-z0-9_]/gu, "_"),
        sanitizeServer(short, true) || "mcp",
        sanitizeServer(short, false) || "mcp",
        `mcp__${sanitizeServer(server, true)}`,
        `mcp__${sanitizeServer(server, false)}`,
      ].filter(Boolean),
    ),
  ];
}

/** Names under which `mcp({ tool })` may address a server's tool. */
export function toolNameCandidates(server: string, tool: string): Set<string> {
  const variants = [tool, tool.replace(/\./gu, "_"), tool.replace(/[.-]/gu, "_")];
  const names = new Set<string>(variants);
  for (const prefix of serverPrefixes(server)) {
    for (const variant of variants) names.add(variant.startsWith(`${prefix}_`) ? variant : `${prefix}_${variant}`);
  }
  return names;
}

export type McpGuardVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Decide whether an `mcp` gateway call stays within the allowlist (`server/tool` or `server/*`).
 * Searching, describing, listing, connecting, and status stay allowed so planners can discover
 * what they may call; installing servers and starting authentication never are.
 */
export function checkMcpCall(input: unknown, allow: readonly string[]): McpGuardVerdict {
  if (!isRecord(input)) return { allowed: true };
  if (typeof input.action === "string" && BLOCKED_ACTIONS.has(input.action)) {
    return { allowed: false, reason: `mcp action "${input.action}" is not available while planning.` };
  }
  if (typeof input.tool !== "string") return { allowed: true };
  const called = input.tool;
  const server = typeof input.server === "string" ? input.server : undefined;
  for (const entry of allow) {
    const slash = entry.indexOf("/");
    if (slash <= 0) continue;
    const allowedServer = entry.slice(0, slash);
    const allowedTool = entry.slice(slash + 1);
    if (server !== undefined && server !== allowedServer) continue;
    if (allowedTool === "*") {
      if (server === allowedServer) return { allowed: true };
      if (serverPrefixes(allowedServer).some((prefix) => called.startsWith(`${prefix}_`))) return { allowed: true };
      continue;
    }
    if (toolNameCandidates(allowedServer, allowedTool).has(called)) return { allowed: true };
  }
  const listed = allow.length > 0 ? allow.join(", ") : "none";
  return {
    allowed: false,
    reason: `MCP tool "${called}" was not selected for this planning run. Allowed MCP tools: ${listed}.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
