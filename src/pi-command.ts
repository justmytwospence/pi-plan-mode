import { basename } from "node:path";

/** Resolve how to launch the same Pi CLI that is running this extension. */
export function piSpawnCommand(): { command: string; args: string[] } {
  const override = process.env.PI_PLAN_MODE_PI_BINARY?.trim();
  if (override) return { command: override, args: [] };
  const entry = process.argv[1];
  const exec = process.execPath;
  if (basename(exec).replace(/\.exe$/iu, "") === "pi") return { command: exec, args: [] };
  if (entry && /(?:^|[/\\])(?:pi|cli\.[cm]?js)$/u.test(entry)) return { command: exec, args: [entry] };
  return { command: "pi", args: [] };
}
