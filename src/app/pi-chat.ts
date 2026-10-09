// A planner's (or your main agent's) conversation as Pi itself shows it: Pi's own message and tool
// components, fed by the session's events the way Pi's interactive mode feeds its chat, so
// Markdown, thinking, tool calls and results, and every extension tool's renderer look as they do
// in pi. Plan mode adds only notes (plan submitted, delivered, stopped) and labels for messages
// someone else sent (your main agent).
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  type Theme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";

/** What a tool call needs to render: its definition's renderCall/renderResult, if it has them. */
export type ToolRenderers = ConstructorParameters<typeof ToolExecutionComponent>[4];

export interface PiChatOptions {
  cwd: string;
  /** The tool's definition in the session that ran it; built-in tools fall back to Pi's renderers. */
  toolDefinition?(name: string): ToolRenderers | undefined;
  /** Show user messages as their events arrive (your main session); planners label theirs instead. */
  userMessagesFromEvents?: boolean;
  requestRender?(): void;
}

type Tone = "info" | "warning" | "error";
type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string };
type ToolCall = { type: "toolCall"; id: string; name: string; arguments: unknown };

let sharedTheme: Theme | undefined;

/** The theme notes and labels use; the planning screen sets it when it opens. */
export function setPiChatTheme(theme: Theme) {
  sharedTheme = theme;
}

export const piChatTheme = () => sharedTheme;

/** Lines kept when a conversation grows past this many components (the oldest go). */
const MAX_COMPONENTS = 1_500;

export class PiChat {
  private readonly container = new Container();
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private streaming: AssistantMessageComponent | undefined;
  private builtIns: Record<string, ToolRenderers> | undefined;
  private expanded = false;
  /** Bumped on every change, so a renderer can tell when to re-render. */
  version = 0;

  constructor(
    private readonly theme: () => Theme | undefined,
    private readonly options: PiChatOptions,
  ) {}

  get empty() {
    return this.container.children.length === 0;
  }

