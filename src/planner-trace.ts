/** Live, bounded record of what one planner is doing, built from its Pi event stream. */

export type TraceEntry =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; result?: string }
  | { kind: "note"; text: string; tone: "info" | "warning" | "error" };

const MAX_ENTRIES = 1_500;
const MAX_TEXT_CHARS = 24_000;
const MAX_RESULT_CHARS = 160;

export class PlannerTrace {
  readonly entries: TraceEntry[] = [];
  /** Bumped on every change so renderers can cache wrapped lines. */
  version = 0;
  private streaming: { kind: "text" | "thinking"; entry: { text: string } } | undefined;
  private readonly toolsById = new Map<string, Extract<TraceEntry, { kind: "tool" }>>();

  note(text: string, tone: "info" | "warning" | "error" = "info") {
    this.push({ kind: "note", text, tone });
  }

  /** Apply one Pi JSON/RPC session event. */
  apply(event: Record<string, unknown>) {
    switch (event.type) {
      case "message_update": {
        const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
        if (!update) return;
        if (update.type === "text_delta" && typeof update.delta === "string") this.appendStream("text", update.delta);
        else if (update.type === "thinking_delta" && typeof update.delta === "string") {
          this.appendStream("thinking", update.delta);
        } else if (update.type === "text_end" || update.type === "thinking_end") this.streaming = undefined;
        return;
      }
      case "message_end":
        this.streaming = undefined;
        if (isRecord(event.message) && event.message.role === "assistant") {
          const { stopReason, errorMessage } = event.message;
          if (stopReason === "error") {
            this.note(`Model error: ${typeof errorMessage === "string" ? errorMessage : "unknown"}`, "error");
          }
        }
        return;
      case "tool_execution_start": {
        this.streaming = undefined;
        const name = typeof event.toolName === "string" ? event.toolName : "tool";
        const id = typeof event.toolCallId === "string" ? event.toolCallId : `${this.entries.length}`;
        const entry: Extract<TraceEntry, { kind: "tool" }> = {
          kind: "tool",
          id,
          name,
          summary: describeToolArgs(name, event.args),
          status: "running",
        };
        this.toolsById.set(id, entry);
        this.push(entry);
        return;
      }
      case "tool_execution_end": {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const entry = id ? this.toolsById.get(id) : undefined;
        if (!entry) return;
        entry.status = event.isError === true ? "error" : "ok";
        entry.result = summarizeResult(entry.name, event.result);
        if (id) this.toolsById.delete(id);
        this.version += 1;
        return;
      }
      case "auto_retry_start":
        this.note(
          `Retrying after: ${typeof event.errorMessage === "string" ? event.errorMessage : "provider error"}`,
          "warning",
        );
        return;
      case "compaction_start":
        this.note("Compacting context…", "info");
        return;
      default:
        return;
    }
  }

  private appendStream(kind: "text" | "thinking", delta: string) {
    if (this.streaming?.kind !== kind) {
      const entry = { kind, text: "" } as TraceEntry & { text: string };
      this.push(entry);
      this.streaming = { kind, entry };
    }
    const target = this.streaming.entry;
    if (target.text.length < MAX_TEXT_CHARS) target.text += delta;
    this.version += 1;
  }

  private push(entry: TraceEntry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.version += 1;
  }
}

export function describeToolArgs(toolName: string, args: unknown): string {
  if (!isRecord(args)) return toolName;
  if (Array.isArray(args.tasks)) {
    const labels = args.tasks
      .map((task) => (isRecord(task) && typeof task.label === "string" ? task.label : undefined))
      .filter(Boolean);
    return `${toolName} ×${args.tasks.length}${labels.length ? `: ${labels.join(", ")}` : ""}`;
  }
  if (toolName === "codemode" && typeof args.code === "string") {
    // Name the tools the script calls (`tools.x(...)` or `tools["x"](...)`), not its source.
    const called = [
      ...new Set(
        Array.from(
          args.code.matchAll(/\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/gu),
          (match) => match[1] ?? match[2] ?? "",
        ).filter(Boolean),
      ),
    ];
    if (called.length === 0) return toolName;
    const shown = called.slice(0, 4).join(", ");
    return `${toolName} ${shown}${called.length > 4 ? `, +${called.length - 4} more` : ""}`;
  }
  const detail =
    typeof args.path === "string"
      ? args.path
      : typeof args.pattern === "string"
        ? args.pattern
        : typeof args.command === "string"
          ? args.command
          : typeof args.query === "string"
            ? `"${args.query}"`
            : typeof args.url === "string"
              ? args.url
              : Array.isArray(args.queries)
                ? args.queries.filter((query) => typeof query === "string").join(" | ")
                : undefined;
  if (!detail) return toolName;
  const oneLine = detail.replace(/\s+/gu, " ").trim();
  return `${toolName} ${oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine}`;
}

function summarizeResult(toolName: string, result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const text = Array.isArray(result.content)
    ? result.content
        .flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
        )
        .join("\n")
    : "";
  if (toolName === "read" && text) return `${text.split("\n").length} lines`;
  const firstLine =
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  return firstLine.length > MAX_RESULT_CHARS ? `${firstLine.slice(0, MAX_RESULT_CHARS - 1)}…` : firstLine || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
