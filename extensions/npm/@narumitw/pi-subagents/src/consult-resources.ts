import type { ConsultResourcePolicy } from "./agents/types.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { resolvePiPromptResources } from "./prompt-resources.js";
import type { ChildLaunchPolicy } from "./runner.js";

const MINIMAL_CONSULT_SYSTEM_PROMPT =
	"You are a read-only consultation assistant. Analyze the delegated task using only executor-provided capabilities and return a grounded answer.";

/**
 * Resolve Pi-owned prompt files without loading target settings, packages, or extensions.
 * The child still owns context-file, skill, and prompt-template loading according to this policy.
 */
export async function resolveConsultResourceLaunchPolicy(
	policy: ConsultResourcePolicy,
	projectTrusted: boolean,
	cwd: string,
): Promise<ChildLaunchPolicy> {
	if (policy === "none") {
		return {
			disableExtensions: true,
			disableSkills: true,
			disablePromptTemplates: true,
			disableContextFiles: true,
			projectTrust: false,
			baseSystemPrompt: MINIMAL_CONSULT_SYSTEM_PROMPT,
		};
	}

	const resources = await resolvePiPromptResources(cwd, projectTrusted);
	const discoveredSystemPrompt = resources.systemPrompt;
	const baseSystemPrompt = discoveredSystemPrompt
		? truncateUtf8(discoveredSystemPrompt, DEFAULT_MAX_CONTEXT_BYTES).text
		: undefined;
	const appendSystemPromptPaths = resources.appendSystemPromptPaths;
	const shared = {
		disableExtensions: true,
		disableContextFiles: !projectTrusted,
		projectTrust: projectTrusted,
		baseSystemPrompt,
		appendSystemPromptPaths:
			appendSystemPromptPaths.length > 0 ? appendSystemPromptPaths : undefined,
	};
	if (policy === "project-context") {
		return {
			...shared,
			disableSkills: true,
			disablePromptTemplates: true,
		};
	}
	return shared;
}
