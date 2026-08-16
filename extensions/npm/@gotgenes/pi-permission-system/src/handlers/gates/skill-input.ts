import { renderLegacyMessage } from "#src/presentation/legacy-message";
import { buildSkillAskPayload } from "#src/presentation/skill-ask-payload";
import type { PermissionCheckResult } from "#src/types";
import type { GateDescriptor } from "./descriptor";
import { accessFactsFromValue } from "./helpers";

/**
 * Build a pure descriptor for the skill-input permission gate.
 *
 * Takes the pre-computed check result so the gate can reuse the result the
 * caller already obtained (e.g. to conditionally emit a deny warning) without
 * re-running the check inside the runner.
 */
export function describeSkillInputGate(
  skillName: string,
  agentName: string | null,
  preCheck: PermissionCheckResult,
): GateDescriptor {
  const payload = buildSkillAskPayload(skillName, agentName);
  const message = renderLegacyMessage(payload);
  return {
    surface: "skill",
    input: { name: skillName },
    preCheck,
    denialContext: {
      kind: "skill_input",
      skillName,
      agentName: agentName ?? undefined,
    },
    promptDetails: {
      source: "skill_input",
      agentName,
      message,
      payload,
      skillName,
      accessIntent: accessFactsFromValue("skill", skillName),
    },
    logContext: {
      source: "skill_input",
      skillName,
      agentName,
      message,
    },
    decision: {
      surface: "skill",
      value: skillName,
    },
  };
}
