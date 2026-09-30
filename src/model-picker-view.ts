import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeyId,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ModelSpec, ModelSpecThinkingLevel } from "./implementation-models.js";
import {
  type Column,
  effortText,
  fieldLine,
  type Hint,
  hintLine,
  renderTable,
  rule,
  selectedRow,
  titleLine,
} from "./ui-kit.js";

export interface ModelPickerRow {
  provider: string;
  modelId: string;
  name: string;
  /** One line about the model: id, context window, price. */
  details?: string;
  /** Effort levels this model accepts; `undefined` stands for the model's default. */
  efforts: ReadonlyArray<ModelSpecThinkingLevel | undefined>;
  effort?: ModelSpecThinkingLevel;
  selected: boolean;
  /** Which model its subagents run on, e.g. `Claude Opus 5.5 · high`. */
  subagents?(effort: ModelSpecThinkingLevel | undefined): string | undefined;
}

export type ModelPickerResult = { kind: "next"; specs: ModelSpec[] } | { kind: "cancel" };

export interface ModelPickerViewOptions {
  title: string;
  task?: string;
  notes: readonly string[];
  rows: ModelPickerRow[];
  height(): number;
  requestRender(): void;
  onDone(result: ModelPickerResult): void;
}

/**
 * Step 1: which models plan. One row per model; Space picks it, ←/→ sets its effort in place,
 * `/` filters, Enter moves on to the tools.
 */
