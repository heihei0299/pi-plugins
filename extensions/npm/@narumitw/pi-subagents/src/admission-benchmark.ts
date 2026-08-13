export const ADMISSION_BENCHMARK_VERSION = "pi-subagents:admission-benchmark:v1" as const;

export const ADMISSION_BENCHMARK_ARMS = [
	"strong-single",
	"one-child",
	"equal-budget-best-of-n",
	"naive-parallel",
	"fixed-two-child",
	"admission-selected",
] as const;

export type AdmissionBenchmarkArm = (typeof ADMISSION_BENCHMARK_ARMS)[number];

export interface AdmissionBenchmarkProtocol {
	version: typeof ADMISSION_BENCHMARK_VERSION;
	model: string;
	evaluator: string;
	taskIds: string[];
	pairedSeeds: number[];
	maxTokens: number;
	maxCost: number;
	maxWallClockMs: number;
	maxRetries: number;
	maxMutatingChildren: number;
	maxRecursiveDepth: number;
	arms: AdmissionBenchmarkArm[];
}

export interface AdmissionBenchmarkAdapter {
	arm: AdmissionBenchmarkArm;
	model: string;
	evaluator: string;
	maxTokens: number;
	maxCost: number;
	maxWallClockMs: number;
	maxRetries: number;
	mutatingChildren: number;
	recursiveDepth: number;
}

export interface AdmissionBenchmarkDryRun {
	version: typeof ADMISSION_BENCHMARK_VERSION;
	pairedInstances: number;
	arms: AdmissionBenchmarkArm[];
	valid: true;
}

export function validateAdmissionBenchmark(
	protocol: AdmissionBenchmarkProtocol,
	adapters: AdmissionBenchmarkAdapter[],
): AdmissionBenchmarkDryRun {
	if (protocol.version !== ADMISSION_BENCHMARK_VERSION) {
		throw new Error("Unsupported admission benchmark protocol");
	}
	if (protocol.taskIds.length < 1 || protocol.pairedSeeds.length < 2) {
		throw new Error("Admission benchmark requires tasks and repeated paired seeds");
	}
	if (
		protocol.maxMutatingChildren < 0 ||
		protocol.maxMutatingChildren > 2 ||
		protocol.maxRecursiveDepth !== 0
	) {
		throw new Error("Admission benchmark permits at most two mutating children and no recursion");
	}
	const expectedArms = [...new Set(protocol.arms)].sort();
	if (expectedArms.length !== ADMISSION_BENCHMARK_ARMS.length) {
		throw new Error("Admission benchmark must declare every comparison arm");
	}
	for (const arm of ADMISSION_BENCHMARK_ARMS) {
		const adapter = adapters.find((candidate) => candidate.arm === arm);
		if (!adapter) throw new Error(`Missing admission benchmark adapter: ${arm}`);
		if (
			adapter.model !== protocol.model ||
			adapter.evaluator !== protocol.evaluator ||
			adapter.maxTokens !== protocol.maxTokens ||
			adapter.maxCost !== protocol.maxCost ||
			adapter.maxWallClockMs !== protocol.maxWallClockMs ||
			adapter.maxRetries !== protocol.maxRetries
		) {
			throw new Error(`Admission benchmark adapter ${arm} violates matched resources`);
		}
		if (
			adapter.mutatingChildren > protocol.maxMutatingChildren ||
			adapter.recursiveDepth > protocol.maxRecursiveDepth
		) {
			throw new Error(`Admission benchmark adapter ${arm} exceeds width or depth`);
		}
	}
	return {
		version: ADMISSION_BENCHMARK_VERSION,
		pairedInstances: protocol.taskIds.length * protocol.pairedSeeds.length,
		arms: [...ADMISSION_BENCHMARK_ARMS],
		valid: true,
	};
}
