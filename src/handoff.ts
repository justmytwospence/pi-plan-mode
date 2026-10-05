/** The message that hands a plan to the implementing session. */
export function formatImplementationPrompt(plan: string, fresh: boolean) {
  const destination = fresh ? " in a fresh context" : "";
  return `A planner produced the plan below to accomplish the user's task. Implement the plan${destination}. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.\n\n${plan}`;
}
