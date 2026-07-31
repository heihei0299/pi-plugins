import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { classifyPlanModeTool, isBuiltinTool } from "./tool-policy.js";

export function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
	const directName = tools.find((tool) => tool.name === key)?.name;
	if (directName) return directName;
	const [name] = key.split("\u001f");
	return tools.find((tool) => tool.name === name) ? name : undefined;
}

export function compareTools(left: ToolInfo, right: ToolInfo) {
	const leftBuiltin = isBuiltinTool(left);
	const rightBuiltin = isBuiltinTool(right);
	if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
	return left.name.localeCompare(right.name);
}

export function toolPolicyLabel(tool: ToolInfo) {
	const policy = classifyPlanModeTool(tool);
	if (policy === "read-only") return "built-in read-only";
	if (policy === "limited") return "built-in limited";
	if (policy === "blocked") return "built-in blocked";
	return `user opt-in: ${toolSourceLabel(tool)}`;
}

function toolSourceLabel(tool: ToolInfo) {
	const sourceInfo = tool.sourceInfo;
	const source = `${sourceInfo.scope}/${sourceInfo.source}`;
	return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

export function unique(values: string[]) {
	return Array.from(new Set(values));
}
