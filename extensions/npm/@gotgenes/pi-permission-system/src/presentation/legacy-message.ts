import { matchQualifier, resolvesToSuffix } from "#src/denial-messages";
import {
  allEvidence,
  findEvidence,
  type PromptPayload,
} from "#src/presentation/prompt-payload";

/**
 * Render the flat `message` string every consumer still reads.
 *
 * Transitional, and deliberately the *only* place that string is produced: it
 * reads nothing but the payload, so the existing prompt-text tests are the
 * proof that the payload carries everything the six former assemblers said.
 *
 * The bounded renderers replace it consumer by consumer — the dialog and the
 * fallback first, then the wire and the broadcast, then the review log — and
 * this module goes when the last `message` reader does. Its coupling to the
 * evidence labels the builders emit is the price of that byte-for-byte
 * equivalence, and it is why it is scoped to the transition.
 */
export function renderLegacyMessage(payload: PromptPayload): string {
  const { request } = payload;
  const subject = request.requester.agentName
    ? `Agent '${request.requester.agentName}'`
    : "Current agent";

  switch (payload.kind) {
    case "bash":
      return `${subject} requested bash command '${request.value}'${bashQualifier(payload)}${fullCommandSuffix(payload)}. Allow this command?`;
    case "mcp":
      return `${subject} requested MCP target '${request.value}'${patternSuffix(payload)}${inputSuffix(payload)}. Allow this call?`;
    case "tool":
      return `${subject} requested tool '${request.value}'${patternSuffix(payload)}${inputSuffix(payload)}. Allow this call?`;
    case "path":
      return `${subject} requested tool '${request.toolName}' for path '${request.value}'. Allow this path access?`;
    case "external_directory":
      return `${subject} requested tool '${request.toolName}' for path '${request.value}'${resolvedSuffix(payload)} outside working directory '${workingDirectory(payload)}'. Allow this external directory access?`;
    case "bash_external_directory":
      return `${subject} requested bash command '${request.value}' which references path(s) outside working directory '${workingDirectory(payload)}': ${externalPathList(payload)}. Allow this external directory access?`;
    case "skill":
      return `${subject} requested skill '${request.value}'. Allow loading this skill?`;
    case "skill_read":
      return `${subject} requested access to skill '${request.value}' via '${textOf(payload, "read path")}'. Allow this read?`;
    case "forwarded":
      return renderForwarded(payload);
  }
}

// ── Per-kind fragments ──────────────────────────────────────────────────────

/** The bash parenthetical: the matched rule plus, when nested, its context. */
function bashQualifier(payload: PromptPayload): string {
  const qualifier = matchQualifier(
    payload.request.matchedPattern ?? undefined,
    payload.request.commandContext ?? undefined,
  );
  return qualifier ? ` ${qualifier}` : "";
}

/** ` (matched '<pattern>')` for the non-bash surfaces. */
function patternSuffix(payload: PromptPayload): string {
  const { matchedPattern } = payload.request;
  return matchedPattern ? ` (matched '${matchedPattern}')` : "";
}

/** The enclosing command, when the gated unit is only part of it. */
function fullCommandSuffix(payload: PromptPayload): string {
  const full = findEvidence(payload, "full command");
  return full ? ` (full command: '${full.text}')` : "";
}

/** The per-tool input preview, when the formatter produced one. */
function inputSuffix(payload: PromptPayload): string {
  const preview = findEvidence(payload, "input");
  return preview ? ` ${preview.text}` : "";
}

/** ` (resolves to '<canonical>')` when the alias names a distinct location. */
function resolvedSuffix(payload: PromptPayload): string {
  return resolvesToSuffix(findEvidence(payload, "resolves to")?.text);
}

/** The comma-joined external paths, each with its canonical alias. */
function externalPathList(payload: PromptPayload): string {
  return allEvidence(payload, "external path")
    .map(
      (entry) => `${entry.text}${resolvesToSuffix(entry.detail ?? undefined)}`,
    )
    .join(", ");
}

function workingDirectory(payload: PromptPayload): string {
  return textOf(payload, "working directory");
}

/**
 * The child's ask, prefixed with its provenance.
 *
 * Until the payload replaces `message` on the wire, a forwarded request carries
 * the child's pre-rendered sentence, which arrives as a single evidence entry.
 */
function renderForwarded(payload: PromptPayload): string {
  const { requester } = payload.request;
  return [
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: a version-skewed request carries "" rather than null
    `Subagent '${requester.agentName || "unknown"}' requested permission.`,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: a version-skewed request carries "" rather than null
    `Session ID: ${requester.sessionId || "unknown"}`,
    "",
    textOf(payload, "requested"),
  ].join("\n");
}

/** The text of an evidence entry the render requires, or the empty string. */
function textOf(payload: PromptPayload, label: string): string {
  return findEvidence(payload, label)?.text ?? "";
}
