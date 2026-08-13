export const AUTOMATION_BENCHMARK_VERSION = "pi-subagents:workflow-planning-benchmark:v1" as const;

export const AUTOMATION_BENCHMARK_ARMS = [
	"strong-single-agent",
	"one-child",
	"caller-authored-workflow",
	"fixed-two-child",
	"equal-budget-best-of-n",
	"automation-compiled",
] as const;

export type AutomationBenchmarkArm = (typeof AUTOMATION_BENCHMARK_ARMS)[number];

export interface AutomationBenchmarkProtocol {
	version: typeof AUTOMATION_BENCHMARK_VERSION;
	model: string;
	evaluator: string;
	taskIds: string[];
	pairedSeeds: number[];
	maxTokens: number;
	maxCost: number;
	maxWallClockMs: number;
	maxMutatingChildren: number;
	maxRecursiveDepth: number;
	arms: AutomationBenchmarkArm[];
}

export interface AutomationBenchmarkAdapter {
	arm: AutomationBenchmarkArm;
	model: string;
	evaluator: string;
	maxTokens: number;
	maxCost: number;
	maxWallClockMs: number;
	mutatingChildren: number;
	recursiveDepth: number;
	informationPolicy: "identical-repository-context";
	toolPolicy: "matched-authority-ceiling";
}

export interface AutomationBenchmarkDryRun {
	version: typeof AUTOMATION_BENCHMARK_VERSION;
	pairedInstances: number;
	arms: AutomationBenchmarkArm[];
	valid: true;
}

export function validateAutomationBenchmark(
	protocol: AutomationBenchmarkProtocol,
	adapters: AutomationBenchmarkAdapter[],
): AutomationBenchmarkDryRun {
	if (protocol.version !== AUTOMATION_BENCHMARK_VERSION) {
		throw new Error("Unsupported automation benchmark protocol");
	}
	if (protocol.taskIds.length < 1 || protocol.pairedSeeds.length < 2) {
		throw new Error("Automation benchmark requires tasks and repeated paired seeds");
	}
	if (protocol.maxMutatingChildren !== 2 || protocol.maxRecursiveDepth !== 0) {
		throw new Error("Automation benchmark width and depth must remain two and zero");
	}
	const arms = [...new Set(protocol.arms)].sort();
	if (
		arms.length !== AUTOMATION_BENCHMARK_ARMS.length ||
		AUTOMATION_BENCHMARK_ARMS.some((arm) => !arms.includes(arm))
	) {
		throw new Error("Automation benchmark must include every frozen comparison arm");
	}
	for (const arm of AUTOMATION_BENCHMARK_ARMS) {
		const adapter = adapters.find((candidate) => candidate.arm === arm);
		if (!adapter) throw new Error(`Missing automation benchmark adapter ${arm}`);
		if (
			adapter.model !== protocol.model ||
			adapter.evaluator !== protocol.evaluator ||
			adapter.maxTokens !== protocol.maxTokens ||
			adapter.maxCost !== protocol.maxCost ||
			adapter.maxWallClockMs !== protocol.maxWallClockMs ||
			adapter.informationPolicy !== "identical-repository-context" ||
			adapter.toolPolicy !== "matched-authority-ceiling"
		) {
			throw new Error(`Automation benchmark adapter ${arm} violates matched resources`);
		}
		if (
			adapter.mutatingChildren > protocol.maxMutatingChildren ||
			adapter.recursiveDepth > protocol.maxRecursiveDepth
		) {
			throw new Error(`Automation benchmark adapter ${arm} exceeds width or depth`);
		}
	}
	return {
		version: AUTOMATION_BENCHMARK_VERSION,
		pairedInstances: protocol.taskIds.length * protocol.pairedSeeds.length,
		arms: [...AUTOMATION_BENCHMARK_ARMS],
		valid: true,
	};
}