  /** Expand tool output (like ctrl+o in pi), or collapse it again. */
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    for (const child of this.container.children) {
      (child as { setExpanded?(value: boolean): void }).setExpanded?.(expanded);
    }
    this.changed();
  }

  get isExpanded() {
    return this.expanded;
  }

  render(width: number): string[] {
    try {
      return this.container.render(Math.max(1, width));
    } catch {
      return [];
    }
  }

  /** A line from plan mode itself: a plan submitted or delivered, a stop, a failure. */
  note(text: string, tone: Tone = "info") {
    const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
    const theme = this.theme();
    this.add(new Text(theme ? theme.fg(color, `• ${text}`) : `• ${text}`, 1, 0));
  }

  /** A message to the agent, labelled with who sent it when that was not you. */
  user(text: string, from?: string) {
    const theme = this.theme();
    if (!this.empty) this.add(new Spacer(1));
    if (from) this.add(new Text(theme ? theme.fg("warning", `${from} ›`) : `${from} ›`, 1, 0));
    this.add(new UserMessageComponent(text, getMarkdownTheme()));
  }

  /** Show earlier messages of the session (a restored planner, or your main session). */
  seed(
    messages: readonly unknown[],
    userText: (text: string, index: number) => { text: string; from?: string } | undefined,
  ) {
    const pending = new Map<string, ToolExecutionComponent>();
    let users = 0;
    for (const raw of messages) {
      const message = raw as Message;
      if (message.role === "user") {
        const shown = userText(contentText(message.content), users);
        users += 1;
        if (shown?.text.trim()) this.user(shown.text.trim(), shown.from);
      } else if (message.role === "assistant") {
        this.add(this.assistant(message));
        for (const call of toolCalls(message)) {
          const component = this.tool(call);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            component.updateResult({
              content: [{ type: "text", text: message.errorMessage || "Error" }],
              isError: true,
            } as never);
          } else pending.set(call.id, component);
        }
      } else if (message.role === "toolResult" && message.toolCallId) {
        pending.get(message.toolCallId)?.updateResult(message as never);
        pending.delete(message.toolCallId);
      }
    }
    this.changed();
  }

  /** One session event, handled as Pi's interactive mode handles it. */
  apply(event: Record<string, unknown>) {
    const message = (event.message ?? undefined) as Message | undefined;
    switch (event.type) {
      case "message_start":
        if (message?.role === "user" && this.options.userMessagesFromEvents) {
          const text = contentText(message.content).trim();
          if (text) this.user(text);
        } else if (message?.role === "assistant") {
          this.streaming = this.assistant(undefined);
          this.add(this.streaming);
          this.streaming.updateContent(message as never, true);
        }
        break;
      case "message_update":
        if (this.streaming && message?.role === "assistant") {
          this.streaming.updateContent(message as never, true);
          for (const call of toolCalls(message)) {
            const existing = this.pendingTools.get(call.id);
            if (existing) existing.updateArgs(call.arguments);
            else this.pendingTools.set(call.id, this.tool(call));
          }
        }
        break;
      case "message_end":
        if (this.streaming && message?.role === "assistant") {
          this.streaming.updateContent(message as never, false);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
            for (const component of this.pendingTools.values()) {
              component.updateResult({ content: [{ type: "text", text }], isError: true } as never);
            }
            this.pendingTools.clear();
          } else {
            for (const component of this.pendingTools.values()) component.setArgsComplete();
          }
          this.streaming = undefined;
        }
        break;
      case "tool_execution_start": {
        if (event.parentToolCallId) break;
        const id = String(event.toolCallId ?? "");
        let component = this.pendingTools.get(id);
        if (!component) {
          component = this.tool({
            type: "toolCall",
            id,
            name: String(event.toolName ?? "tool"),
            arguments: event.args,
          });
          this.pendingTools.set(id, component);
        }
        component.markExecutionStarted();
        break;
      }
      case "tool_execution_update":
        this.pendingTools
          .get(String(event.toolCallId ?? ""))
          ?.updateResult({ ...(event.partialResult as object), isError: false } as never, true);
        break;
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        this.pendingTools
          .get(id)
          ?.updateResult({ ...(event.result as object), isError: event.isError === true } as never);
        this.pendingTools.delete(id);
        break;
      }
      case "agent_end":
        if (this.streaming) {
          this.container.removeChild(this.streaming);
          this.streaming = undefined;
        }
        this.pendingTools.clear();
        break;
      case "auto_retry_start":
        this.note(
          `Retrying after: ${typeof event.errorMessage === "string" ? event.errorMessage : "provider error"}`,
          "warning",
        );
        return;
      case "compaction_start":
        this.note("Compacting context…");
        return;
      default:
        return;
    }
    this.changed();
  }

  private assistant(message: Message | undefined) {
    return new AssistantMessageComponent(message as never, false, getMarkdownTheme());
  }

  private tool(call: ToolCall) {
    const ui = { requestRender: () => this.changed() } as never;
    const component = new ToolExecutionComponent(
      call.name,
      call.id,
      call.arguments,
      { showImages: false },
      this.renderers(call.name),
      ui,
      this.options.cwd,
    );
    component.setExpanded(this.expanded);
    this.add(component);
    return component;
  }

  /** The session's definition, with Pi's built-in renderers for what it leaves out (as Pi does). */
  private renderers(name: string): ToolRenderers | undefined {
    const definition = this.options.toolDefinition?.(name) as
      | (NonNullable<ToolRenderers> & { renderCall?: unknown; renderResult?: unknown })
      | undefined;
    this.builtIns ??= builtInRenderers(this.options.cwd);
    const builtIn = this.builtIns[name] as typeof definition;
    if (!definition) return builtIn;
    if (!builtIn) return definition;
    return {
      ...definition,
      renderCall: definition.renderCall ?? builtIn.renderCall,
      renderResult: definition.renderResult ?? builtIn.renderResult,
    } as ToolRenderers;
  }

  private add(component: Component) {
    this.container.addChild(component);
    const children = this.container.children;
    if (children.length > MAX_COMPONENTS) children.splice(0, children.length - MAX_COMPONENTS);
    this.changed();
  }

  private changed() {
    this.version += 1;
    this.options.requestRender?.();
  }
}

function builtInRenderers(cwd: string): Record<string, ToolRenderers> {
  const renderers: Record<string, ToolRenderers> = {};
  for (const create of [
    createReadToolDefinition,
    createBashToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ]) {
    try {
      const definition = create(cwd) as { name: string };
      renderers[definition.name] = definition as ToolRenderers;
    } catch {
      // A tool Pi cannot build here renders with the default renderer.
    }
  }
  return renderers;
}

function toolCalls(message: Message): ToolCall[] {
  return Array.isArray(message.content)
    ? (message.content as unknown[]).filter(
        (block): block is ToolCall => (block as { type?: unknown })?.type === "toolCall",
      )
    : [];
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}
