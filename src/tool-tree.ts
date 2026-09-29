import type { JevToolPick, ToolCapability } from "./jev-tool-picker.js";
import type { McpServerCatalog } from "./mcp-tools.js";
import type { PlannerToolset, ToolSelection } from "./multi-plan.js";

/** A row in the planner tool tree: a leaf tool, or a group whose state follows its children. */
export interface ToolNode {
  id: string;
  label: string;
  /** Plain-language description shown on the row and read by Jev (leaves). */
  description: string;
  children?: ToolNode[];
  /** Leaves only. */
  selected?: boolean;
  /** Jev's probability that planners benefit from this leaf. */
  jev?: number;
}

export type GroupState = "all" | "some" | "none";

const SHELL_DESCRIPTION =
  "Read-only shell commands inside the repository: git history, diffs and blame, ripgrep searches, listing files, reading configs and lockfiles.";
const SUBAGENT_DESCRIPTION =
  "Parallel read-only helper agents that each investigate one part of a large codebase or one independent question and report back.";

export interface BuildToolTreeInput {
  toolsets: Readonly<Record<string, PlannerToolset>>;
  mcpCatalog: readonly McpServerCatalog[];
  /** Scout model labels; the Subagents row appears only when there are any. */
  scoutTargets: readonly string[];
}

/**
 * Shell and Subagents are leaves; each ordinary toolset groups its tools; an MCP toolset groups
 * servers, and each server groups its cached tools (or is itself a leaf when no tools are cached).
 */
export function buildToolTree(input: BuildToolTreeInput): ToolNode[] {
  const roots: ToolNode[] = [{ id: "shell", label: "Shell", description: SHELL_DESCRIPTION, selected: true }];
  if (input.scoutTargets.length > 0) {
    roots.push({
      id: "subagents",
      label: `Subagents (${input.scoutTargets.join(", ")})`,
      description: SUBAGENT_DESCRIPTION,
      selected: true,
    });
  }
  for (const [id, toolset] of Object.entries(input.toolsets)) {
    if (toolset.mcp) {
      const servers = input.mcpCatalog.map<ToolNode>((server) =>
        server.known
          ? {
              id: `mcp:${server.name}`,
              label: server.name,
              description: `MCP server ${server.name}`,
              children: server.tools.map((tool) => ({
                id: `mcp:${server.name}/${tool.name}`,
                label: tool.name,
                description: `${server.name}: ${oneLine(tool.description) || tool.name}`,
                selected: toolset.enabled,
              })),
            }
          : {
              id: `mcp:${server.name}`,
              label: `${server.name} (tools not cached yet; allows the whole server)`,
              description: `MCP server ${server.name}; its tools are unknown until it has been connected once.`,
              selected: toolset.enabled,
            },
      );
      if (servers.length > 0) {
        roots.push({
          id: `toolset:${id}`,
          label: toolset.label,
          description: toolset.description ?? id,
          children: servers,
        });
      }
      continue;
    }
    roots.push({
      id: `toolset:${id}`,
      label: toolset.label,
      description: toolset.description ?? toolset.label,
      children: toolset.tools.map((tool) => ({
        id: `toolset:${id}/${tool}`,
        label: tool,
        description: toolset.toolDescriptions?.[tool] ?? `${toolset.description ?? toolset.label} (tool ${tool})`,
        selected: toolset.enabled,
      })),
    });
  }
  return roots;
}

export function leaves(nodes: readonly ToolNode[]): ToolNode[] {
  return nodes.flatMap((node) => (node.children ? leaves(node.children) : [node]));
}

export function groupState(node: ToolNode): GroupState {
  const all = leaves([node]);
  const selected = all.filter((leaf) => leaf.selected).length;
  return selected === 0 ? "none" : selected === all.length ? "all" : "some";
}

/** Select or clear a leaf, or every leaf under a group. */
export function setSelected(node: ToolNode, selected: boolean) {
  for (const leaf of leaves([node])) leaf.selected = selected;
}

/** Toggle: a fully selected node clears; a partly or un-selected node selects everything. */
export function toggle(node: ToolNode) {
  setSelected(node, groupState(node) !== "all");
}

export function leafCapabilities(nodes: readonly ToolNode[]): ToolCapability[] {
  return leaves(nodes).map((leaf) => ({
    id: leaf.id,
    label: leaf.label,
    description: leaf.description,
    fallbackSelected: leaf.selected === true,
  }));
}

/** Use Jev's picks as the defaults and keep its probabilities for display. */
export function applyJevPick(nodes: readonly ToolNode[], pick: JevToolPick) {
  if (pick.kind !== "jev") return;
  for (const leaf of leaves(nodes)) {
    const probability = pick.probabilities[leaf.id];
    if (probability === undefined) continue;
    leaf.jev = probability;
    leaf.selected = pick.selected[leaf.id] === true;
  }
}

export function treeToSelection(nodes: readonly ToolNode[]): ToolSelection {
  const selection: ToolSelection = { shell: false, subagents: false, toolsetTools: {}, mcp: [] };
  const visit = (node: ToolNode) => {
    if (node.id === "shell") selection.shell = node.selected === true;
    else if (node.id === "subagents") selection.subagents = node.selected === true;
    else if (node.id.startsWith("mcp:")) {
      const server = node.id.slice("mcp:".length);
      if (!node.children) {
        // A server whose tools are not cached is a single leaf that allows the whole server.
        if (node.selected) selection.mcp.push(`${server}/*`);
        return;
      }
      const state = groupState(node);
      if (state === "all") selection.mcp.push(`${server}/*`);
      else if (state === "some") {
        for (const leaf of node.children) if (leaf.selected) selection.mcp.push(leaf.id.slice("mcp:".length));
      }
      return;
    } else if (node.id.startsWith("toolset:") && node.id.includes("/")) {
      const [toolsetId, tool] = splitOnce(node.id.slice("toolset:".length), "/");
      if (node.selected && toolsetId && tool) {
        const chosen = selection.toolsetTools[toolsetId] ?? [];
        chosen.push(tool);
        selection.toolsetTools[toolsetId] = chosen;
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return selection;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
}

function oneLine(text: string) {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
