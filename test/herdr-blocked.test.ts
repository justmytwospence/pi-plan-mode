import assert from "node:assert/strict";
import { test } from "vitest";
import { HERDR_WORKING_CHANNEL, holdWorking, whileBlocked } from "../src/herdr-blocked.js";

test("whileBlocked emits active then inactive, also when the dialog throws", async () => {
  const seen: unknown[] = [];
  const events = { emit: (_channel: string, data: unknown) => seen.push(data) };
  assert.equal(await whileBlocked(events, "Q", async () => 7), 7);
  await assert.rejects(
    whileBlocked(events, "Q", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(seen, [
    { active: true, label: "Q" },
    { active: false },
    { active: true, label: "Q" },
    { active: false },
  ]);
});

test("whileBlocked survives a throwing listener and a missing bus", async () => {
  const events = {
    emit: () => {
      throw new Error("listener");
    },
  };
  assert.equal(await whileBlocked(events, "Q", async () => "ok"), "ok");
  assert.equal(await whileBlocked(undefined, "Q", async () => "ok"), "ok");
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
