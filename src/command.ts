export interface CommandArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
  { value: "start", label: "start", description: "Start Plan mode without sending a prompt" },
  { value: "show", label: "show", description: "Show the ready, saved, or active plan" },
  { value: "finalize", label: "finalize", description: "Request a completed plan" },
  { value: "multi", label: "multi", description: "Plan with several models in parallel, then pick or synthesize" },
  {
    value: "compare",
    label: "compare",
    description: "Reopen candidate plans, or compare the ready plan with other models",
  },
  {
    value: "talk",
    label: "talk",
    description: "Talk to one planner (talk A), back to the main model (talk off), or stop replies (talk cancel)",
  },
  {
    value: "synthesize",
    label: "synthesize",
    description: "Merge candidate plans (synthesize A,B guidance)",
  },
  { value: "implement", label: "implement", description: "Implement the completed or saved plan" },
  { value: "save", label: "save", description: "Save the completed plan for later" },
  { value: "settings", label: "settings", description: "Open Plan mode settings" },
  { value: "export", label: "export", description: "Export the stored plan to a Markdown file" },
  { value: "exit", label: "exit", description: "Leave Plan mode or clear a saved/active plan" },
  { value: "off", label: "off", description: "Leave Plan mode or clear a saved/active plan" },
  {
    value: "tools",
    label: "tools",
    description: "Choose tools before starting this Plan workflow",
  },
];

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
  if (/\s/.test(prefix)) return null;

  const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
  return matches.length > 0 ? [...matches] : null;
}
