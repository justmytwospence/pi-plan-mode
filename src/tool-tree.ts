import type { CommandGrant } from "./command-grants.js";
import type { JevToolPick, ToolCapability } from "./jev-tool-picker.js";
import { MCP_GATEWAY_TOOL, type McpServerCatalog } from "./mcp-tools.js";
import type { PlannerToolset, ToolSelection } from "./planners.js";

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
  /** Shown instead of the description when the row is highlighted. */
  detail?: string;
  /** Leaves only: Jev scores it, but its selection stays as you (or your settings) set it. */
  jevLocked?: boolean;
  /** Leaves only: listed in `alwaysOffer`, so it starts selected and Jev leaves it on. */
  always?: boolean;
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
  /** Extra commands bash may run when granted; they join Shell as its own rows. */
  grants?: Readonly<Record<string, CommandGrant>>;
}

/**
 * Shell and Subagents are leaves; each ordinary toolset groups its tools; an MCP toolset groups
 * servers, and each server groups its tools (or is itself a leaf while it is not connected).
 */
export function buildToolTree(input: BuildToolTreeInput): ToolNode[] {
  const grants = Object.entries(input.grants ?? {});
  const roots: ToolNode[] =
    grants.length === 0
      ? [{ id: "shell", label: "Shell", description: SHELL_DESCRIPTION, selected: true, jevLocked: true }]
      : [
          {
            id: "shell-group",
            label: "Shell",
            description: "Commands planners may run with bash (a granted command also turns on the read-only ones)",
            children: [
              {
                id: "shell",
                label: "Read-only commands",
                description: SHELL_DESCRIPTION,
                selected: true,
                // Read-only shell is how planners inspect a repository; Jev decides about everything else.
                jevLocked: true,
              },
              ...grants.map(([id, grant]) => ({
                id: `grant:${id}`,
                label: grant.label,
                description: grant.description ?? `Run ${grant.commands.join(", ")}`,
                detail: `${grant.description ?? grant.label} Allows: ${grant.commands.join(", ")}.`,
                selected: grant.enabled,
              })),
            ],
          },
        ];
  if (input.scoutTargets.length > 0) {
    roots.push({
      id: "subagents",
      label: "Subagents",
      description: SUBAGENT_DESCRIPTION,
      selected: true,
    });
  }
  for (const [id, toolset] of Object.entries(input.toolsets)) {
    if (toolset.mcp) {
      const servers = mcpServerNodes(input.mcpCatalog, toolset.enabled);
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

function mcpServerNodes(catalog: readonly McpServerCatalog[], selected: boolean): ToolNode[] {
  return catalog.map<ToolNode>((server) =>
    server.known
      ? {
          id: `mcp:${server.name}`,
          label: server.name,
          description: `MCP server ${server.name}`,
          children: server.tools.map((tool) => ({
            id: `mcp:${server.name}/${tool.name}`,
            label: stripServerPrefix(tool.name, server.name),
            description: `${server.name}: ${oneLine(tool.description) || tool.name}${tool.readOnly ? " (read-only)" : ""}`,
            selected,
          })),
        }
      : {
          id: `mcp:${server.name}`,
          label: `${server.name} (not connected; allows the whole server)`,
          description: `MCP server ${server.name}; its tools are unknown until it connects (see /mcp).`,
          selected,
        },
  );
}

/** A Pi tool Plan mode may allow in this session. */
export interface SessionTool {
  name: string;
  description?: string;
  builtin: boolean;
}

export interface BuildSessionToolTreeInput {
  /** Active tools the Plan policy can allow, in display order. */
  tools: readonly SessionTool[];
  /** Tools the Plan policy selects when nothing else picks (settings or your last choice). */
  defaults: ReadonlySet<string>;
  toolsets: Readonly<Record<string, PlannerToolset>>;
  mcpCatalog: readonly McpServerCatalog[];
  grants?: Readonly<Record<string, CommandGrant>>;
}

/**
 * The tool tree for Plan mode in this session, laid out like the planners' tree: Shell (with its
 * command grants), each planner toolset whose tools are active here, the MCP servers when the `codemode`
 * tool is active, then every other tool. Leaves are `tool:<name>`, `grant:<id>`, or MCP tools.
 * Jev scores every tool, but only changes what you already opted into beyond the built-ins (your
 * extension tools, toolsets, MCP tools, and grants): it can narrow the policy but never widens it to
 * a tool you did not choose, and never takes away the built-ins Plan mode inspects the repository with.
 */
export function buildSessionToolTree(input: BuildSessionToolTreeInput): ToolNode[] {
  const available = new Map(input.tools.map((tool) => [tool.name, tool]));
  const covered = new Set<string>();
  const roots: ToolNode[] = [];
  const toolLeaf = (name: string, label = name, description?: string): ToolNode => {
    covered.add(name);
    const tool = available.get(name);
    return {
      id: `tool:${name}`,
      label,
      description: description ?? (oneLine(tool?.description ?? "") || name),
      selected: input.defaults.has(name),
      // Built-ins (files and the read-only shell) are how Plan mode inspects the repository; Jev
      // decides about extension tools, MCP tools, and grants.
      ...(tool?.builtin ? { jevLocked: true } : {}),
    };
  };
  if (available.has("bash")) {
    const grants = Object.entries(input.grants ?? {});
    const shell = toolLeaf("bash", grants.length > 0 ? "Read-only commands" : "Shell", SHELL_DESCRIPTION);
    roots.push(
      grants.length === 0
        ? shell
        : {
            id: "shell-group",
            label: "Shell",
            description: "Commands Plan mode may run with bash",
            children: [
              shell,
              ...grants.map(([id, grant]) => ({
                id: `grant:${id}`,
                label: grant.label,
                description: grant.description ?? `Run ${grant.commands.join(", ")}`,
                detail: `${grant.description ?? grant.label} Allows: ${grant.commands.join(", ")}.`,
                selected: grant.planMode === true,
              })),
            ],
          },
    );
  }
  for (const [id, toolset] of Object.entries(input.toolsets)) {
    if (toolset.mcp) {
      if (!available.has(MCP_GATEWAY_TOOL) || covered.has(MCP_GATEWAY_TOOL)) continue;
      const servers = mcpServerNodes(input.mcpCatalog, input.defaults.has(MCP_GATEWAY_TOOL));
      if (servers.length === 0) continue;
      covered.add(MCP_GATEWAY_TOOL);
      roots.push({
        id: `toolset:${id}`,
        label: toolset.label,
        description: toolset.description ?? id,
        children: servers,
      });
      continue;
    }
    const tools = toolset.tools.filter((tool) => available.has(tool) && !covered.has(tool));
    if (tools.length === 0) continue;
    roots.push({
      id: `toolset:${id}`,
      label: toolset.label,
      description: toolset.description ?? toolset.label,
      children: tools.map((tool) => toolLeaf(tool, tool, toolset.toolDescriptions?.[tool])),
    });
  }
  const others = input.tools
    .filter((tool) => !covered.has(tool.name))
    .map((tool) => {
      const leaf = toolLeaf(tool.name);
      // An extension tool you have not opted into stays yours to enable.
      return !tool.builtin && !input.defaults.has(tool.name) ? { ...leaf, jevLocked: true } : leaf;
    });
  if (others.length > 0) {
    roots.push({
      id: "other-tools",
      label: "Other tools",
      description: "Pi tools outside the planner toolsets. Extension tools run at your own risk.",
      children: others,
    });
  }
  return roots;
}

/** What a session tool tree allows. */
export interface SessionToolChoice {
  /** Pi tools the Plan policy allows. */
  names: string[];
  /** MCP tools codemode scripts may call; undefined when every listed tool is selected. */
  mcpAllow?: string[];
  /** Command grants that are on. */
  grants: string[];
  /** Selected leaf ids, to reopen the tree as it was. */
  selected: string[];
}

export function sessionToolChoice(nodes: readonly ToolNode[]): SessionToolChoice {
  const all = leaves(nodes);
  const names = all.filter((leaf) => leaf.selected && leaf.id.startsWith("tool:")).map((leaf) => leaf.id.slice(5));
  const mcpLeaves = all.filter((leaf) => leaf.id.startsWith("mcp:"));
  const selection = treeToSelection(nodes);
  const everyMcp = mcpLeaves.every((leaf) => leaf.selected);
  if (selection.mcp.length > 0) names.push(MCP_GATEWAY_TOOL);
  // A granted command runs through bash, so it turns on the read-only commands too.
  if ((selection.grants ?? []).length > 0 && all.some((leaf) => leaf.id === "tool:bash") && !names.includes("bash")) {
    names.push("bash");
  }
  return {
    names,
    ...(selection.mcp.length > 0 && !everyMcp ? { mcpAllow: selection.mcp } : {}),
    grants: selection.grants ?? [],
    selected: all.filter((leaf) => leaf.selected).map((leaf) => leaf.id),
  };
}

/** Restore a saved selection (and Jev's scores) onto a freshly built tree. */
export function restoreTreeSelection(
  nodes: readonly ToolNode[],
  selected: readonly string[] | undefined,
  scores: Readonly<Record<string, number>> | undefined,
) {
  const chosen = selected ? new Set(selected) : undefined;
  for (const leaf of leaves(nodes)) {
    if (chosen) leaf.selected = chosen.has(leaf.id);
    const score = scores?.[leaf.id];
    if (score !== undefined) leaf.jev = score;
  }
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

/**
 * The names `alwaysOffer` may use for a leaf: its group (toolset, grant, MCP server, Other tool),
 * its own name, and `group/tool`.
 */
export function offerNames(leaf: ToolNode): string[] {
  const colon = leaf.id.indexOf(":");
  const path = colon >= 0 ? leaf.id.slice(colon + 1) : leaf.id;
  const [group = path, tool] = splitOnce(path, "/");
  return [...new Set([path, group, ...(tool ? [tool, `${group}/${leaf.label}`] : []), leaf.label].filter(Boolean))];
}

/** Select the leaves `alwaysOffer` names and lock them against Jev's deselection. */
export function applyAlwaysOffer(nodes: readonly ToolNode[], alwaysOffer: readonly string[] | undefined) {
  const wanted = new Set(alwaysOffer ?? []);
  if (wanted.size === 0) return;
  for (const leaf of leaves(nodes)) {
    if (!offerNames(leaf).some((name) => wanted.has(name))) continue;
    leaf.selected = true;
    leaf.jevLocked = true;
    leaf.always = true;
  }
}

/** Show Jev's scores and, unless the user already chose, take its selection. */
export function applyJevPick(nodes: readonly ToolNode[], pick: JevToolPick, keepSelection = false) {
  if (pick.kind !== "jev") return;
  for (const leaf of leaves(nodes)) {
    const probability = pick.probabilities[leaf.id];
    if (probability === undefined) continue;
    leaf.jev = probability;
    if (!keepSelection && !leaf.jevLocked) leaf.selected = pick.selected[leaf.id] === true;
  }
}

export function treeToSelection(nodes: readonly ToolNode[]): ToolSelection {
  const selection: ToolSelection = { shell: false, subagents: false, toolsetTools: {}, mcp: [], grants: [] };
  const visit = (node: ToolNode) => {
    if (node.id === "shell") selection.shell = node.selected === true;
    else if (node.id.startsWith("grant:")) {
      if (node.selected) selection.grants?.push(node.id.slice("grant:".length));
    } else if (node.id === "subagents") selection.subagents = node.selected === true;
    else if (node.id.startsWith("mcp:")) {
      const server = node.id.slice("mcp:".length);
      if (!node.children) {
        // A server that has not connected is a single leaf that allows the whole server.
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

/** `paperless__bulk_edit` reads better as `bulk_edit` under the paperless group. */
function stripServerPrefix(tool: string, server: string) {
  for (const prefix of [
    `${server}__`,
    `${server}_`,
    `${server.replace(/-/gu, "_")}__`,
    `${server.replace(/-/gu, "_")}_`,
  ]) {
    if (tool.startsWith(prefix) && tool.length > prefix.length) return tool.slice(prefix.length);
  }
  return tool;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
}

function oneLine(text: string) {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
