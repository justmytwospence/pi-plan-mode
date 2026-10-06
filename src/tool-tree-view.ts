import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeyId,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { pageHeader } from "./app/frame.js";
import { groupState, leaves, type ToolNode, toggle } from "./tool-tree.js";
import { fieldLine, type Hint, hintLine, padLines, padVisible, rule, selectedRow, spinner } from "./ui-kit.js";

export type ToolTreeResult =
  | { kind: "start" /** You changed the selection yourself. */; touched: boolean }
  | { kind: "back" }
  | { kind: "cancel" };

/** Jev's preselection, arriving after the screen opens. */
export interface ToolPreselection {
  /** Resolves to a one-line summary and a function that applies the picks to the tree. */
  pending: Promise<{ message: string; apply(keepSelection: boolean): void }>;
}

export interface ToolTreeViewOptions {
  title: string;
  task?: string;
  /** Short lines under the task, e.g. the Jev summary when it is already known. */
  notes: readonly string[];
  roots: ToolNode[];
  /** What Enter does, asked as a question first: `Start planning with 1 planner`. */
  startLabel: string;
  preselection?: ToolPreselection;
  /** Next to the title; defaults to what planners may use. */
  purpose?: string;
  /** What Esc does, in the key hints (default "back to settings"). */
  backLabel?: string;
  rows(): number;
  requestRender(): void;
  onDone(result: ToolTreeResult): void;
}

type Row = { kind: "node"; node: ToolNode; depth: number };

/**
 * Step 2: which tools planners may use. Groups (toolsets, MCP servers) open and close with Tab (or → and ←), Space
 * selects or clears a tool or a whole group, and a partial mark shows a group where only some
 * tools are selected. The highlighted row is described at the bottom.
 */
export class ToolTreeView implements Component {
  /** Starts on the first tool, so Space works at once. */
  private cursor = 0;
  /** Enter asks before planning starts. */
  private confirming = false;
  private scroll = 0;
  private readonly expanded = new Set<string>();
  private jevStatus: { kind: "pending" } | { kind: "done"; message: string } | undefined;
  /** True once the user changed any selection; Jev never overrides that. */
  touched = false;
  private rowsTop = 0;
  private shownRows: Row[] = [];
  private closed = false;

  private finish(result: ToolTreeResult) {
    this.closed = true;
    this.options.onDone(result);
  }

  constructor(
    private readonly theme: Theme,
    private readonly options: ToolTreeViewOptions,
  ) {
    // Toolsets start open; MCP servers start closed so a long catalog stays scannable.
    for (const root of options.roots) if (root.children) this.expanded.add(root.id);
    if (options.preselection) {
      this.jevStatus = { kind: "pending" };
      options.preselection.pending.then(
        (result) => {
          // A closed screen leaves the picks for the next time the tools screen opens.
          if (this.closed) return;
          result.apply(this.touched);
          this.jevStatus = {
            kind: "done",
            message: this.touched ? `${result.message} Your own changes were kept.` : result.message,
          };
          options.requestRender();
        },
        () => {
          this.jevStatus = { kind: "done", message: "Jev could not pick tools; using the defaults from settings." };
          options.requestRender();
        },
      );
    }
  }

  invalidate() {}

  private visibleRows(): Row[] {
    const rows: Row[] = [];
    const visit = (node: ToolNode, depth: number) => {
      rows.push({ kind: "node", node, depth });
      if (node.children && this.expanded.has(node.id)) for (const child of node.children) visit(child, depth + 1);
    };
    for (const root of this.options.roots) visit(root, 0);
    return rows;
  }

  private change(node: ToolNode) {
    toggle(node);
    this.touched = true;
  }

