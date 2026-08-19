import type { Ruleset } from "./rule";
import type { SessionApproval } from "./session-approval";
import type { SessionApprovalRecorder } from "./session-approval-recorder";

/**
 * Ephemeral in-memory store of session-scoped permission approvals.
 *
 * Each approval is stored as a `Rule` with `action: "allow"`, making the
 * ruleset directly usable with `evaluate()` — no custom matching engine needed.
 *
 * Cleared on session_shutdown — never persisted to disk.
 */
export class SessionRules implements SessionApprovalRecorder {
  private rules: Ruleset = [];

  /** Record a wildcard pattern as approved for the given surface. */
  approve(surface: string, pattern: string): void {
    this.rules.push({
      surface,
      pattern,
      action: "allow",
      layer: "session",
      origin: "session",
    });
  }

  /** Return a defensive copy of the current session ruleset. */
  getRuleset(): Ruleset {
    return [...this.rules];
  }

  /**
   * Record all patterns from a `SessionApproval` value object.
   *
   * The loop lives here so callers never need to know whether an approval
   * carries one pattern or many — they just tell the store to record it.
   */
  recordSessionApproval(approval: SessionApproval): void {
    for (const pattern of approval.patterns) {
      this.approve(approval.surface, pattern);
    }
  }

  /** Remove all session approvals. */
  clear(): void {
    this.rules = [];
  }
}
