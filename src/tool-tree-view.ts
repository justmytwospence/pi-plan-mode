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
import { groupState, leaves, type ToolNode, toggle } from "./tool-tree.js";
import {
  fieldLine,
  type Hint,
  hintLine,
  padLines,
  padVisible,
  rule,
  selectedRow,
  spinner,
  titleLine,
} from "./ui-kit.js";

export type ToolTreeResult = { kind: "start"; timeLimitMinutes: number } | { kind: "back" } | { kind: "cancel" };

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
  startLabel: string;
  timeLimitMinutes: number;
  timeLimitChoices: readonly number[];
  preselection?: ToolPreselection;
  rows(): number;
  requestRender(): void;
  onDone(result: ToolTreeResult): void;
}

type Row = { kind: "start" } | { kind: "time" } | { kind: "node"; node: ToolNode; depth: number };

/**
 * Step 2: which tools planners may use. Groups (toolsets, MCP servers) open with Enter or →, Space
 * selects or clears a tool or a whole group, and a partial mark shows a group where only some
 * tools are selected. The highlighted row is described at the bottom.
 */
export class ToolTreeView implements Component {
  /** Starts on the first tool, so Space works at once; Enter starts from anywhere. */
  private cursor = 2;
  /** Enter away from the Start row asks first. */
  private confirming = false;
  private scroll = 0;
  private timeLimit: number;
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
    this.timeLimit = options.timeLimitMinutes;
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
    const rows: Row[] = [{ kind: "start" }, { kind: "time" }];
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
    // Enter starts from anywhere: directly on the Start row, after a confirmation elsewhere.
    if (is("enter")) {
      if (row?.kind === "start") return this.start();
      this.confirming = true;
    } else if (is("up", "k")) this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (is("down", "j")) this.cursor = (this.cursor + 1) % rows.length;
    else if (is("pageUp")) this.cursor = Math.max(0, this.cursor - 10);
    else if (is("pageDown")) this.cursor = Math.min(rows.length - 1, this.cursor + 10);
    else if (is("home", "g")) this.cursor = 0;
    else if (is("end", "shift+g")) this.cursor = rows.length - 1;
    else if (is("+", "=")) this.stepTime(1);
    else if (is("-")) this.stepTime(-1);
    else if (is("a")) {
      for (const leaf of leaves(this.options.roots)) leaf.selected = true;
      this.touched = true;
    } else if (is("n")) {
      for (const leaf of leaves(this.options.roots)) leaf.selected = false;
      this.touched = true;
    } else if (row?.kind === "time" && is("right", "l", "space")) this.stepTime(1);
    else if (row?.kind === "time" && is("left", "h")) this.stepTime(-1);
    else if (row?.kind === "node" && is("space", "x")) this.change(row.node);
    else if (row?.kind === "node" && is("right", "l")) {
      // Open a group; on an open group, step into its first tool.
      if (!row.node.children) return;
      if (this.expanded.has(row.node.id)) this.cursor = Math.min(rows.length - 1, this.cursor + 1);
      else this.expanded.add(row.node.id);
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
    } else if (!this.confirming && !dismissed) return;
    this.options.requestRender();
  }

  private start() {
    this.finish({ kind: "start", timeLimitMinutes: this.timeLimit });
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
    if (row.kind === "start") {
      this.finish({ kind: "start", timeLimitMinutes: this.timeLimit });
      return { handled: true };
    }
    if (row.kind === "time") this.stepTime(event.x < 18 ? -1 : 1);
    else {
      // Clicking the checkbox selects or clears; clicking elsewhere on a group opens or closes it.
      const boxStart = 3 + row.depth * 2 + 2;
      const onBox = event.x >= boxStart && event.x < boxStart + 3;
      if (row.node.children && !onBox) this.toggleExpanded(row.node.id);
      else this.change(row.node);
    }
    this.options.requestRender();
    return { handled: true };
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
      rule(theme, width),
      titleLine(theme, width, this.options.title, "what planners and their subagents may use", "Tools"),
      ...(this.options.task ? [fieldLine(theme, width, "Task", this.options.task)] : []),
      ...(jev ? [fieldLine(theme, width, "Jev", jev)] : []),
      ...this.options.notes.map((note) => fieldLine(theme, width, "", theme.fg("muted", note))),
      "",
    ];
    const current = rows[this.cursor];
    const detail = this.detail(this.confirming ? { kind: "start" } : current, width);
    const footer = [
      rule(theme, width),
      ...padLines(detail, 3),
      rule(theme, width),
      this.confirming
        ? `${truncateToWidth(
            ` ${theme.fg("warning", theme.bold(`${this.options.startLabel}?`))}  ${theme.fg("muted", `${selectedCount} of ${all.length} tools · ${this.timeLimit} min limit`)}`,
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
      if (row.kind === "start") {
        line = `${theme.fg("success", theme.bold(`▶ ${this.options.startLabel}`))}  ${theme.fg("dim", `${selectedCount} of ${all.length} tools · ${this.timeLimit} min limit`)}`;
      } else if (row.kind === "time") {
        line = `  Time limit  ${theme.fg("accent", "‹")} ${theme.bold(`${this.timeLimit} min`)} ${theme.fg("accent", "›")}  ${theme.fg("dim", "planners are asked to wrap up at 80%")}`;
      } else {
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
          : node.jev !== undefined
            ? theme.fg(node.jev >= 0.5 ? "success" : "dim", `Jev ${Math.round(node.jev * 100)}%`)
            : "";
        line = `${label} ${extra}`;
      }
      return isCursor ? selectedRow(theme, width, `${theme.fg("accent", " › ")}${line}`) : `   ${line}`;
    });
    if (rows.length > listHeight) {
      body.push(theme.fg("dim", `   ${this.scroll + 1}–${this.scroll + this.shownRows.length} of ${rows.length} rows`));
    }
    return [...header, ...body, ...footer].map((line) => truncateToWidth(line, width));
  }

  private detail(row: Row | undefined, width: number): string[] {
    const theme = this.theme;
    let text: string;
    if (!row) return [];
    if (row.kind === "start") {
      const chosen = this.options.roots
        .map((root) => {
          const all = leaves([root]);
          const picked = all.filter((leaf) => leaf.selected).length;
          return picked === 0 ? undefined : all.length === 1 ? root.label : `${root.label} ${picked}/${all.length}`;
        })
        .filter(Boolean);
      text = chosen.length ? `Planners get: ${chosen.join(" · ")}` : "Planners get only read, grep, find, and ls.";
    } else if (row.kind === "time") {
      text = "How long each planner may run. At 80% it is asked to wrap up; at the limit it is stopped.";
    } else {
      const node = row.node;
      text = node.detail || node.description || node.label;
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
      { key: "esc", label: "back to models" },
    ];
    if (row?.kind === "start") return [start, ...common];
    if (row?.kind === "time") return [start, { key: "←→", label: "time limit" }, ...common];
    const node = row?.kind === "node" ? row.node : undefined;
    const isGroup = node?.children !== undefined;
    const all = node !== undefined && groupState(node) === "all";
    return [
      start,
      { key: "space", label: `${all ? "clear" : "select"}${isGroup ? " all" : ""}` },
      ...(isGroup && node
        ? [this.expanded.has(node.id) ? { key: "←", label: "close" } : { key: "→", label: "open" }]
        : row?.kind === "node" && row.depth > 0
          ? [{ key: "←", label: "up to group" }]
          : []),
      ...common,
    ];
  }
}
