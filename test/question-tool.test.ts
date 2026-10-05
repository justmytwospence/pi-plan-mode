import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizePlanModeQuestionParams, type PlanModeQuestion } from "../src/question-tool.js";

const questions: PlanModeQuestion[] = [
  {
    id: "scope",
    header: "Scope",
    question: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  },
];

test("normalizePlanModeQuestionParams validates question shape without changing schema", () => {
  const result = normalizePlanModeQuestionParams({ questions: [questions[0]] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
  assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
    ok: false,
    error: "questions must contain 1-3 items",
  });
});