  handleInput(data: string) {
    const rows = this.visibleRows();
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const row = rows[this.cursor];
    if (is("ctrl+c")) return this.finish({ kind: "cancel" });
    const dismissed = this.confirming;
    if (this.confirming) {
      this.confirming = false;
      if (is("enter", "y")) return this.start();
      if (is("escape", "n")) {
        this.options.requestRender();
        return;
      }
      // Any other key keeps editing and does what it normally does.
    }
    if (is("escape")) return this.finish({ kind: "back" });
    // Enter starts planning, after a confirmation.
    if (is("enter")) this.confirming = true;
    else if (is("up", "k", "ctrl+p", "ctrl+k")) this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (is("down", "j", "ctrl+n", "ctrl+j")) this.cursor = (this.cursor + 1) % rows.length;
    else if (is("ctrl+u")) this.cursor = Math.max(0, this.cursor - 10);
    else if (is("ctrl+d")) this.cursor = Math.min(rows.length - 1, this.cursor + 10);
    else if (is("home", "g")) this.cursor = 0;
    else if (is("end", "shift+g")) this.cursor = rows.length - 1;
    else if (is("a")) {
      for (const leaf of leaves(this.options.roots)) leaf.selected = true;
      this.touched = true;
    } else if (is("n")) {
      for (const leaf of leaves(this.options.roots)) leaf.selected = false;
      this.touched = true;
    } else if (row?.kind === "node" && is("space", "x")) this.change(row.node);
    else if (row?.kind === "node" && is("tab")) {
      // Open or close a group; on a tool, close the group it is in and move up to it.
      if (row.node.children) this.toggleExpanded(row.node.id);
      else {
        const parent = this.parentIndex(rows, this.cursor);
        const group = parent === undefined ? undefined : rows[parent];
        if (parent === undefined || group?.kind !== "node") return;
        this.expanded.delete(group.node.id);
        this.cursor = parent;
      }
    } else if (row?.kind === "node" && is("right", "l", "ctrl+l")) {
      // Open a group; on an open group, step into its first tool.
      if (!row.node.children) return;
      if (this.expanded.has(row.node.id)) this.cursor = Math.min(rows.length - 1, this.cursor + 1);
      else this.expanded.add(row.node.id);
    } else if (row?.kind === "node" && is("left", "h", "ctrl+h")) {
      if (row.node.children && this.expanded.has(row.node.id)) this.expanded.delete(row.node.id);
      else this.cursor = this.parentIndex(rows, this.cursor) ?? this.cursor;
    } else if (!this.confirming && !dismissed) return;
    this.options.requestRender();
  }

