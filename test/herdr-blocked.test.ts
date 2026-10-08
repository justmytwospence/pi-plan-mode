import assert from "node:assert/strict";
import { test } from "vitest";
import { HERDR_BLOCKED_CHANNEL, HERDR_WORKING_CHANNEL, holdBlocked, holdWorking } from "../src/herdr-blocked.js";

test("holdBlocked holds herdr:blocked until released, once", () => {
  const seen: [string, unknown][] = [];
  const release = holdBlocked({ emit: (channel, data) => seen.push([channel, data]) }, "Planner question");
  release();
  release();
  assert.deepEqual(seen, [
    [HERDR_BLOCKED_CHANNEL, { active: true, label: "Planner question" }],
    [HERDR_BLOCKED_CHANNEL, { active: false }],
  ]);
});

test("holdWorking emits one active/inactive pair however often it is released", () => {
  const seen: [string, unknown][] = [];
  const release = holdWorking({ emit: (channel, data) => seen.push([channel, data]) }, "Planning");
  release();
  release();
  assert.deepEqual(seen, [
    [HERDR_WORKING_CHANNEL, { active: true, label: "Planning" }],
    [HERDR_WORKING_CHANNEL, { active: false }],
  ]);
  const throwing = {
    emit: () => {
      throw new Error("listener");
    },
  };
  holdWorking(throwing, "x")();
  holdWorking(undefined, "x")();
});
