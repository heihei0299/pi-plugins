export const VERIFIED_EXECUTION_BENCHMARK_VERSION =
	"pi-subagents:verified-execution-benchmark:v1" as const;

export interface VerifiedExecutionBenchmarkCase {
	id: string;
	shouldAccept: boolean;
	workerSelfReport: boolean;
	independentVerifier: boolean;
	exactTreeVerification: boolean;
	workerCostUnits: number;
	verifierCostUnits: number;
	deterministicCostUnits: number;
}

export interface VerifiedExecutionBenchmarkArmResult {
	arm: "worker-self-report" | "independent-verifier" | "deterministic-exact-tree";
	falseAcceptances: number;
	falseRejections: number;
	accepted: number;
	costUnits: number;
	addedCostUnits: number;
}

export interface VerifiedExecutionBenchmarkResult {
	version: typeof VERIFIED_EXECUTION_BENCHMARK_VERSION;
	matchedCases: number;
	arms: VerifiedExecutionBenchmarkArmResult[];
	qualityClaim: false;
}

export function evaluateVerifiedExecutionBenchmark(
	cases: readonly VerifiedExecutionBenchmarkCase[],
): VerifiedExecutionBenchmarkResult {
	if (cases.length < 1 || new Set(cases.map((item) => item.id)).size !== cases.length) {
		throw new Error("Verified execution benchmark requires unique matched cases");
	}
	for (const item of cases) {
		if (
			!item.id ||
			[item.workerCostUnits, item.verifierCostUnits, item.deterministicCostUnits].some(
				(value) => !Number.isFinite(value) || value < 0,
			)
		) {
			throw new Error("Verified execution benchmark contains invalid bounded cost evidence");
		}
	}
	const baselineCost = cases.reduce((sum, item) => sum + item.workerCostUnits, 0);
	const arm = (
		name: VerifiedExecutionBenchmarkArmResult["arm"],
		accepted: (item: VerifiedExecutionBenchmarkCase) => boolean,
		cost: (item: VerifiedExecutionBenchmarkCase) => number,
	): VerifiedExecutionBenchmarkArmResult => {
		const acceptedCases = cases.filter(accepted);
		const costUnits = cases.reduce((sum, item) => sum + cost(item), 0);
		return {
			arm: name,
			falseAcceptances: acceptedCases.filter((item) => !item.shouldAccept).length,
			falseRejections: cases.filter((item) => item.shouldAccept && !accepted(item)).length,
			accepted: acceptedCases.length,
			costUnits,
			addedCostUnits: costUnits - baselineCost,
		};
	};
	return {
		version: VERIFIED_EXECUTION_BENCHMARK_VERSION,
		matchedCases: cases.length,
		arms: [
			arm(
				"worker-self-report",
				(item) => item.workerSelfReport,
				(item) => item.workerCostUnits,
			),
			arm(
				"independent-verifier",
				(item) => item.independentVerifier,
				(item) => item.workerCostUnits + item.verifierCostUnits,
			),
			arm(
				"deterministic-exact-tree",
				(item) => item.exactTreeVerification,
				(item) => item.workerCostUnits + item.verifierCostUnits + item.deterministicCostUnits,
			),
		],
		qualityClaim: false,
	};
}
