// A page of settings rows: ↑/↓ (ctrl+j/ctrl+k) choose a row, ←/→ (ctrl+h/ctrl+l) cycle its value,
// Enter edits a text row or goes on. Used for the Settings step and the Implement step. A multiline
// text row (the task) shows its whole text as a wrapped block in the room the other rows leave, and
// is edited in place in a multi-line editor.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, type KeyId, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Hint, hintLine, padLines, padVisible, rule, selectedRow, type WorkflowStep } from "../ui-kit.js";
import { pageHeader } from "./frame.js";

export interface OptionRow {
  id: string;
  label: string;
  /** The value as shown (may be styled). */
  value(): string;
  /** Cycle the value; rows without it are read-only or edited as text. */
  cycle?(direction: 1 | -1): void;
  /** Text rows: the current text and how to store a new one. */
  text?: {
    get(): string;
    set(value: string): void;
    placeholder?: string;
    /** Shown as a wrapped block under its label and edited in a multi-line text area. */
    multiline?: boolean;
  };
  /** Shown under the list for the highlighted row. */
  description: string;
  /** A row that does not apply right now (e.g. effort when there is no second planner). */
  hidden?(): boolean;
  /** A section title drawn above this row. */
  section?: string;
}

/** A multi-line editor (pi-tui's Editor): Enter submits, shift+Enter starts a new line. */
export interface TextArea {
  focused: boolean;
  onSubmit?: (text: string) => void;
  setText(text: string): void;
  getText(): string;
  handleInput(data: string): void;
  render(width: number): string[];
}

type Editing =
  | { row: OptionRow; input: Input; area?: undefined }
  | { row: OptionRow; area: TextArea; input?: undefined };

/** Text-block indent: under the label, past the cursor marker. */
const BLOCK_INDENT = "     ";
const MIN_BLOCK_LINES = 3;

export interface OptionsPageOptions {
  title: string;
  context?: () => string;
  step: WorkflowStep;
  rows: OptionRow[];
  /** Lines above the rows (e.g. the task). */
  intro?: () => string[];
  next: { label: string; run(): void };
  back: { label: string; run(): void };
  rowsAvailable(): number;
  requestRender(): void;
  /** Called after a value changes. */
  onChange?(row: OptionRow): void;
  /** Makes the editor for multiline text rows; without it they are edited on one line. */
  createTextArea?(): TextArea;
}

