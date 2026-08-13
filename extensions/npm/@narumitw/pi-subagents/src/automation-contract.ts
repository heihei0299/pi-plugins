import { createHash } from "node:crypto";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { MAX_SUBAGENT_TIMEOUT_MS } from "./limits.js";

export const AUTOMATION_REQUEST_VERSION = "pi-subagents:automation-request:v1" as const;
export const WORKFLOW_PLAN_VERSION = "pi-subagents:workflow-plan:v1" as const;
export const WORKFLOW_PLAN_PATCH_VERSION = "pi-subagents:workflow-plan-patch:v1" as const;
export const MAX_AUTOMATION_TASKS = 8;
export const MAX_AUTOMATION_REVISIONS = 3;
export const MAX_AUTOMATION_TEXT_BYTES = 16 * 1024;
export const MAX_AUTOMATION_ITEMS = 20;
const MAX_ITEM_BYTES = 4 * 1024;
const MAX_ITEMS = MAX_AUTOMATION_ITEMS;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_BUDGET_TURNS = 1_000;
const MAX_BUDGET_TOOL_CALLS = 2_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/u;
const PRIVATE_MARKER_PATTERN = /<\/?private(?:\s|>)|\[subagent-private\]/iu;

const SideEffectSchema = StringEnum(["read-only", "idempotent", "mutating"] as const);
const AuthorityRequirementSchema = StringEnum(["unspecified", "denied", "required"] as const);
const ItemSchema = Type.String({ minLength: 1, maxLength: MAX_ITEM_BYTES });
const ItemListSchema = Type.Array(ItemSchema, { maxItems: MAX_ITEMS });
const PathListSchema = Type.Array(Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }), {
	maxItems: MAX_ITEMS,
});

const AggregateBudgetSchema = Type.Object(
	{
		timeoutMs: Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_TIMEOUT_MS }),
		maxTurns: Type.Integer({ minimum: 1, maximum: MAX_BUDGET_TURNS }),
		maxToolCalls: Type.Integer({ minimum: 1, maximum: MAX_BUDGET_TOOL_CALLS }),
		maxTasks: Type.Integer({ minimum: 1, maximum: MAX_AUTOMATION_TASKS }),
		maxRevisions: Type.Integer({ minimum: 0, maximum: MAX_AUTOMATION_REVISIONS }),
	},
	{ additionalProperties: false },
);

const TaskBudgetSchema = Type.Object(
	{
		timeoutMs: Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_TIMEOUT_MS }),
		maxTurns: Type.Integer({ minimum: 1, maximum: MAX_BUDGET_TURNS }),
		maxToolCalls: Type.Integer({ minimum: 1, maximum: MAX_BUDGET_TOOL_CALLS }),
	},
	{ additionalProperties: false },
);