export class ModelPickerView implements Component {
  private cursor = 0;
  private scroll = 0;
  private filter = "";
  private filtering = false;
  private message: string | undefined;
  private listTop = 0;
  private shown: ModelPickerRow[] = [];
  private effortColumn: { x: number; width: number } | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly options: ModelPickerViewOptions,
  ) {}

  invalidate() {}

  private visible() {
    const words = this.filter.toLowerCase().split(/\s+/u).filter(Boolean);
    if (words.length === 0) return this.options.rows;
    return this.options.rows.filter((row) => {
      const text = `${row.name} ${row.provider}/${row.modelId}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  private chosen() {
    return this.options.rows.filter((row) => row.selected);
  }

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    this.message = undefined;
    if (this.filtering) {
      if (is("escape")) {
        this.filter = "";
        this.filtering = false;
      } else if (is("enter", "down", "up", "ctrl+n", "ctrl+p")) this.filtering = false;
      else if (is("backspace")) this.filter = this.filter.slice(0, -1);
      else if (data.length === 1 && data >= " " && data !== "\u007f") this.filter += data;
      else return;
      this.cursor = 0;
      this.options.requestRender();
      return;
    }
    const rows = this.visible();
    const row = rows[this.cursor];
    if (is("escape")) {
      if (this.filter) {
        this.filter = "";
        this.cursor = 0;
      } else return this.options.onDone({ kind: "cancel" });
    } else if (is("ctrl+c")) return this.options.onDone({ kind: "cancel" });
    else if (is("up", "k", "p", "ctrl+p")) this.cursor = Math.max(0, this.cursor - 1);
    else if (is("down", "j", "n", "ctrl+n")) this.cursor = Math.min(rows.length - 1, this.cursor + 1);
    else if (is("pageUp")) this.cursor = Math.max(0, this.cursor - 10);
    else if (is("pageDown")) this.cursor = Math.min(rows.length - 1, this.cursor + 10);
    else if (is("home", "g")) this.cursor = 0;
    else if (is("end", "shift+g")) this.cursor = rows.length - 1;
    else if (row && is("space", "x")) row.selected = !row.selected;
    else if (row && is("right", "l")) this.stepEffort(row, 1);
    else if (row && is("left", "h")) this.stepEffort(row, -1);
    else if (is("/")) this.filtering = true;
    else if (is("enter")) return this.next();
    else return;
    this.options.requestRender();
  }

  private next() {
    const chosen = this.chosen();
    if (chosen.length === 0) {
      this.message = "Pick at least one model with Space.";
      this.options.requestRender();
      return;
    }
    this.options.onDone({
      kind: "next",
      specs: chosen.map((row) => ({
        provider: row.provider,
        modelId: row.modelId,
        ...(row.effort ? { thinkingLevel: row.effort } : {}),
      })),
    });
  }

  private stepEffort(row: ModelPickerRow, direction: 1 | -1) {
    const index = row.efforts.indexOf(row.effort);
    const next = row.efforts[Math.min(row.efforts.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))];
    if (next === undefined) delete row.effort;
    else row.effort = next;
    // Changing the effort of a model means you want it.
    row.selected = true;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const rows = this.visible();
    if (event.type === "wheel") {
      this.cursor = Math.min(rows.length - 1, Math.max(0, this.cursor + Math.sign(event.wheelDelta ?? 0)));
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left")
      return event.type === "press" ? { handled: true } : undefined;
    const offset = event.y - this.listTop;
    const row = this.shown[offset];
    if (!row) return { handled: true };
    this.cursor = this.scroll + offset;
    const effort = this.effortColumn;
    if (effort && event.x >= effort.x && event.x < effort.x + effort.width) {
      this.stepEffort(row, event.x < effort.x + effort.width / 2 ? -1 : 1);
    } else row.selected = !row.selected;
    this.options.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    const theme = this.theme;
    const rows = this.visible();
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    const height = Math.max(12, this.options.height());
    const chosen = this.chosen();
    const header = [
      rule(theme, width),
      titleLine(theme, width, this.options.title, "who plans, and how hard they think", "Models"),
      ...(this.options.task ? [fieldLine(theme, width, "Task", this.options.task)] : []),
      ...this.options.notes.map((note) => fieldLine(theme, width, "", theme.fg("muted", note))),
      "",
    ];
    const summary = chosen.length
      ? `${theme.fg("success", `${chosen.length} planner${chosen.length === 1 ? "" : "s"}`)}  ${chosen
          .map((row) => `${row.name}${row.effort ? ` ${theme.fg("dim", row.effort)}` : ""}`)
          .join(theme.fg("dim", " · "))}`
      : theme.fg("warning", "No planner picked yet");
    const current = rows[this.cursor];
    const scout = current?.subagents?.(current.effort);
    const detail = current
      ? [
          ` ${theme.fg("muted", current.details ?? `${current.provider}/${current.modelId}`)}`,
          ` ${theme.fg(
            "muted",
            scout
              ? `Its subagents run on ${scout} (scoutModelMap).`
              : "It works alone: no subagent model is set for it in scoutModelMap.",
          )}`,
        ]
      : [];
    const footer = [
      rule(theme, width),
      ...detail,
      rule(theme, width),
      ` ${this.message ? theme.fg("warning", this.message) : summary}`,
      this.filtering
        ? ` ${theme.fg("accent", "/")} ${this.filter}${theme.fg("accent", "▏")}   ${theme.fg("dim", "type to filter · ⏎ done · esc clear")}`
        : hintLine(theme, width, this.hints(rows[this.cursor])),
    ];
    const columns: Column<ModelPickerRow>[] = [
      { header: " ", get: (row) => (row.selected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]")) },
      { header: "MODEL", flex: true, min: 12, get: (row) => row.name },
      {
        header: "EFFORT",
        get: (row) => {
          const text = row.efforts.length > 1 ? effortText(theme, row.effort) : theme.fg("dim", "—");
          return row === rows[this.cursor] && row.efforts.length > 1
            ? `${theme.fg("accent", "‹")} ${text} ${theme.fg("accent", "›")}`
            : `  ${text}  `;
        },
      },
      {
        header: "SUBAGENTS",
        flex: true,
        min: 10,
        get: (row) => row.subagents?.(row.effort) ?? theme.fg("dim", "none"),
      },
    ];
    const table = renderTable(theme, rows, columns, width - 3);
    // Only as tall as the list needs, up to the terminal height.
    const listHeight = Math.min(Math.max(1, rows.length), Math.max(3, height - header.length - footer.length - 2));
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + listHeight) this.scroll = this.cursor - listHeight + 1;
    this.shown = rows.slice(this.scroll, this.scroll + listHeight);
    this.listTop = header.length + 1;
    const effortStart = 3 + (table.header.indexOf("EFFORT") >= 0 ? stripAnsi(table.header).indexOf("EFFORT") : -1);
    this.effortColumn = effortStart >= 3 ? { x: effortStart, width: 11 } : undefined;
    const list = this.shown.map((_row, offset) => {
      const text = table.lines[this.scroll + offset] ?? "";
      return this.scroll + offset === this.cursor
        ? selectedRow(theme, width, `${theme.fg("accent", " › ")}${text}`)
        : `   ${text}`;
    });
    const more =
      rows.length > listHeight
        ? theme.fg("dim", `   ${this.scroll + 1}–${this.scroll + this.shown.length} of ${rows.length} models`)
        : rows.length === 0
          ? theme.fg("dim", "   No model matches the filter.")
          : "";
    const body = [`   ${table.header}`, ...list, ...(more ? [more] : [])];
    return [...header, ...body, ...footer].map((line) => truncateToWidth(line, width));
  }

  private hints(row: ModelPickerRow | undefined): Hint[] {
    const chosen = this.chosen().length;
    return [
      { key: "⏎", label: chosen ? "next: tools" : "next (pick a model first)", primary: chosen > 0 },
      { key: "space", label: row?.selected ? "drop model" : "pick model" },
      ...(row && row.efforts.length > 1 ? [{ key: "←→", label: "effort" }] : []),
      { key: "↑↓", label: "move" },
      { key: "/", label: "filter" },
      { key: "esc", label: this.filter ? "clear filter" : "cancel" },
    ];
  }
}

function stripAnsi(text: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences.
  return text.replace(/\u001b\[[0-9;]*m/gu, "");
}
