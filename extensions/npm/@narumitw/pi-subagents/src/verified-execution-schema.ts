import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const VerificationCheckSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
		}),
		command: StringEnum(["git", "node", "npm", "npx"] as const),
		args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 })),
		cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
	},
	{ additionalProperties: false },
);

export const VerifiedExecutionContractSchema = Type.Object(
	{
		verifierAgent: Type.String({ minLength: 1, maxLength: 256 }),
		maxReworkCycles: Type.Optional(Type.Integer({ minimum: 0, maximum: 1, default: 1 })),
		checks: Type.Optional(Type.Array(VerificationCheckSchema, { maxItems: 32 })),
	},
	{
		additionalProperties: false,
		description:
			"Explicitly gate mutating workflow success on executor-owned deterministic checks, one least-authority independent verifier, exact submitted-state identity, and managed integration acceptance.",
	},
);

export type VerifiedExecutionContract = Static<typeof VerifiedExecutionContractSchema>;