export const AutomationRequestSchema = Type.Object(
	{
		version: Type.Literal(AUTOMATION_REQUEST_VERSION),
		objective: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_TEXT_BYTES }),
		nonGoals: ItemListSchema,
		requiredInputs: ItemListSchema,
		acceptanceCriteria: Type.Array(ItemSchema, { minItems: 1, maxItems: MAX_ITEMS }),
		requiredEvidence: ItemListSchema,
		authorityCeiling: Type.Object(
			{
				capabilities: ItemListSchema,
				tools: ItemListSchema,
				readPaths: PathListSchema,
				writePaths: PathListSchema,
				network: AuthorityRequirementSchema,
				secrets: AuthorityRequirementSchema,
				sideEffectPolicy: SideEffectSchema,
			},
			{ additionalProperties: false },
		),
		aggregateBudget: AggregateBudgetSchema,
		constraints: Type.Object(
			{
				contextPressure: StringEnum(["low", "medium", "high"] as const),
				maxMutatingWidth: Type.Integer({ minimum: 1, maximum: 2 }),
				requireVerification: Type.Boolean(),
				workspaceMode: StringEnum(["shared", "worktree"] as const),
				allowedAgents: Type.Optional(ItemListSchema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const ArtifactSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		kind: Type.String({ minLength: 1, maxLength: 128 }),
		version: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);

export const WorkflowPlanTaskSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		objective: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_TEXT_BYTES }),
		dependsOn: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
			maxItems: MAX_AUTOMATION_TASKS,
		}),
		inputArtifacts: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
			maxItems: MAX_ITEMS,
		}),
		producesArtifacts: Type.Array(ArtifactSchema, { maxItems: MAX_ITEMS }),
		sideEffectPolicy: SideEffectSchema,
		readPaths: PathListSchema,
		writePaths: PathListSchema,
		ownershipKeys: ItemListSchema,
		requiredCapabilities: ItemListSchema,
		requiredTools: ItemListSchema,
		requiredVerificationRole: Type.Optional(ItemSchema),
		acceptanceCriteria: Type.Array(ItemSchema, { minItems: 1, maxItems: MAX_ITEMS }),
		requiredEvidence: ItemListSchema,
		integrationOwner: Type.Boolean(),
		verifierFor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		preferredCostHint: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
		preferredLatencyHint: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
		budget: TaskBudgetSchema,
		guarantees: Type.Optional(
			Type.Object(
				{ network: AuthorityRequirementSchema, secrets: Type.Optional(AuthorityRequirementSchema) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const WorkflowPlanSchema = Type.Object(
	{
		version: Type.Literal(WORKFLOW_PLAN_VERSION),
		requestVersion: Type.Literal(AUTOMATION_REQUEST_VERSION),
		summary: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_TEXT_BYTES }),
		missingInputs: ItemListSchema,
		risks: ItemListSchema,
		tasks: Type.Array(WorkflowPlanTaskSchema, {
			minItems: 1,
			maxItems: MAX_AUTOMATION_TASKS,
		}),
	},
	{ additionalProperties: false },
);

const PatchTaskSchema = WorkflowPlanTaskSchema;
const PatchOperationSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("add-task"), task: PatchTaskSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("replace-task"),
			taskId: Type.String({ minLength: 1, maxLength: 128 }),
			task: PatchTaskSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("add-dependency"),
			taskId: Type.String({ minLength: 1, maxLength: 128 }),
			dependsOn: Type.String({ minLength: 1, maxLength: 128 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("cancel-task"),
			taskId: Type.String({ minLength: 1, maxLength: 128 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("request-verification"),
			taskId: Type.String({ minLength: 1, maxLength: 128 }),
			verifier: PatchTaskSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("invalidate-downstream"),
			taskId: Type.String({ minLength: 1, maxLength: 128 }),
			reason: ItemSchema,
		},
		{ additionalProperties: false },
	),
]);

export const WorkflowPlanPatchSchema = Type.Object(
	{
		version: Type.Literal(WORKFLOW_PLAN_PATCH_VERSION),
		planId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		workflowGeneration: Type.Integer({ minimum: 0 }),
		reason: ItemSchema,
		operations: Type.Array(PatchOperationSchema, { minItems: 1, maxItems: MAX_AUTOMATION_TASKS }),
	},
	{ additionalProperties: false },
);

export type AutomationRequest = Static<typeof AutomationRequestSchema>;
export type WorkflowPlanTask = Static<typeof WorkflowPlanTaskSchema>;
export type WorkflowPlan = Static<typeof WorkflowPlanSchema>;
export type WorkflowPlanPatch = Static<typeof WorkflowPlanPatchSchema>;
export type WorkflowPlanPatchOperation = WorkflowPlanPatch["operations"][number];

export function parseAutomationRequest(value: unknown): AutomationRequest {
	const object = strictObject(value, "automation request");
	assertOnlyKeys(object, [
		"version",
		"objective",
		"nonGoals",
		"requiredInputs",
		"acceptanceCriteria",
		"requiredEvidence",
		"authorityCeiling",
		"aggregateBudget",
		"constraints",
	]);
	if (object.version !== AUTOMATION_REQUEST_VERSION) {
		throw new Error("Unsupported automation request version");
	}
	const parsed = parseBySchemaShape(object, "automation request") as AutomationRequest;
	validateRequest(parsed);
	return structuredClone(parsed);
}

export function parseWorkflowPlan(value: string | unknown): WorkflowPlan {
	let decoded: unknown = value;
	if (typeof value === "string") {
		try {
			decoded = JSON.parse(value);
		} catch {
			throw new Error("Workflow plan contains invalid JSON");
		}
	}
	const object = strictObject(decoded, "workflow plan");
	for (const key of ["planId", "workflowGeneration", "executionPlanId", "selectedAgent"]) {
		if (key in object) throw new Error(`Workflow plan contains executor-owned field ${key}`);
	}
	assertOnlyKeys(object, [
		"version",
		"requestVersion",
		"summary",
		"missingInputs",
		"risks",
		"tasks",
	]);
	if (
		object.version !== WORKFLOW_PLAN_VERSION ||
		object.requestVersion !== AUTOMATION_REQUEST_VERSION
	) {
		throw new Error("Unsupported workflow plan version");
	}
	if (!Array.isArray(object.tasks) || object.tasks.length < 1) {
		throw new Error("Workflow plan requires at least one task");
	}
	if (object.tasks.length > MAX_AUTOMATION_TASKS)
		throw new Error("Workflow plan has too many tasks");
	const parsed = parseBySchemaShape(object, "workflow plan") as WorkflowPlan;
	validatePlan(parsed);
	return structuredClone(parsed);
}

export function parseWorkflowPlanPatch(value: string | unknown): WorkflowPlanPatch {
	let decoded: unknown = value;
	if (typeof value === "string") {
		try {
			decoded = JSON.parse(value);
		} catch {
			throw new Error("Workflow plan patch contains invalid JSON");
		}
	}
	const object = strictObject(decoded, "workflow plan patch");
	assertOnlyKeys(object, ["version", "planId", "workflowGeneration", "reason", "operations"]);
	if (object.version !== WORKFLOW_PLAN_PATCH_VERSION) {
		throw new Error("Unsupported workflow plan patch version");
	}
	if (!Number.isSafeInteger(object.workflowGeneration) || Number(object.workflowGeneration) < 0) {
		throw new Error("Workflow plan patch has invalid generation");
	}
	if (typeof object.planId !== "string" || !PLAN_ID_PATTERN.test(object.planId)) {
		throw new Error("Workflow plan patch has invalid plan identity");
	}
	const parsed = parseBySchemaShape(object, "workflow plan patch") as WorkflowPlanPatch;
	for (const operation of parsed.operations) {
		if (operation.type === "add-task" || operation.type === "replace-task") {
			validateTaskSafety(operation.task);
		} else if (operation.type === "request-verification") {
			validateTaskSafety(operation.verifier);
		}
	}
	validateSafeValue(parsed, "workflow plan patch");
	return structuredClone(parsed);
}

export function workflowPlanIdentity(
	plan: WorkflowPlan,
	generation: number,
	revision: number,
): string {
	return createHash("sha256").update(JSON.stringify({ plan, generation, revision })).digest("hex");
}

function validateRequest(request: AutomationRequest): void {
	for (const scope of [
		...request.authorityCeiling.readPaths,
		...request.authorityCeiling.writePaths,
	]) {
		validateRelativePath(scope);
	}
	validateSafeValue(request, "automation request");
	if (
		request.authorityCeiling.network !== "unspecified" ||
		request.authorityCeiling.secrets !== "unspecified"
	) {
		throw new Error("Automation request asks for an unsupported network or secrets guarantee");
	}
}

function validatePlan(plan: WorkflowPlan): void {
	const byId = new Map<string, WorkflowPlanTask>();
	const artifactProducer = new Map<string, string>();
	for (const task of plan.tasks) {
		validateTaskSafety(task);
		if (byId.has(task.id)) throw new Error(`Duplicate workflow task id ${task.id}`);
		byId.set(task.id, task);
		for (const artifact of task.producesArtifacts) {
			if (artifactProducer.has(artifact.id))
				throw new Error(`Duplicate artifact id ${artifact.id}`);
			artifactProducer.set(artifact.id, task.id);
		}
	}
	for (const task of plan.tasks) {
		for (const dependency of task.dependsOn) {
			if (!ID_PATTERN.test(dependency))
				throw new Error("Workflow task has an invalid dependency id");
			if (!byId.has(dependency)) {
				throw new Error(`Workflow task ${task.id} has a missing dependency`);
			}
		}
		if (task.verifierFor && !byId.has(task.verifierFor)) {
			throw new Error(`Workflow verifier ${task.id} targets missing task ${task.verifierFor}`);
		}
		for (const artifact of task.inputArtifacts) {
			const producer = artifactProducer.get(artifact);
			if (!producer || !task.dependsOn.includes(producer)) {
				throw new Error(`Workflow task ${task.id} has missing artifact dependency ${artifact}`);
			}
		}
	}
	assertAcyclic(plan.tasks);
	assertOwnershipCompatible(plan.tasks);
	validateSafeValue(plan, "workflow plan");
}

function validateTaskSafety(task: WorkflowPlanTask): void {
	if (!ID_PATTERN.test(task.id)) throw new Error("Workflow task has an invalid id");
	if (
		task.dependsOn.some((id) => !ID_PATTERN.test(id)) ||
		task.inputArtifacts.some((id) => !ID_PATTERN.test(id)) ||
		(task.verifierFor !== undefined && !ID_PATTERN.test(task.verifierFor)) ||
		task.producesArtifacts.some(
			(artifact) =>
				!ID_PATTERN.test(artifact.id) ||
				!ID_PATTERN.test(artifact.kind) ||
				!ID_PATTERN.test(artifact.version),
		)
	) {
		throw new Error(`Workflow task ${task.id} has an invalid dependency or artifact identity`);
	}
	for (const scope of [...task.readPaths, ...task.writePaths]) validateRelativePath(scope);
	if (task.sideEffectPolicy === "read-only" && task.writePaths.length > 0) {
		throw new Error(`Read-only workflow task ${task.id} declares write paths`);
	}
	if (task.guarantees && Object.values(task.guarantees).some((value) => value !== "unspecified")) {
		throw new Error(`Workflow task ${task.id} requests an unsupported guarantee`);
	}
}

function assertAcyclic(tasks: readonly WorkflowPlanTask[]): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string) => {
		if (visiting.has(id)) throw new Error(`Workflow dependency cycle includes ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks) visit(task.id);
}

function assertOwnershipCompatible(tasks: readonly WorkflowPlanTask[]): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const dependsTransitively = (
		taskId: string,
		possibleAncestor: string,
		seen = new Set<string>(),
	): boolean => {
		if (seen.has(taskId)) return false;
		seen.add(taskId);
		for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
			if (
				dependency === possibleAncestor ||
				dependsTransitively(dependency, possibleAncestor, seen)
			) {
				return true;
			}
		}
		return false;
	};
	for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
			const left = tasks[leftIndex];
			const right = tasks[rightIndex];
			if (
				left.ownershipKeys.some((key) => right.ownershipKeys.includes(key)) &&
				!dependsTransitively(left.id, right.id) &&
				!dependsTransitively(right.id, left.id)
			) {
				throw new Error(`Workflow tasks ${left.id} and ${right.id} have conflicting ownership`);
			}
		}
	}
}

function parseBySchemaShape(value: Record<string, unknown>, label: string): unknown {
	if (label === "automation request") {
		validateRequiredObject(value.authorityCeiling, "authorityCeiling", [
			"capabilities",
			"tools",
			"readPaths",
			"writePaths",
			"network",
			"secrets",
			"sideEffectPolicy",
		]);
		validateRequiredObject(value.aggregateBudget, "aggregateBudget", [
			"timeoutMs",
			"maxTurns",
			"maxToolCalls",
			"maxTasks",
			"maxRevisions",
		]);
		validateRequiredObject(value.constraints, "constraints", [
			"contextPressure",
			"maxMutatingWidth",
			"requireVerification",
			"workspaceMode",
			"allowedAgents",
		]);
		validateString(value.objective, "objective", MAX_AUTOMATION_TEXT_BYTES);
		validateStringList(value.nonGoals, "nonGoals");
		validateStringList(value.requiredInputs, "requiredInputs");
		validateStringList(value.acceptanceCriteria, "acceptanceCriteria", true);
		validateStringList(value.requiredEvidence, "requiredEvidence");
		const ceiling = value.authorityCeiling as Record<string, unknown>;
		validateStringList(ceiling.capabilities, "capabilities");
		validateStringList(ceiling.tools, "tools");
		validateStringList(ceiling.readPaths, "readPaths");
		validateStringList(ceiling.writePaths, "writePaths");
		if (!["unspecified", "denied", "required"].includes(String(ceiling.network)))
			throw new Error("Invalid network authority ceiling");
		if (!["unspecified", "denied", "required"].includes(String(ceiling.secrets)))
			throw new Error("Invalid secrets authority ceiling");
		if (!["read-only", "idempotent", "mutating"].includes(String(ceiling.sideEffectPolicy)))
			throw new Error("Invalid side-effect authority ceiling");
		const budget = value.aggregateBudget as Record<string, unknown>;
		validateBudget(budget, true);
		const constraints = value.constraints as Record<string, unknown>;
		if (!["low", "medium", "high"].includes(String(constraints.contextPressure)))
			throw new Error("Invalid context pressure");
		if (
			!Number.isSafeInteger(constraints.maxMutatingWidth) ||
			Number(constraints.maxMutatingWidth) < 1 ||
			Number(constraints.maxMutatingWidth) > 2
		)
			throw new Error("Invalid mutating width");
		if (typeof constraints.requireVerification !== "boolean")
			throw new Error("Invalid verification constraint");
		if (!["shared", "worktree"].includes(String(constraints.workspaceMode)))
			throw new Error("Invalid workspace mode");
		if (constraints.allowedAgents !== undefined)
			validateStringList(constraints.allowedAgents, "allowedAgents");
		return value;
	}
	if (label === "workflow plan") {
		validateString(value.summary, "summary", MAX_AUTOMATION_TEXT_BYTES);
		validateStringList(value.missingInputs, "missingInputs");
		validateStringList(value.risks, "risks");
		for (const raw of value.tasks as unknown[]) validateTask(strictObject(raw, "workflow task"));
		return value;
	}
	validateString(value.reason, "reason", MAX_ITEM_BYTES);
	if (
		!Array.isArray(value.operations) ||
		value.operations.length < 1 ||
		value.operations.length > MAX_AUTOMATION_TASKS
	)
		throw new Error("Invalid workflow plan patch operations");
	for (const raw of value.operations) validatePatchOperation(strictObject(raw, "patch operation"));
	return value;
}

function validateTask(task: Record<string, unknown>): void {
	assertOnlyKeys(task, [
		"id",
		"objective",
		"dependsOn",
		"inputArtifacts",
		"producesArtifacts",
		"sideEffectPolicy",
		"readPaths",
		"writePaths",
		"ownershipKeys",
		"requiredCapabilities",
		"requiredTools",
		"requiredVerificationRole",
		"acceptanceCriteria",
		"requiredEvidence",
		"integrationOwner",
		"verifierFor",
		"preferredCostHint",
		"preferredLatencyHint",
		"budget",
		"guarantees",
	]);
	validateString(task.id, "task id", 128);
	validateString(task.objective, "task objective", MAX_AUTOMATION_TEXT_BYTES);
	for (const field of [
		"dependsOn",
		"inputArtifacts",
		"readPaths",
		"writePaths",
		"ownershipKeys",
		"requiredCapabilities",
		"requiredTools",
		"acceptanceCriteria",
		"requiredEvidence",
	] as const)
		validateStringList(task[field], field, field === "acceptanceCriteria");
	if (!Array.isArray(task.producesArtifacts) || task.producesArtifacts.length > MAX_ITEMS)
		throw new Error("Invalid task artifacts");
	for (const raw of task.producesArtifacts) {
		const artifact = strictObject(raw, "artifact");
		assertOnlyKeys(artifact, ["id", "kind", "version"]);
		validateString(artifact.id, "artifact id", 128);
		validateString(artifact.kind, "artifact kind", 128);
		validateString(artifact.version, "artifact version", 128);
	}
	if (!["read-only", "idempotent", "mutating"].includes(String(task.sideEffectPolicy)))
		throw new Error("Invalid task side-effect policy");
	if (typeof task.integrationOwner !== "boolean") throw new Error("Invalid integration owner");
	for (const field of ["requiredVerificationRole", "verifierFor"] as const)
		if (task[field] !== undefined) validateString(task[field], field, MAX_ITEM_BYTES);
	for (const field of ["preferredCostHint", "preferredLatencyHint"] as const)
		if (task[field] !== undefined && !["low", "medium", "high"].includes(String(task[field])))
			throw new Error(`Invalid ${field}`);
	validateRequiredObject(task.budget, "task budget", ["timeoutMs", "maxTurns", "maxToolCalls"]);
	validateBudget(task.budget as Record<string, unknown>, false);
	if (task.guarantees !== undefined) {
		validateRequiredObject(task.guarantees, "guarantees", ["network", "secrets"]);
		const guarantees = task.guarantees as Record<string, unknown>;
		for (const value of Object.values(guarantees))
			if (!["unspecified", "denied", "required"].includes(String(value)))
				throw new Error("Invalid task guarantee");
	}
}

function validatePatchOperation(operation: Record<string, unknown>): void {
	const type = operation.type;
	if (type === "add-task") {
		assertOnlyKeys(operation, ["type", "task"]);
		validateTask(strictObject(operation.task, "patch task"));
		return;
	}
	if (type === "replace-task") {
		assertOnlyKeys(operation, ["type", "taskId", "task"]);
		validateString(operation.taskId, "taskId", 128);
		validateTask(strictObject(operation.task, "patch task"));
		return;
	}
	if (type === "add-dependency") {
		assertOnlyKeys(operation, ["type", "taskId", "dependsOn"]);
		validateString(operation.taskId, "taskId", 128);
		validateString(operation.dependsOn, "dependsOn", 128);
		return;
	}
	if (type === "cancel-task") {
		assertOnlyKeys(operation, ["type", "taskId"]);
		validateString(operation.taskId, "taskId", 128);
		return;
	}
	if (type === "request-verification") {
		assertOnlyKeys(operation, ["type", "taskId", "verifier"]);
		validateString(operation.taskId, "taskId", 128);
		validateTask(strictObject(operation.verifier, "patch verifier"));
		return;
	}
	if (type === "invalidate-downstream") {
		assertOnlyKeys(operation, ["type", "taskId", "reason"]);
		validateString(operation.taskId, "taskId", 128);
		validateString(operation.reason, "reason", MAX_ITEM_BYTES);
		return;
	}
	throw new Error("Unsupported workflow plan patch operation");
}

function validateBudget(budget: Record<string, unknown>, aggregate: boolean): void {
	const limits: Record<string, number> = {
		timeoutMs: MAX_SUBAGENT_TIMEOUT_MS,
		maxTurns: MAX_BUDGET_TURNS,
		maxToolCalls: MAX_BUDGET_TOOL_CALLS,
		...(aggregate
			? { maxTasks: MAX_AUTOMATION_TASKS, maxRevisions: MAX_AUTOMATION_REVISIONS }
			: {}),
	};
	for (const [field, max] of Object.entries(limits)) {
		const value = budget[field];
		const minimum = field === "maxRevisions" ? 0 : 1;
		if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > max)
			throw new Error(`Invalid ${field} budget`);
	}
}

function validateRequiredObject(value: unknown, label: string, keys: readonly string[]): void {
	const object = strictObject(value, label);
	assertOnlyKeys(object, keys);
}

function validateStringList(value: unknown, label: string, requireOne = false): void {
	if (!Array.isArray(value) || value.length > MAX_ITEMS || (requireOne && value.length < 1))
		throw new Error(`Invalid ${label}`);
	for (const item of value) validateString(item, label, MAX_ITEM_BYTES);
}

function validateString(value: unknown, label: string, maxBytes: number): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
	if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} is too large`);
}

function validateSafeValue(value: unknown, label: string): void {
	const visit = (candidate: unknown): void => {
		if (typeof candidate === "string") {
			if (containsTerminalControl(candidate)) {
				throw new Error(`${label} contains terminal control bytes`);
			}
			if (PRIVATE_MARKER_PATTERN.test(candidate)) {
				throw new Error(`${label} contains private data markers`);
			}
			return;
		}
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (candidate && typeof candidate === "object") {
			for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
		}
	};
	visit(value);
}

function validateRelativePath(value: string): void {
	if (
		Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
		containsTerminalControl(value) ||
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		value.split("/").includes("..")
	) {
		throw new Error(`Invalid workflow path ${JSON.stringify(value.slice(0, 128))}`);
	}
	const normalized = path.posix.normalize(value.trim());
	if (!normalized || normalized === ".." || normalized.startsWith("../"))
		throw new Error("Invalid workflow path");
}

function containsTerminalControl(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f)
		) {
			return true;
		}
	}
	return false;
}

function strictObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected) throw new Error("Unknown field in versioned automation contract");
}
