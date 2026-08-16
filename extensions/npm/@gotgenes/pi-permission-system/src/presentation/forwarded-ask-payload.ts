import type { ForwardedPermissionRequest } from "#src/authority/permission-forwarding";
import type { PromptPayload } from "#src/presentation/prompt-payload";

/**
 * Build the payload for an ask forwarded up from a subagent.
 *
 * The child still ships a pre-rendered sentence, so the serving node carries it
 * as a single evidence entry rather than inventing facts it was not sent: what
 * arrives is prose, and calling it anything else would be a fiction the
 * bounded renderers would then have to trust.
 *
 * When the payload replaces `message` on the wire, this builder projects the
 * child's own payload instead, and the serving node renders the child's facts
 * under its own budget — which is what makes a forwarded ask and a local one
 * consistent for the first time (ADR 0011 §2).
 *
 * A request missing a field renders from whatever it does carry: fail-closed
 * applies to presentation as it does to policy, so a version-skewed ask still
 * reaches the human rather than resolving without one (ADR 0011 §9).
 */
export function buildForwardedAskPayload(
  request: ForwardedPermissionRequest,
): PromptPayload {
  return {
    kind: "forwarded",
    request: {
      requester: {
        agentName: request.requesterAgentName,
        forwarded: true,
        sessionId: request.requesterSessionId,
      },
      // The child's display projection: what the ask was about, as the child's
      // own gate named it.
      surface: request.surface ?? "",
      toolName: null,
      invokedToolName: null,
      value: request.value ?? "",
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
    },
    evidence: [{ label: "requested", text: request.message, detail: null }],
    annotations: [],
  };
}