export class OptionsPage {
  cursor = 0;
  private editing: Editing | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly options: OptionsPageOptions,
  ) {}

  /** Focus a row by id (e.g. the second planner when adding one). */
  focus(id: string) {
    const index = this.visible().findIndex((row) => row.id === id);
    if (index >= 0) this.cursor = index;
  }

  get typing() {
    return this.editing !== undefined;
  }

  private visible() {
    return this.options.rows.filter((row) => !row.hidden?.());
  }

  invalidate() {}

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const rows = this.visible();
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    const row = rows[this.cursor];
    if (this.editing) {
      const editing = this.editing;
      if (is("escape")) this.editing = undefined;
      else if (editing.area) editing.area.handleInput(data);
      else if (is("enter")) this.save(editing.row, editing.input.getValue());
      else editing.input.handleInput(data);
      this.options.requestRender();
      return;
    }
    if (is("escape")) return this.options.back.run();
    if (is("up", "ctrl+p", "ctrl+k", "k")) this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (is("down", "ctrl+n", "ctrl+j", "j")) this.cursor = (this.cursor + 1) % rows.length;
    else if (row?.cycle && is("right", "ctrl+l", "l", "space")) this.change(row, 1);
    else if (row?.cycle && is("left", "ctrl+h", "h")) this.change(row, -1);
    else if (is("enter")) {
      if (row?.text) this.startEditing(row);
      else return this.options.next.run();
    } else if (is("tab")) return this.options.next.run();
    else return;
    this.options.requestRender();
  }

  private startEditing(row: OptionRow) {
    const text = row.text;
    if (!text) return;
    const area = text.multiline ? this.options.createTextArea?.() : undefined;
    if (area) {
      area.setText(text.get());
      area.focused = true;
      area.onSubmit = (value) => {
        this.save(row, value);
        this.options.requestRender();
      };
      this.editing = { row, area };
      return;
    }
    const input = new Input({ placeholder: text.placeholder ?? "" });
    input.setValue(text.get());
    input.focused = true;
    this.editing = { row, input };
  }

  private save(row: OptionRow, value: string) {
    row.text?.set(value.trim());
    this.options.onChange?.(row);
    this.editing = undefined;
  }

  private isBlock(row: OptionRow) {
    return row.text?.multiline === true;
  }

  /** The wrapped block under a multiline row: its text, or the editor while you edit it. */
  private block(row: OptionRow, width: number, budget: number, current: boolean): string[] {
    const theme = this.theme;
    const inner = Math.max(10, width - BLOCK_INDENT.length - 2);
    if (this.editing?.row === row && this.editing.area) {
      return this.editing.area.render(Math.max(10, width - BLOCK_INDENT.length)).map((line) => BLOCK_INDENT + line);
    }
    const gutter = theme.fg(current ? "accent" : "borderMuted", "│");
    const text = row.text?.get() ?? "";
    let lines = text
      ? text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""]))
      : [theme.fg("dim", row.text?.placeholder ?? "")];
    if (lines.length > budget) {
      const hidden = lines.length - budget + 1;
      lines = [
        ...lines.slice(0, budget - 1),
        theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"} (⏎ to edit)`),
      ];
    }
    return lines.map((line) => `${BLOCK_INDENT}${gutter} ${line}`);
  }

  private change(row: OptionRow, direction: 1 | -1) {
    row.cycle?.(direction);
    this.options.onChange?.(row);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = this.options.rowsAvailable();
    const rows = this.visible();
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    const header = [...pageHeader(theme, width, this.options.title, this.options.context?.() ?? "", this.options.step)];
    const intro = this.options.intro?.() ?? [];
    const labelWidth = Math.min(32, Math.max(14, ...rows.map((row) => visibleWidth(row.label) + 2)));
    const footerHeight = 6;
    const middle = Math.max(0, height - header.length - footerHeight);
    // Multiline rows share the room the other rows leave (one blank line follows each block).
    const blocks = rows.filter((row) => this.isBlock(row)).length;
    const fixed =
      intro.length +
      (intro.length ? 1 : 0) +
      rows.reduce((sum, row) => sum + 1 + (row.section ? 2 : 0) + (this.isBlock(row) ? 1 : 0), 0);
    const budget = blocks ? Math.max(MIN_BLOCK_LINES, Math.floor((middle - fixed) / blocks)) : 0;
    const body: string[] = [];
    rows.forEach((row, index) => {
      if (row.section) body.push("", ` ${theme.fg("muted", theme.bold(row.section))}`);
      const current = index === this.cursor;
      const label = padVisible(`${current ? theme.fg("accent", " › ") : "   "}${row.label}`, labelWidth + 3);
      if (this.isBlock(row)) {
        // A blank line sets the block apart, unless a section title (which brings its own) follows.
        const spacer = rows[index + 1]?.section ? [] : [""];
        body.push(
          current ? selectedRow(theme, width, label) : label,
          ...this.block(row, width, budget, current),
          ...spacer,
        );
        return;
      }
      let value: string;
      if (current && this.editing?.row === row && this.editing.input)
        value = this.editing.input.render(Math.max(10, width - labelWidth - 6))[0] ?? "";
      else if (row.cycle)
        value = current ? `${theme.fg("accent", "‹")} ${row.value()} ${theme.fg("accent", "›")}` : `  ${row.value()}`;
      else value = `  ${row.value()}`;
      const line = `${label}${value}`;
      body.push(current ? selectedRow(theme, width, line) : line);
    });
    const row = rows[this.cursor];
    const detail = row
      ? wrapTextWithAnsi(row.description, Math.max(10, width - 2))
          .slice(0, 3)
          .map((line) => ` ${theme.fg("muted", line)}`)
      : [];
    const footer = [
      rule(theme, width),
      ...padLines(detail, 3),
      rule(theme, width),
      hintLine(theme, width, this.hints(row)),
    ];
    const content = [...intro, ...(intro.length ? [""] : []), ...body];
    return [...header, ...padLines(content, middle), ...footer].map((line) => truncateToWidth(line, width));
  }

  private hints(row: OptionRow | undefined): Hint[] {
    if (this.editing) {
      return [
        { key: "⏎", label: "save", primary: true },
        ...(this.editing.area ? [{ key: "shift+⏎", label: "new line" }] : []),
        { key: "esc", label: "cancel" },
      ];
    }
    return [
      { key: "⏎", label: row?.text ? "edit" : this.options.next.label, primary: true },
      ...(row?.text ? [{ key: "tab", label: this.options.next.label }] : []),
      ...(row?.cycle ? [{ key: "←→", label: "change" }] : []),
      { key: "↑↓", label: "move" },
      { key: "esc", label: this.options.back.label },
    ];
  }
}
