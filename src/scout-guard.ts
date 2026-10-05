// Inside a scout (a `pi --mode json` subprocess a planner starts), this package rides along only to
// enforce the MCP allowlist the planner was given.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkMcpResourceCall, checkMcpTool, isMcpToolName, MCP_RESOURCE_TOOLS, mcpToolIdentity } from "./mcp-tools.js";

export function installScoutGuard(pi: ExtensionAPI, allow: readonly string[]) {
  pi.on("tool_call", (event) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    let verdict: { allowed: true } | { allowed: false; reason: string } | undefined;
    if (MCP_RESOURCE_TOOLS.has(event.toolName) && tool?.sourceInfo.path === "builtin:mcp") {
      verdict = checkMcpResourceCall(event.input, allow);
    } else {
      const identity = mcpToolIdentity(tool);
      if (identity) verdict = checkMcpTool(identity, allow);
      else if (isMcpToolName(event.toolName) && !tool) {
        verdict = { allowed: false, reason: `MCP tool '${event.toolName}' is not registered.` };
      }
    }
    return verdict && !verdict.allowed ? { block: true, reason: verdict.reason } : undefined;
  });
}
