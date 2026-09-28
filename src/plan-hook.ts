import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ImplementationModelOverride } from "./implementation-models.js";

const HOOK_TIMEOUT_MS = 30_000;

export interface PlanCompleteHookInput {
  command: readonly string[];
  plan: string;
  cwd: string;
  model?: ImplementationModelOverride;
}

export function expandHome(value: string) {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/**
 * Run the configured plan-complete command with Claude Code PostToolUse-shaped JSON on stdin, so
 * hooks written for Claude's ExitPlanMode (such as saving plans to Obsidian) work unchanged. The
 * plan is written to a temporary file referenced by `tool_response.filePath`. Failures are
 * swallowed: saving a copy of a plan must never break planning.
 */
export async function runPlanCompleteHook(input: PlanCompleteHookInput): Promise<void> {
  const [executable, ...args] = input.command.map(expandHome);
  if (!executable) return;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "pi-plan-"));
    const filePath = join(directory, "plan.md");
    await writeFile(filePath, `${input.plan}\n`, { mode: 0o600 });
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "plan_mode_complete",
      cwd: input.cwd,
      tool_input: { plan: input.plan },
      tool_response: { filePath },
      ...(input.model ? { model: `${input.model.provider}/${input.model.modelId}` } : {}),
    });
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, args, { cwd: input.cwd, stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), HOOK_TIMEOUT_MS);
      timer.unref?.();
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(payload);
    });
  } catch {
    // Best effort.
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
