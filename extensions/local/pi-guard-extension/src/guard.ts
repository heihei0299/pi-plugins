/**
 * Guard state machine for pi-guard-extension.
 *
 * Three states: normal → skill_active → guarded
 * Transitions are driven by input detection, agent_settled, and /guard:allow.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type GuardState = "normal" | "skill_active" | "guarded";

export interface GuardMachineOptions {
  /** List of skill names (without "/skill:" prefix) that trigger the guard. */
  targetSkills?: readonly string[];
}

export interface GuardMachine {
  /** Current state. */
  getState(): GuardState;
  /** Whether the guard is currently blocking tools. */
  isBlocking(): boolean;
  /** Check if a command string matches a target skill. */
  isTargetSkill(command: string): boolean;
  /** Process an input text to detect target skill commands. */
  handleInput(text: string): void;
  /** Handle agent_settled → transition to guarded if in skill_active. */
  handleAgentSettled(): void;
  /** Handle /guard:allow → transition to normal. */
  handleAllow(): void;
  /** Reset to normal state. */
  reset(): void;
  /** Rebuild state by scanning session history for target skill calls. */
  rebuildFromHistory(entries: readonly any[]): void;
}

// ── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_TARGET_SKILLS = [
  "to-spec",
  "to-tickets",
  "grill-me",
  "grill-with-docs",
  "wayfinder",
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract plain text content from a user/assistant message.
 *
 * Content can be:
 * - A plain string (returned as-is)
 * - An array of content parts (extract the first `type: "text"` part)
 * - null / undefined (return undefined)
 */
export function extractTextContent(
  content: string | ReadonlyArray<{ type: string; text?: string }> | null | undefined,
): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (typeof first === "object" && first !== null && "type" in first && first.type === "text") {
    return first.text;
  }
  return undefined;
}

// ── State machine factory ────────────────────────────────────────────────

export function createStateMachine(options?: GuardMachineOptions): GuardMachine {
  const targetSkills = options?.targetSkills ?? DEFAULT_TARGET_SKILLS;
  let state: GuardState = "normal";

  return {
    getState(): GuardState {
      return state;
    },

    isBlocking(): boolean {
      return state === "guarded";
    },

    isTargetSkill(command: string): boolean {
      for (const skill of targetSkills) {
        if (command === `/skill:${skill}`) return true;
      }
      return false;
    },

    handleInput(text: string): void {
      const extracted = extractTextContent(text) ?? text;
      const trimmed = extracted.trim();

      if (this.isTargetSkill(trimmed)) {
        state = "skill_active";
      }
      // Non-target-skill commands do not change state.
    },

    handleAgentSettled(): void {
      if (state === "skill_active") {
        state = "guarded";
      }
      // No-op in other states.
    },

    handleAllow(): void {
      state = "normal";
    },

    reset(): void {
      state = "normal";
    },

    rebuildFromHistory(entries: readonly any[]): void {
      for (const entry of entries) {
        // Duck-type: extract role and content from various entry shapes
        // SessionMessageEntry: { type: "message", message: { role, content } }
        // Test HistoryEntry: { role, content }
        const role = entry.role ?? entry.message?.role;
        if (role !== "user" && role !== "User") continue;

        // Try direct content field first, then message.content for SessionMessageEntry
        const rawContent = entry.content ?? entry.message?.content ?? "";
        const text = extractTextContent(rawContent) ?? "";
        const trimmed = text.trim();

        if (this.isTargetSkill(trimmed)) {
          state = "guarded";
          break; // Once we find one, we know we're in guarded territory.
        }
      }
    },
  };
}
