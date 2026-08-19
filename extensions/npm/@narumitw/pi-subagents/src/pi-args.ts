import type { SubagentThinkingLevel } from "./agents/types.js";

export interface PiArgsOptions {
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tools?: string[];
	disableExtensions?: boolean;
	disableSkills?: boolean;
	disablePromptTemplates?: boolean;
	disableContextFiles?: boolean;
	projectTrust?: boolean;
	baseSystemPromptPath?: string;
	appendSystemPromptPaths?: string[];
	extensionPaths?: string[];
	/** Existing single append prompt path retained for compatibility. */
	systemPromptPath?: string;
	task: string;
}

export function buildPiArgs(options: PiArgsOptions): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.disableExtensions) args.push("--no-extensions");
	for (const extensionPath of options.extensionPaths ?? []) args.push("-e", extensionPath);
	if (options.disableSkills) args.push("--no-skills");
	if (options.disablePromptTemplates) args.push("--no-prompt-templates");
	if (options.disableContextFiles) args.push("--no-context-files");
	if (options.projectTrust !== undefined) {
		args.push(options.projectTrust ? "--approve" : "--no-approve");
	}
	if (Array.isArray(options.tools)) {
		if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
		else args.push("--no-tools");
	}
	if (options.baseSystemPromptPath) args.push("--system-prompt", options.baseSystemPromptPath);
	for (const promptPath of options.appendSystemPromptPaths ?? []) {
		args.push("--append-system-prompt", promptPath);
	}
	if (options.systemPromptPath) args.push("--append-system-prompt", options.systemPromptPath);
	args.push(`Task: ${options.task}`);
	return args;
}
