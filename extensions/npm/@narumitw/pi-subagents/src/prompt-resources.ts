import {
	DefaultResourceLoader,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assertPiPromptSourcesAreReadableFiles } from "./prompt-source-safety.js";

export interface PiPromptResources {
	systemPrompt?: string;
	appendSystemPromptPaths: string[];
}

/** Resolve Pi-owned prompt files without loading target packages, extensions, or settings. */
export async function resolvePiPromptResources(
	cwd: string,
	projectTrusted: boolean,
	agentDir = getAgentDir(),
): Promise<PiPromptResources> {
	assertPiPromptSourcesAreReadableFiles(cwd, agentDir, projectTrusted, [
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
	]);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory({}, { projectTrusted }),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return {
		systemPrompt: loader.getSystemPrompt(),
		appendSystemPromptPaths: loader.getAppendSystemPromptSources().map((source) => source.path),
	};
}
