import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { groupState, leaves, type ToolNode, toggle } from "./tool-tree.js";

export type ToolTreeResult = { kind: "start"; timeLimitMinutes: number } | { kind: "back" } | { kind: "cancel" };

export interface ToolTreeViewOptions {
  title: string;
  lines: readonly string[];
  roots: ToolNode[];
  startLabel: string;
  timeLimitMinutes: number;
  timeLimitChoices: readonly number[];
  rows(): number;
  requestRender(): void;
  onDone(result: ToolTreeResult): void;
}

type Row = { kind: "start" } | { kind: "time" } | { kind: "node"; node: ToolNode; depth: number };

/**
 * Tool picker as a tree: groups (toolsets, MCP servers) toggle every tool inside them and show a
 * partial mark when only some are selected; each leaf shows Jev's probability when available.
 */
export class ToolTreeView implements Component {
  private cursor = 0;
  private scroll = 0;
  private timeLimit: number;
  private readonly expanded = new Set<string>();

  constructor(
    private readonly theme: Theme,
    private readonly options: ToolTreeViewOptions,
  ) {
    this.timeLimit = options.timeLimitMinutes;
    // Toolsets start open; MCP servers start closed so a long catalog stays scannable.
    for (const root of options.roots) if (root.children) this.expanded.add(root.id);
  }

  invalidate() {}

  private visibleRows(): Row[] {
    const rows: Row[] = [{ kind: "start" }, { kind: "time" }];
    const visit = (node: ToolNode, depth: number) => {
      rows.push({ kind: "node", node, depth });
      if (node.children && this.expanded.has(node.id)) for (const child of node.children) visit(child, depth + 1);
    };
    for (const root of this.options.roots) visit(root, 0);
    return rows;
  }

  handleInput(data: string) {
    const rows = this.visibleRows();
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const row = rows[this.cursor];
    if (is("ctrl+c")) this.options.onDone({ kind: "cancel" });
    else if (is("escape")) this.options.onDone({ kind: "back" });
    else if (is("up", "k")) this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (is("down", "j")) this.cursor = (this.cursor + 1) % rows.length;
    else if (is("pageUp")) this.cursor = Math.max(0, this.cursor - 10);
    else if (is("pageDown")) this.cursor = Math.min(rows.length - 1, this.cursor + 10);
    else if (is("home", "g")) this.cursor = 0;
    else if (is("end", "shift+g")) this.cursor = rows.length - 1;
    else if (is("a")) for (const leaf of leaves(this.options.roots)) leaf.selected = true;
    else if (is("n")) for (const leaf of leaves(this.options.roots)) leaf.selected = false;
    else if (row?.kind === "start" && is("enter", "space")) {
      this.options.onDone({ kind: "start", timeLimitMinutes: this.timeLimit });
      return;
    } else if (row?.kind === "time" && is("right", "l", "enter", "space")) this.stepTime(1);
    else if (row?.kind === "time" && is("left", "h")) this.stepTime(-1);
    else if (row?.kind === "node" && is("space", "enter")) toggle(row.node);
    else if (row?.kind === "node" && is("right", "l")) {
      if (row.node.children) this.expanded.add(row.node.id);
    } else if (row?.kind === "node" && is("left", "h")) {
      if (row.node.children && this.expanded.has(row.node.id)) this.expanded.delete(row.node.id);
      else {
        // Jump to the parent group.
        for (let index = this.cursor - 1; index >= 0; index -= 1) {
          const candidate = rows[index];
          if (candidate?.kind === "node" && candidate.depth < row.depth) {
            this.cursor = index;
            break;
          }
        }
      }
    } else return;
    this.options.requestRender();
  }

  private stepTime(direction: 1 | -1) {
    const choices = this.options.timeLimitChoices;
    const index = choices.indexOf(this.timeLimit);
    const next = choices[Math.min(choices.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))];
    if (next !== undefined) this.timeLimit = next;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const rows = this.visibleRows();
    if (this.cursor >= rows.length) this.cursor = rows.length - 1;
    const header = [
      theme.fg("borderMuted", "─".repeat(width)),
      truncateToWidth(theme.bold(this.options.title), width),
      ...this.options.lines.map((line) => truncateToWidth(theme.fg("muted", line), width)),
      "",
    ];
    const footer = [
      theme.fg("borderMuted", "─".repeat(width)),
      truncateToWidth(
        theme.fg(
          "dim",
          "↑↓ move · space toggle · →/← open/close · a all · n none · Enter on Start runs · Esc back · Ctrl+C cancel",
        ),
        width,
      ),
    ];
    const height = Math.max(6, this.options.rows() - header.length - footer.length);
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1;
    const labelWidth = Math.min(
      44,
      Math.max(12, ...rows.map((row) => (row.kind === "node" ? row.depth * 2 + 6 + visibleWidth(row.node.label) : 0))),
    );
    const body = rows.slice(this.scroll, this.scroll + height).map((row, offset) => {
      const selected = this.scroll + offset === this.cursor;
      const pointer = selected ? theme.fg("accent", "›") : " ";
      let line: string;
      if (row.kind === "start") {
        const count = leaves(this.options.roots).filter((leaf) => leaf.selected).length;
        line = `${pointer} ${theme.bold(`▶ ${this.options.startLabel}`)}${theme.fg("dim", ` · ${count} tools selected`)}`;
      } else if (row.kind === "time") {
        line = `${pointer} Time limit  ${theme.fg("accent", `‹ ${this.timeLimit} min ›`)}${theme.fg("dim", "  planners are asked to wrap up at 80%")}`;
      } else {
        const node = row.node;
        const state = groupState(node);
        const box = state === "all" ? "[x]" : state === "some" ? "[-]" : "[ ]";
        const arrow = node.children ? (this.expanded.has(node.id) ? "▾ " : "▸ ") : "  ";
        const indent = "  ".repeat(row.depth);
        const counts = node.children
          ? `${leaves([node]).filter((leaf) => leaf.selected).length}/${leaves([node]).length}`
          : "";
        const jev = node.jev !== undefined ? `Jev ${Math.round(node.jev * 100)}%`.padStart(8) : "";
        const label = padVisible(`${indent}${arrow}${box} ${node.label}`, labelWidth);
        const extra = node.children ? counts : jev;
        const detail = node.children ? "" : node.description.replace(/^[^:]+: /u, "");
        line = `${pointer} ${selected ? theme.fg("accent", label) : label} ${theme.fg(node.jev !== undefined && node.jev >= 0.5 ? "success" : "muted", extra.padStart(8))}  ${theme.fg("dim", detail)}`;
      }
      return truncateToWidth(line, width);
    });
    const scrollInfo =
      rows.length > height
        ? [theme.fg("dim", `  ${this.scroll + 1}-${Math.min(rows.length, this.scroll + height)} of ${rows.length}`)]
        : [];
    return [...header, ...body, ...scrollInfo, ...footer];
  }
}

function padVisible(text: string, width: number) {
  const visible = visibleWidth(text);
  return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}
