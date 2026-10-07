// A page of settings rows: ↑/↓ (ctrl+j/ctrl+k) choose a row, ←/→ (ctrl+h/ctrl+l) cycle its value,
// Enter edits a text row or goes on. Used for the Settings step and the Implement step. A multiline
// text row (the task) is a box of its own above the rows, several lines tall and wrapped: Tab moves
// between it and the rows, and while it has focus every key goes to its editor (your own editor, so
// vim mode works there too).
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, type KeyId, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type Hint,
  hintLine,
  padLines,
  padVisible,
  placeholderStyle,
  rule,
  selectedRow,
  type WorkflowStep,
} from "../ui-kit.js";
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

/** A multi-line editor (pi's editor, or the one an extension like pi-vim sets): Enter submits. */
export interface TextArea {
  focused: boolean;
  onSubmit?: (text: string) => void;
  /** Called on Escape when the editor has nothing of its own to do with it (vim: in normal mode). */
  onEscape?: () => void;
  setText(text: string): void;
  getText(): string;
  handleInput(data: string): void;
  render(width: number): string[];
}

/** Box indent: in line with the row labels. */
const BOX_INDENT = "   ";
const MIN_BOX_LINES = 5;
/** pi's editor shows at most this share of the terminal before it scrolls. */
const EDITOR_SHARE = 0.3;

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
  /** A single-line text row being edited in place. */
  private editing: { row: OptionRow; input: Input } | undefined;
  /** The box (multiline row) that has focus, if any. */
  private boxFocus: OptionRow | undefined;
  private readonly areas = new Map<string, TextArea>();

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
    return this.editing !== undefined || this.boxFocus !== undefined;
  }

  /** The rows ↑/↓ move between (boxes are reached with Tab). */
  private visible() {
    return this.options.rows.filter((row) => !row.hidden?.() && !this.isBox(row));
  }

  private boxes() {
    return this.options.rows.filter((row) => !row.hidden?.() && this.isBox(row));
  }

  invalidate() {}

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const rows = this.visible();
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    const row = rows[this.cursor];
    const box = this.boxFocus;
    if (box) {
      if (box.hidden?.()) this.leaveBox();
      else if (is("tab", "shift+tab")) this.leaveBox();
      else {
        const area = this.areaFor(box);
        area.handleInput(data);
        if (this.boxFocus === box) box.text?.set(area.getText().trim());
      }
      this.options.requestRender();
      return;
    }
    if (this.editing) {
      const editing = this.editing;
      if (is("escape")) this.editing = undefined;
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
    } else if (is("tab", "shift+tab")) {
      const first = this.boxes()[0];
      if (!first) return this.options.next.run();
      this.enterBox(first);
    } else return;
    this.options.requestRender();
  }

  /** The editor behind a box, made once so it keeps its undo history and vim mode. */
  private areaFor(row: OptionRow): TextArea {
    let area = this.areas.get(row.id);
    if (area) return area;
    const created = this.options.createTextArea?.() ?? new LineArea(this.theme);
    created.setText(row.text?.get() ?? "");
    created.onSubmit = (value) => {
      // pi's editor clears itself on submit; keep the text in case the page stays.
      created.setText(value);
      row.text?.set(value.trim());
      this.options.onChange?.(row);
      this.leaveBox();
      this.options.next.run();
    };
    created.onEscape = () => {
      this.leaveBox();
      this.options.requestRender();
    };
    this.areas.set(row.id, created);
    area = created;
    return area;
  }

  private enterBox(row: OptionRow) {
    const area = this.areaFor(row);
    if (area.getText().trim() !== (row.text?.get() ?? "").trim()) area.setText(row.text?.get() ?? "");
    area.focused = true;
    this.boxFocus = row;
  }

  private leaveBox() {
    const row = this.boxFocus;
    if (!row) return;
    const area = this.areas.get(row.id);
    if (area) {
      area.focused = false;
      row.text?.set(area.getText().trim());
      this.options.onChange?.(row);
    }
    this.boxFocus = undefined;
  }

  private startEditing(row: OptionRow) {
    const text = row.text;
    if (!text) return;
    const input = new Input({ placeholder: text.placeholder ?? "", placeholderStyle: placeholderStyle(this.theme) });
    input.setValue(text.get());
    input.focused = true;
    this.editing = { row, input };
  }

  private save(row: OptionRow, value: string) {
    row.text?.set(value.trim());
    this.options.onChange?.(row);
    this.editing = undefined;
  }

  private isBox(row: OptionRow) {
    return row.text?.multiline === true;
  }

  /** How many text lines a box shows: its text, at least a few lines, at most the room left. */
  private boxHeight(row: OptionRow, width: number, budget: number) {
    const lines = this.wrapped(row, this.boxInner(width)).length;
    const editorMax = Math.max(5, Math.floor(this.options.rowsAvailable() * EDITOR_SHARE));
    return Math.max(MIN_BOX_LINES, Math.min(lines, budget, editorMax));
  }

  private boxInner(width: number) {
    return Math.max(10, width - BOX_INDENT.length - 3);
  }

  private wrapped(row: OptionRow, inner: number) {
    const text = row.text?.get() ?? "";
    return text ? text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""])) : [];
  }

  /** A box: its label, then the editor while it has focus, or its text between two rules. */
  private box(row: OptionRow, width: number, budget: number): string[] {
    const theme = this.theme;
    const focused = this.boxFocus === row;
    const boxWidth = Math.max(10, width - BOX_INDENT.length - 1);
    const height = this.boxHeight(row, width, budget);
    const label = focused ? `${theme.fg("accent", " › ")}${theme.fg("accent", row.label)}` : `   ${row.label}`;
    if (focused) {
      const lines = this.areaFor(row).render(boxWidth);
      // Pad the editor to the box's height so the page does not jump when focus moves.
      const bottom = lines.length - 1;
      const pad = Math.max(0, height + 2 - lines.length);
      const padded = [...lines.slice(0, bottom), ...Array(pad).fill(""), ...lines.slice(bottom)];
      return [label, ...padded.map((line) => BOX_INDENT + line)];
    }
    const border = theme.fg("borderMuted", "─".repeat(boxWidth));
    let lines = this.wrapped(row, this.boxInner(width));
    if (lines.length === 0) lines = [placeholderStyle(theme)(row.text?.placeholder ?? "")];
    if (lines.length > height) {
      const hidden = lines.length - height + 1;
      lines = [
        ...lines.slice(0, height - 1),
        theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"} (tab to edit)`),
      ];
    }
    const body = padLines(lines, height).map((line) => ` ${line}`);
    return [label, ...[border, ...body, border].map((line) => BOX_INDENT + line)];
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
    // Boxes share the room the other rows leave (label, two rules, and a blank line after each).
    const boxes = this.boxes();
    const fixed =
      intro.length +
      (intro.length ? 1 : 0) +
      boxes.length * 4 +
      rows.reduce((sum, row) => sum + 1 + (row.section ? 2 : 0), 0);
    const budget = boxes.length ? Math.max(MIN_BOX_LINES, Math.floor((middle - fixed) / boxes.length)) : 0;
    const body: string[] = [];
    for (const box of boxes) body.push(...this.box(box, width, budget), "");
    rows.forEach((row, index) => {
      if (row.section)
        body.push(...(index === 0 && boxes.length ? [] : [""]), ` ${theme.fg("muted", theme.bold(row.section))}`);
      const current = index === this.cursor && !this.boxFocus;
      const label = padVisible(`${current ? theme.fg("accent", " › ") : "   "}${row.label}`, labelWidth + 3);
      let value: string;
      if (current && this.editing?.row === row)
        value = this.editing.input.render(Math.max(10, width - labelWidth - 6))[0] ?? "";
      else if (row.cycle)
        value = current ? `${theme.fg("accent", "‹")} ${row.value()} ${theme.fg("accent", "›")}` : `  ${row.value()}`;
      else value = `  ${row.value()}`;
      const line = `${label}${value}`;
      body.push(current ? selectedRow(theme, width, line) : line);
    });
    const row = this.boxFocus ?? rows[this.cursor];
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
    if (this.boxFocus) {
      return [
        { key: "⏎", label: this.options.next.label, primary: true },
        { key: "shift+⏎", label: "new line" },
        { key: "tab", label: "settings" },
      ];
    }
    if (this.editing) {
      return [
        { key: "⏎", label: "save", primary: true },
        { key: "esc", label: "cancel" },
      ];
    }
    const box = this.boxes()[0];
    return [
      { key: "⏎", label: row?.text ? "edit" : this.options.next.label, primary: true },
      { key: "tab", label: box ? `edit ${box.label.toLowerCase()}` : this.options.next.label },
      ...(row?.cycle ? [{ key: "←→", label: "change" }] : []),
      { key: "↑↓", label: "move" },
      { key: "esc", label: this.options.back.label },
    ];
  }
}

/** Fallback for a box without a multi-line editor: a one-line input. */
class LineArea implements TextArea {
  focused = false;
  onSubmit?: (text: string) => void;
  onEscape?: () => void;
  private readonly input: Input;
  constructor(theme: Theme) {
    this.input = new Input({ placeholderStyle: placeholderStyle(theme) });
    this.input.onSubmit = (value) => this.onSubmit?.(value);
  }
  setText(text: string) {
    this.input.setValue(text);
  }
  getText() {
    return this.input.getValue();
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape")) this.onEscape?.();
    else this.input.handleInput(data);
  }
  render(width: number) {
    this.input.focused = this.focused;
    return ["", ...this.input.render(width), ""];
  }
}
