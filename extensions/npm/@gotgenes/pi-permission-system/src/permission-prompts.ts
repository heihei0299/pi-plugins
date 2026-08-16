import { classifyToolKind } from "./access-intent/tool-kind";

// NOTE: the ask prompts are now payload builders under src/presentation/;
// denial text lives in denial-messages.ts. This module retains only the
// pre-check reasons, which are agent-facing rather than user-facing.

export function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

export function formatUnknownToolReason(
  toolName: string,
  availableToolNames: readonly string[],
): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList =
    preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint =
    classifyToolKind(toolName) === "mcp"
      ? ""
      : ' If this was intended as an MCP server tool, call the registered \'mcp\' tool when available (for example: {"tool":"server:tool"}).';

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}
