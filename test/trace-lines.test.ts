import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { TraceRenderer } from "../src/app/trace-lines.js";
import { PlannerTrace } from "../src/planner-trace.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as never;
const plain = (line: string) => stripVTControlCharacters(line).trimEnd();

initTheme("dark");

test("an agent's replies in a trace render as Markdown, not raw markup", () => {
  const trace = new PlannerTrace();
  trace.text("## Where they disagree\n\n| | A | B |\n|---|---|---|\n| **Default** | On | Off |\n\nSome `code` here.");
  const lines = new TraceRenderer(theme).lines(trace, 60).map(plain);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /^## /mu, "the heading marker is gone");
  assert.doesNotMatch(text, /\*\*Default\*\*/u, "bold is styled, not starred");
  assert.doesNotMatch(text, /\|---\|/u, "the table is drawn, not left as pipes");
  assert.match(text, /Where they disagree/u);
  assert.match(text, /Default/u);
});
