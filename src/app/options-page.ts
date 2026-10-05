// A page of settings rows: ↑/↓ (ctrl+j/ctrl+k) choose a row, ←/→ (ctrl+h/ctrl+l) cycle its value,
// Enter edits a text row or goes on. Used for the Settings step and the Implement step.
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
  text?: { get(): string; set(value: string): void; placeholder?: string };
  /** Shown under the list for the highlighted row. */
  description: string;
  /** A row that does not apply right now (e.g. effort when there is no second planner). */
  hidden?(): boolean;
  /** A section title drawn above this row. */
  section?: string;
}

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
}

export class OptionsPage {
  cursor = 0;
  private editing: { row: OptionRow; input: Input } | undefined;

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
      if (is("escape")) this.editing = undefined;
      else if (is("enter")) {
        this.editing.row.text?.set(this.editing.input.getValue().trim());
        this.options.onChange?.(this.editing.row);
        this.editing = undefined;
      } else this.editing.input.handleInput(data);
      this.options.requestRender();
      return;
    }
    if (is("escape")) return this.options.back.run();
    if (is("up", "ctrl+p", "ctrl+k", "k")) this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (is("down", "ctrl+n", "ctrl+j", "j")) this.cursor = (this.cursor + 1) % rows.length;
    else if (row?.cycle && is("right", "ctrl+l", "l", "space")) this.change(row, 1);
    else if (row?.cycle && is("left", "ctrl+h", "h")) this.change(row, -1);
    else if (is("enter")) {
      if (row?.text) {
        const input = new Input({ placeholder: row.text.placeholder ?? "" });
        input.setValue(row.text.get());
        input.focused = true;
        this.editing = { row, input };
      } else return this.options.next.run();
    } else if (is("tab")) return this.options.next.run();
    else return;
    this.options.requestRender();
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
    const body: string[] = [];
    rows.forEach((row, index) => {
      if (row.section) body.push("", ` ${theme.fg("muted", theme.bold(row.section))}`);
      const current = index === this.cursor;
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
    const middle = Math.max(0, height - header.length - footer.length);
    const content = [...intro, ...(intro.length ? [""] : []), ...body];
    return [...header, ...padLines(content, middle), ...footer].map((line) => truncateToWidth(line, width));
  }

  private hints(row: OptionRow | undefined): Hint[] {
    if (this.editing) {
      return [
        { key: "⏎", label: "save", primary: true },
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
