# F01 — Bound All Subagent Parent-Facing Diagnostics

## Findings fixed

- F01 — failure responses bypass the parent-output budget.
- F03 — stderr truncation can occur before secret redaction.

## Target repository

`heihei0299/pi-plugins`

Target branch: current PCEI implementation branch.

## Goal

Make the subagent → parent context boundary consistent:

> No success or failure path may inject more than the configured parent-output budget solely because the child returned a large final message, error message, or stderr payload.

At the same time, preserve useful diagnostics locally and do not weaken secret redaction.

## Read scope

Read only:

- `pi-locked-subagents/runner.ts`;
- `pi-locked-subagents/index.ts`;
- `pi-locked-subagents/runner.test.ts`;
- `pi-locked-subagents/README.md`.

Do not inspect or change other extensions.

## Problem 1 — failure path bypasses the parent budget

The success path projects `result.finalOutput` to `parentOutputMaxBytes`.

The failure path currently selects:

```text
failureReason
errorMessage
protocolError
stderr
finalOutput
```

and interpolates the selected value directly into the parent tool result.

Consequences:

- retained stderr may be as large as `stderrMaxBytes` (default 256 KiB);
- `errorMessage` is not independently parent-bounded;
- therefore a failed subagent can inject much more context than a successful one.

## Required repair

### 1. Establish one parent-facing text budget

All human/model-visible diagnostic text returned by the `subagent` tool must be bounded by `parentOutputMaxBytes` (or by one clearly documented equivalent budget derived from it).

Do not create different unexplained limits for success and failure.

### 2. Preserve full oversized diagnostics locally

If the selected failure diagnostic exceeds the parent budget:

- persist the complete **redacted** diagnostic to a restricted sidecar file in the existing run directory;
- return a bounded head/tail preview;
- include a clear projection marker;
- expose the sidecar path in tool `details`.

Reuse existing projection/persistence behavior where possible instead of building a second independent mechanism.

### 3. Keep structural failure metadata visible

The parent response should still contain compact structural information such as:

```text
Subagent "<name>" failed
exit=<...>
stop=<...>
reason=<short reason>
Transcript: <path>
Diagnostic: <sidecar path if projected>
```

Do not spend most of the budget repeating fixed boilerplate.

### 4. Fix stderr redaction ordering

Current behavior bounds stderr first and redacts the retained prefix later. That can leak a secret prefix when the secret begins before the byte cap but ends after it.

Implement a boundary-safe approach.

A minimal acceptable design:

- retain raw stderr only within a bounded window large enough to cover `stderrMaxBytes + longestSensitiveValueLength` (plus a small fixed safety margin if needed);
- after collection, redact the buffered text;
- only then truncate the **redacted** result to `stderrMaxBytes`.

This remains bounded and handles secrets crossing both chunk and retention boundaries.

An alternative streaming redactor is acceptable only if it is smaller and demonstrably correct.

Do not store unbounded raw stderr.

### 5. Sidecar contents must already be redacted

Never write the unredacted selected failure diagnostic to disk.

The same sensitive environment values used for transcript/final-output redaction apply to diagnostic sidecars.

## Tests to add/update when execution is authorized

Focused cases:

1. stderr larger than `parentOutputMaxBytes` on a failing child does not exceed parent budget;
2. oversized `errorMessage` does not exceed parent budget;
3. projected failure diagnostic has a local sidecar containing the complete redacted diagnostic;
4. a secret beginning immediately before the stderr retention boundary is fully redacted;
5. a secret split across stderr chunks is fully redacted;
6. normal short failures remain readable without unnecessary sidecars;
7. existing success projection still works.

Do not run tests without explicit authorization.

## Static verification

Confirm:

- every path returning `content[].text` from the subagent tool is parent-bounded;
- no error branch can inject the raw 256 KiB stderr buffer;
- unredacted diagnostic text is never persisted;
- stderr memory remains bounded;
- existing timeout/abort/protocol semantics are unchanged.

## Non-goals

Do not change:

- model/provider selection;
- reviewer prompts;
- tool isolation;
- transcript JSONL parser;
- transcript archive limit;
- TDD workflow;
- generic Pi tool output.

## Acceptance criteria

- [ ] Success output remains parent-bounded.
- [ ] Failure output is also parent-bounded.
- [ ] Oversized failure diagnostics remain locally retrievable.
- [ ] Failure sidecars contain redacted text only.
- [ ] Secret values cannot leak merely because stderr was truncated at the byte boundary.
- [ ] stderr collection remains memory-bounded.
- [ ] Existing failure classification semantics are preserved.

## Commit

Use one repair commit:

```text
fix(subagents): bound parent failure diagnostics
```

Stop after the commit.
