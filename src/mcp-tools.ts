import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Pi's built-in MCP support registers every MCP tool as `mcp__<server>__<tool>` with `codemode`
 * exposure: the model never sees them directly and calls them from `codemode` scripts. So
 * `codemode` is the gateway Plan mode offers MCP servers through, and the MCP tools themselves are
 * gated one by one in `tool_call` (codemode's nested calls pass through it too).
 */
export const MCP_GATEWAY_TOOL = "codemode";

/** Extensions a planner or scout started with `--no-extensions` needs for MCP tools. */
export const MCP_BUILTIN_EXTENSIONS = ["builtin:mcp", "builtin:codemode"] as const;

/** One MCP server and the tools it offers in this session. */
export interface McpServerCatalog {
  /** Server name as used in allowlists (`server/tool`): letters, digits, and `_`. */
  name: string;
  tools: Array<{
    /** Tool name as used in allowlists: the Pi tool name without its `mcp__<server>__` prefix. */
    name: string;
    /** The Pi tool name (`mcp__<server>__<tool>`). */
    toolName: string;
    description: string;
    /** The server declares the tool read-only (MCP `readOnlyHint`). */
    readOnly?: boolean;
  }>;
  /** False when the server is configured but has not connected in this session. */
  known: boolean;
}

/** An allowlist server name: what Pi's MCP tool names use for the server. */
export function mcpServerId(name: string) {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

type McpToolLike = Pick<ToolInfo, "name"> & Partial<Pick<ToolInfo, "namespace" | "exposure">>;

/** The server and allowlist tool name of a Pi tool, or undefined when it is not an MCP tool. */
export function mcpToolIdentity(tool: McpToolLike | undefined): { server: string; tool: string } | undefined {
  const namespace = tool?.namespace?.name;
  if (!tool || !namespace?.startsWith("mcp__")) return undefined;
  const prefix = `${namespace}__`;
  return {
    server: mcpServerId(namespace.slice("mcp__".length)),
    tool: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
  };
}

/**
 * The MCP servers Plan mode can offer: every connected server's tools (from Pi's tool registry),
 * plus configured servers that have not connected yet, which are listed without tools.
 */
export function buildMcpCatalog(tools: readonly McpToolLike[], configured: readonly string[] = []): McpServerCatalog[] {
  const servers = new Map<string, McpServerCatalog>();
  for (const name of configured) {
    const id = mcpServerId(name);
    if (!servers.has(id)) servers.set(id, { name: id, tools: [], known: false });
  }
  for (const tool of tools) {
    if (tool.exposure === "hidden") continue;
    const identity = mcpToolIdentity(tool);
    if (!identity) continue;
    const server = servers.get(identity.server) ?? { name: identity.server, tools: [], known: true };
    server.known = true;
    const info = tool as Partial<ToolInfo>;
    server.tools.push({
      name: identity.tool,
      toolName: tool.name,
      description: typeof info.description === "string" ? info.description : "",
      ...(info.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
    });
    servers.set(identity.server, server);
  }
  return [...servers.values()];
}

/**
 * Enabled servers from Pi's `mcp.json` files: the user file, then the project file (which Pi reads
 * only for trusted projects; an untrusted project's servers are listed but never connect). Never
 * throws.
 */
export function readConfiguredMcpServers(cwd: string, agentDir: string): string[] {
  const enabled = new Map<string, boolean>();
  for (const source of [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
    const config = readJson(source);
    const entries = isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers : undefined;
    if (!entries) continue;
    for (const [name, definition] of Object.entries(entries)) {
      enabled.set(name, !(isRecord(definition) && definition.enabled === false));
    }
  }
  return [...enabled].filter(([, on]) => on).map(([name]) => name);
}

/**
 * The Pi tool names an allowlist (`server/tool` or `server/*`) selects from the catalog. Planners
 * and scouts are started with `--tools` naming exactly these, so no other MCP tool is registered in
 * them at all. Servers whose tools are unknown contribute nothing.
 */
export function mcpToolNames(catalog: readonly McpServerCatalog[], allow: readonly string[]): string[] {
  return catalog.flatMap((server) =>
    server.tools
      .filter((tool) => allowsMcpTool(allow, { server: server.name, tool: tool.name }))
      .map((tool) => tool.toolName),
  );
}

export function isMcpToolName(name: string) {
  return name.startsWith("mcp__");
}

function allowsMcpTool(allow: readonly string[], identity: { server: string; tool: string }) {
  return allow.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash <= 0) return false;
    const server = mcpServerId(entry.slice(0, slash));
    const tool = entry.slice(slash + 1);
    return server === identity.server && (tool === "*" || tool === identity.tool);
  });
}

// --- Guard -------------------------------------------------------------------------------------

export type McpGuardVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Decide whether a call to an MCP tool stays within the allowlist (`server/tool` or `server/*`).
 * Undefined allows every MCP tool.
 */
export function checkMcpTool(
  identity: { server: string; tool: string },
  allow: readonly string[] | undefined,
): McpGuardVerdict {
  if (!allow || allowsMcpTool(allow, identity)) return { allowed: true };
  const listed = allow.length > 0 ? allow.join(", ") : "none";
  return {
    allowed: false,
    reason: `MCP tool "${identity.server}/${identity.tool}" was not selected for this plan. Allowed MCP tools: ${listed}.`,
  };
}

/**
 * The MCP resource tools reach whichever server their `server` argument names; allow them for
 * servers the allowlist selects anything from. Listing every server at once needs no allowlist.
 */
export const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

export function checkMcpResourceCall(input: unknown, allow: readonly string[] | undefined): McpGuardVerdict {
  if (!allow) return { allowed: true };
  const server = isRecord(input) && typeof input.server === "string" ? mcpServerId(input.server) : undefined;
  const servers = new Set(allow.map((entry) => mcpServerId(entry.slice(0, Math.max(0, entry.indexOf("/"))))));
  if (server !== undefined && servers.has(server)) return { allowed: true };
  return {
    allowed: false,
    reason:
      server === undefined
        ? "Name the MCP server whose resources you want; this plan may only use these MCP servers: " +
          ([...servers].filter(Boolean).join(", ") || "none")
        : `MCP server "${server}" was not selected for this plan.`,
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
