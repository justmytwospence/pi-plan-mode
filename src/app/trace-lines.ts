import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PlannerTrace, TraceEntry } from "../planner-trace.js";

/** Wrapped lines of a planner's trace, cached per entry and width. */
export class TraceRenderer {
  private readonly cache = new WeakMap<TraceEntry, { key: string; lines: string[] }>();
  private readonly plans = new Map<string, { plan: string; width: number; lines: string[] }>();

  constructor(private readonly theme: Theme) {}

  lines(trace: PlannerTrace, width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    for (const entry of trace.entries) {
      const key = `${width}:${entryKey(entry)}`;
      const cached = this.cache.get(entry);
      if (cached?.key === key) {
        lines.push(...cached.lines);
        continue;
      }
      let rendered: string[];
      if (entry.kind === "text") rendered = wrap(entry.text.trim(), width);
      else if (entry.kind === "thinking") {
        rendered = wrap(entry.text.trim(), width).map((line) => theme.fg("thinkingText", theme.italic(line)));
      } else if (entry.kind === "tool") {
        const icon = entry.status === "running" ? "⋯" : entry.status === "ok" ? "✓" : "✗";
        const color = entry.status === "error" ? "error" : entry.status === "running" ? "accent" : "toolTitle";
        rendered = wrap(`${icon} ${entry.summary}`, width).map((line) => theme.fg(color, line));
        if (entry.result) rendered.push(theme.fg("dim", truncateToWidth(`  ${entry.result}`, width)));
      } else if (entry.kind === "user") {
        rendered = ["", ...wrap(`you › ${entry.text.trim()}`, width).map((line) => theme.fg("accent", line)), ""];
      } else {
        const color = entry.tone === "error" ? "error" : entry.tone === "warning" ? "warning" : "muted";
        rendered = wrap(`• ${entry.text}`, width).map((line) => theme.fg(color, line));
      }
      if (entry.kind === "text" || entry.kind === "thinking") rendered.push("");
      this.cache.set(entry, { key, lines: rendered });
      lines.push(...rendered);
    }
    return lines;
  }

  planLines(id: string, plan: string, width: number): string[] {
    const cached = this.plans.get(id);
    if (cached && cached.plan === plan && cached.width === width) return cached.lines;
    let lines: string[];
    try {
      lines = new Markdown(plan, 0, 0, getMarkdownTheme()).render(Math.max(1, width));
    } catch {
      lines = wrap(plan, width);
    }
    this.plans.set(id, { plan, width, lines });
    return lines;
  }
}

function entryKey(entry: TraceEntry) {
  switch (entry.kind) {
    case "text":
    case "thinking":
      return `${entry.kind}:${entry.text.length}`;
    case "tool":
      return `tool:${entry.status}:${entry.result?.length ?? 0}`;
    default:
      return `${entry.kind}:${entry.text.length}`;
  }
}

export function wrap(text: string, width: number) {
  if (!text) return [];
  return text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}