  /** The row of the group that contains the node at `index`, if it is inside one. */
  private parentIndex(rows: Row[], index: number) {
    const row = rows[index];
    if (row?.kind !== "node") return undefined;
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const above = rows[candidate];
      if (above?.kind === "node" && above.depth < row.depth) return candidate;
    }
    return undefined;
  }

  private start() {
    this.finish({ kind: "start", touched: this.touched });
  }

  /** `3 of 7 tools` */
  private summary(selected: number, total: number) {
    return `${selected} of ${total} tools`;
  }

  private toggleExpanded(id: string) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const rows = this.visibleRows();
    if (event.type === "wheel") {
      const delta = Math.sign(event.wheelDelta ?? 0);
      if (delta !== 0) this.cursor = Math.min(rows.length - 1, Math.max(0, this.cursor + delta));
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left")
      return event.type === "press" ? { handled: true } : undefined;
    const index = event.y - this.rowsTop;
    const row = this.shownRows[index];
    if (!row) return { handled: true };
    this.cursor = this.scroll + index;
    {
      // Clicking the checkbox selects or clears; clicking elsewhere on a group opens or closes it.
      const boxStart = 3 + row.depth * 2 + 2;
      const onBox = event.x >= boxStart && event.x < boxStart + 3;
      if (row.node.children && !onBox) this.toggleExpanded(row.node.id);
      else this.change(row.node);
    }
    this.options.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    const theme = this.theme;
    const rows = this.visibleRows();
    if (this.cursor >= rows.length) this.cursor = rows.length - 1;
    const height = Math.max(14, this.options.rows());
    const all = leaves(this.options.roots);
    const selectedCount = all.filter((leaf) => leaf.selected).length;
    const jev =
      this.jevStatus?.kind === "pending"
        ? `${theme.fg("accent", spinner())} ${theme.fg("muted", "Jev is picking the tools this task needs…")}`
        : this.jevStatus?.kind === "done"
          ? theme.fg("muted", this.jevStatus.message)
          : undefined;
    const header = [
      ...pageHeader(
        theme,
        width,
        this.options.title,
        this.options.purpose ?? "what planners and their subagents may use",
        "Tools",
      ),
      ...(this.options.task ? [fieldLine(theme, width, "Task", this.options.task)] : []),
      ...(jev ? [fieldLine(theme, width, "Jev", jev)] : []),
      ...this.options.notes.map((note) => fieldLine(theme, width, "", theme.fg("muted", note))),
      "",
    ];
    const current = rows[this.cursor];
    const detail = this.confirming ? this.startDetail(width) : this.detail(current, width);
    const footer = [
      rule(theme, width),
      ...padLines(detail, 3),
      rule(theme, width),
      this.confirming
        ? `${truncateToWidth(
            ` ${theme.fg("warning", theme.bold(`${this.options.startLabel}?`))}  ${theme.fg("muted", this.summary(selectedCount, all.length))}`,
            Math.max(10, width - 32),
            "…",
          )}   ${hintLine(theme, 30, [
            { key: "⏎", label: "start", primary: true },
            { key: "esc", label: "keep editing" },
          ]).trimStart()}`
        : hintLine(theme, width, this.hints(current)),
    ];
    // Only as tall as the tree needs, up to the terminal height.
    const available = Math.max(4, height - header.length - footer.length);
    const listHeight = rows.length > available ? available - 1 : rows.length;
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + listHeight) this.scroll = this.cursor - listHeight + 1;
    const labelWidth = Math.min(
      Math.max(30, Math.floor(width * 0.5)),
      Math.max(20, ...rows.map((row) => (row.kind === "node" ? row.depth * 2 + 8 + visibleWidth(row.node.label) : 0))),
    );
    this.rowsTop = header.length;
    this.shownRows = rows.slice(this.scroll, this.scroll + listHeight);
    const body = this.shownRows.map((row, offset) => {
      const isCursor = this.scroll + offset === this.cursor;
      let line: string;
      {
        const node = row.node;
        const state = groupState(node);
        const box =
          state === "all"
            ? theme.fg("success", "[x]")
            : state === "some"
              ? theme.fg("warning", "[-]")
              : theme.fg("dim", "[ ]");
        const arrow = node.children ? theme.fg("accent", this.expanded.has(node.id) ? "▾ " : "▸ ") : "  ";
        const indent = "  ".repeat(row.depth);
        const name = node.children ? theme.bold(node.label) : node.label;
        const label = padVisible(`${indent}${arrow}${box} ${name}`, labelWidth);
        const extra = node.children
          ? theme.fg("dim", `${leaves([node]).filter((leaf) => leaf.selected).length}/${leaves([node]).length}`)
          : [
              ...(node.always ? [theme.fg("accent", "always")] : []),
              ...(node.jev !== undefined
                ? [theme.fg(node.jev >= 0.5 ? "success" : "dim", `Jev ${Math.round(node.jev * 100)}%`)]
                : []),
            ].join(theme.fg("dim", " · "));
        line = `${label} ${extra}`;
      }
      return isCursor ? selectedRow(theme, width, `${theme.fg("accent", " › ")}${line}`) : `   ${line}`;
    });
    if (rows.length > listHeight) {
      body.push(theme.fg("dim", `   ${this.scroll + 1}–${this.scroll + this.shownRows.length} of ${rows.length} rows`));
    }
    return [...header, ...padLines(body, Math.max(0, height - header.length - footer.length)), ...footer].map((line) =>
      truncateToWidth(line, width),
    );
  }

  private startDetail(width: number): string[] {
    const chosen = this.options.roots
      .map((root) => {
        const all = leaves([root]);
        const picked = all.filter((leaf) => leaf.selected).length;
        return picked === 0 ? undefined : all.length === 1 ? root.label : `${root.label} ${picked}/${all.length}`;
      })
      .filter(Boolean);
    const text = chosen.length
      ? `Planners get read, grep, find, ls, and: ${chosen.join(" · ")}`
      : "Planners get only read, grep, find, and ls.";
    return wrapTextWithAnsi(text, Math.max(10, width - 2))
      .slice(0, 3)
      .map((line) => ` ${this.theme.fg("muted", line)}`);
  }

  private detail(row: Row | undefined, width: number): string[] {
    const theme = this.theme;
    let text: string;
    if (!row) return [];
    {
      const node = row.node;
      text = node.detail || node.description || node.label;
      if (node.always) {
        text = `${text}${text.endsWith(".") ? "" : "."} Always offered (alwaysOffer in settings): Jev scores it but never deselects it.`;
      } else if (node.jevLocked && node.jev !== undefined) {
        text = `${text}${text.endsWith(".") ? "" : "."} Jev scores it but leaves it as you set it.`;
      }
      if (node.children) {
        const all = leaves([node]);
        text = `${text}${text.endsWith(".") ? "" : "."} ${all.filter((leaf) => leaf.selected).length} of ${all.length} tools selected.`;
      }
    }
    return wrapTextWithAnsi(text, Math.max(10, width - 2))
      .slice(0, 3)
      .map((line) => ` ${theme.fg("muted", line)}`);
  }

  private hints(row: Row | undefined): Hint[] {
    const start: Hint = { key: "⏎", label: "start planning", primary: true };
    const common: Hint[] = [
      { key: "↑↓", label: "move" },
      { key: "a/n", label: "all/none" },
      { key: "esc", label: this.options.backLabel ?? "back to settings" },
    ];
    const node = row?.node;
    const isGroup = node?.children !== undefined;
    const all = node !== undefined && groupState(node) === "all";
    return [
      start,
      { key: "space", label: `${all ? "clear" : "select"}${isGroup ? " all" : ""}` },
      ...(isGroup && node
        ? [{ key: "tab", label: this.expanded.has(node.id) ? "close" : "open" }]
        : row && row.depth > 0
          ? [{ key: "tab", label: "close group" }]
          : []),
      ...common,
    ];
  }
}
