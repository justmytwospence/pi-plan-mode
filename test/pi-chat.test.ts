import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { PiChat, piChatTheme } from "../src/app/pi-chat.js";
import { PlannerAgent } from "../src/planner/agent.js";
import { consultMessage } from "../src/planner/prompt.js";
import { PLANNER_SEED_END_ENTRY } from "../src/planners.js";

initTheme("dark");

const text = (chat: PiChat, width = 80) =>
  chat
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");

test("a chat draws a session's events with Pi's own components", () => {
  const chat = new PiChat(piChatTheme, { cwd: "/repo" });
  const reply = {
    role: "assistant",
    content: [
      { type: "text", text: "## Findings\n\nThe cache is **unbounded**." },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/cache.ts" } },
    ],
    stopReason: "toolUse",
  };
  chat.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  chat.apply({ type: "message_update", message: reply });
  chat.apply({ type: "message_end", message: reply });
  chat.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/cache.ts" } });
  chat.apply({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read",
    result: { content: [{ type: "text", text: "export const cache = new Map();" }] },
  });
  chat.user("why unbounded?", "main agent");
  chat.note("Plan A submitted.");
  const shown = text(chat);
  assert.match(shown, /Findings/u);
  assert.doesNotMatch(shown, /## Findings|\*\*unbounded\*\*/u, "Markdown is rendered");
  assert.match(shown, /read.*src\/cache\.ts/u, "the tool call as Pi draws it");
  assert.match(shown, /main agent ›/u);
  assert.match(shown, /why unbounded\?/u);
  assert.match(shown, /• Plan A submitted\./u);
});

test("a restored planner's chat shows what was said since its task", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-chat-"));
  const manager = SessionManager.create("/repo", dir);
  manager.appendMessage({ role: "user", content: "your earlier conversation", timestamp: 1 } as never);
  manager.appendCustomEntry(PLANNER_SEED_END_ENTRY, {});
  manager.appendMessage({ role: "user", content: "THE TASK PROMPT", timestamp: 2 } as never);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Here is my thinking about the cache." }],
    stopReason: "stop",
    timestamp: 3,
  } as never);
  manager.appendMessage({ role: "user", content: consultMessage("is it safe?"), timestamp: 4 } as never);
  const file = manager.getSessionFile();
  assert.ok(file);
  const planner = new PlannerAgent({
    id: "A",
    spec: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    name: "Claude Sonnet 5.5",
    cwd: "/repo",
    access: { tools: [], extensions: [], skills: [], policy: {} as never, systemPrompt: [] },
    timeoutMs: 0,
    sessionDir: dir,
    seed: [],
    sessionFile: file,
    onChange: () => undefined,
  });
  const shown = text(planner.chat);
  assert.match(shown, /Here is my thinking about the cache\./u);
  assert.match(shown, /main agent ›/u);
  assert.match(shown, /is it safe\?/u);
  assert.doesNotMatch(shown, /THE TASK PROMPT|your earlier conversation|From the user's main agent/u);
  assert.match(shown, /A restored\./u);
});
