import type { BashCommandContext } from "#src/types";

/**
 * The complete, structured description of a permission ask (ADR 0011 §2).
 *
 * A gate emits one of these instead of a sentence. It is complete by contract:
 * it never truncates and never decides what a human will see. Every consumer is
 * a renderer over it, eliding under its own budget — so elision is a property
 * of a render, never of the payload.
 */
export interface PromptPayload {
  readonly kind: PromptPayloadKind;
  readonly request: PromptRequestFacts;
  /** Complete; each renderer elides to fit its own budget. */
  readonly evidence: readonly PromptEvidence[];
  /** Supplied by registered annotators; always marked as model-generated. */
  readonly annotations: readonly PromptAnnotation[];
}

/**
 * Which ask this payload describes — the renderers' dispatch discriminant.
 *
 * Present because the ask shapes are not separable by surface alone: a tool
 * external-directory ask and a bash one share the `external_directory` surface,
 * and the `path` gate and the per-tool gate differ only in wording. It mirrors
 * `DenialContext`'s discriminated union, the shape ADR 0011 §7 names as already
 * correct, and gives every renderer an exhaustive switch rather than a set of
 * string comparisons a new variant sails past.
 */
export type PromptPayloadKind =
  | "bash"
  | "mcp"
  | "tool"
  | "path"
  | "external_directory"
  | "bash_external_directory"
  | "skill"
  | "skill_read"
  | "forwarded";

/**
 * The invariant core (ADR 0011 §3): the facts visible in every render, that no
 * renderer's budget may elide.
 *
 * Named for what it holds — the permission request's own facts, matching the
 * package's `PermissionRequest` / `ForwardedPermissionRequest` vocabulary —
 * rather than for its contract, which this comment states instead.
 */
export interface PromptRequestFacts {
  /** Who is asking, and whether the ask arrived from a subagent. */
  readonly requester: PromptRequester;
  /** The gate surface the rule fired on. */
  readonly surface: string;
  /** The gated tool name; `null` when the ask is not tool-shaped. */
  readonly toolName: string | null;
  /**
   * The invoked tool name when a shell alias re-exposes bash under another
   * name (#574) — "gated as bash, invoked as exec_command" is two facts.
   * `null` when it adds nothing.
   */
  readonly invokedToolName: string | null;
  /** The decision-relevant value: the command, path, MCP target, or skill name. */
  readonly value: string;
  /** The matched rule, including a sentinel such as `<indirection-bash-wrapper>`. */
  readonly matchedPattern: string | null;
  /**
   * Where the offending bash unit runs, when it came from a substitution or a
   * subshell. A fact rather than a rendered clause: it is what makes the
   * matched rule intelligible, and how it reads is the renderer's choice.
   */
  readonly commandContext: BashCommandContext | null;
  /**
   * For bash, the unit that will actually run — including inside an unstrippable
   * wrapper (#713). `null` when it adds nothing over {@link value}.
   */
  readonly executedUnit: string | null;
}

/** Who is asking, one hop below when the ask was forwarded. */
export interface PromptRequester {
  readonly agentName: string | null;
  readonly forwarded: boolean;
  /** The requesting session, for a forwarded ask; `null` for a local one. */
  readonly sessionId: string | null;
}

/**
 * One piece of decision evidence.
 *
 * Complete on the payload; each renderer elides entries and orders them under
 * its own budget (ADR 0011 §4).
 */
export interface PromptEvidence {
  readonly label: string;
  readonly text: string;
  /**
   * A secondary fact bound to this entry that a renderer may show alongside
   * {@link text} or elide independently — a path's symlink-resolved alias, for
   * instance. Bound to the entry rather than listed as a second one so an
   * elision cannot separate the two.
   */
  readonly detail: string | null;
}

/**
 * A model-generated advisory (ADR 0011 §8).
 *
 * The slot owns the attribution and the model-generated marking, so marking is
 * a property of the payload rather than a discipline each annotator must
 * remember. Structurally separate from any verdict: an annotation cannot allow,
 * deny, defer, or suppress.
 */
export interface PromptAnnotation {
  readonly source: string;
  readonly text: string;
}

/** The `requester` facts for an ask raised by this session. */
export function localRequester(agentName: string | null): PromptRequester {
  return { agentName, forwarded: false, sessionId: null };
}

/** Find the evidence entry a renderer knows by label. */
export function findEvidence(
  payload: PromptPayload,
  label: string,
): PromptEvidence | undefined {
  return payload.evidence.find((entry) => entry.label === label);
}

/** Every evidence entry carrying the given label, in payload order. */
export function allEvidence(
  payload: PromptPayload,
  label: string,
): readonly PromptEvidence[] {
  return payload.evidence.filter((entry) => entry.label === label);
}
