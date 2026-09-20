# PCEI v0.1 — Post-Implementation Review

## Reviewed revisions

### pi-plugins

Branch: `plan/pcei-v0.1`

Reviewed implementation commits:

- `90757e7c8b5a5bfeff49fbd1c4dbe622fb048afe` — `feat: add passive context audit extension`
- `6d4f922d64a72c1fd7454760cdc1868786a917a9` — `fix: stream locked subagent output`

### matt-skills

Branch: `main`

Reviewed implementation commit:

- `3b8216e054bacdd92cff8a17e430e4645ea37263` — `fix: scope TDD startup context to current issue`

## Review scope

This review is limited to PCEI v0.1 behavior.

It does not audit unrelated repository architecture, old code, package policy, model routing, or existing external optimizer plugins.

## Result

The implementation direction is correct, but several bounded fixes are required before treating PCEI v0.1 as complete.

### Findings

| ID | Severity | Target | Finding |
|---|---|---|---|
| F01 | HIGH | pi-locked-subagents | Failure responses bypass the 24 KiB parent-output budget. A large `errorMessage` or up to 256 KiB retained stderr can still be injected into the parent tool result. |
| F02 | HIGH | pi-locked-subagents | `JsonlParser.pending` has no single-line limit. A worker that emits a huge line without `\n` can grow memory without bound despite the streaming rewrite. |
| F03 | MEDIUM | pi-locked-subagents | stderr is truncated before redaction. If a secret crosses the retained-byte boundary, a secret prefix can survive because the complete secret string is no longer present when final redaction runs. |
| F04 | MEDIUM | pi-locked-subagents | Transcript truncation can write a partial JSONL line / partial UTF-8 byte sequence, leaving a file named `.jsonl` structurally invalid. |
| F05 | MEDIUM | pi-context-audit | `Estimated input` overstates the measurement scope. The extension measures message content only; it does not include system prompt sections, tool schemas, or provider framing. |
| F06 | LOW | pi-context-audit | Tool records are tagged with the last already-existing snapshot, but the tool result normally contributes to the following model context. The current `snapshot #N` wording implies the wrong association. |
| F07 | MEDIUM | matt-skills | The new current-issue rule is correct, but `references/orchestration.md` still says to read every issue's `Blocked by`. Without a targeted-metadata rule, an agent can still open full future issue bodies while building the dependency graph. |

## Passed areas

The review found no repair requirement for these parts:

- `pi-context-audit` does not register an LLM-callable tool.
- Its `context` hook does not replace messages.
- It keeps snapshot/tool-record collections bounded.
- It does not retain complete tool-result payloads.
- `pi-locked-subagents` no longer buffers the entire stdout event stream in `stdoutChunks`.
- A cumulative event stream over 1 MiB no longer directly triggers the old stdout kill.
- Final assistant output is redacted before normal success projection/sidecar persistence.
- Timeout and abort process-group termination semantics remain present.
- TDD `SKILL.md` now explicitly scopes startup to the current issue and forbids duplicate Skill reads merely for confirmation.
- The TDD change did not reintroduce automatic code-review into `tdd-implement`.

## Repair tickets

Execute the repair tickets independently:

1. `F01-subagent-parent-boundary.md`
   - fixes F01, F03 and the parent-facing diagnostic boundary;
2. `F02-subagent-stream-safety.md`
   - fixes F02 and F04;
3. `F03-context-audit-semantics.md`
   - fixes F05 and F06;
4. `F04-tdd-orchestration-scope.md`
   - fixes F07 in `matt-skills`.

Do not merge these into a larger redesign.

## Execution contract

For each repair ticket:

- read this summary plus the current ticket only;
- do not pre-read later repair tickets;
- do not delegate implementation to a subagent;
- keep implementation strictly inside the ticket scope;
- perform one static self-review;
- perform the repository's normal formal review only when required by the user's workflow;
- build/test/typecheck/lint still require explicit user authorization;
- make one repair commit, then stop.
