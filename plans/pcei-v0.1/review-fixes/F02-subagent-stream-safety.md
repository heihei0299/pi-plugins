# F02 — Bound JSONL Line Memory and Preserve Transcript Structure

## Findings fixed

- F02 — unbounded `JsonlParser.pending` for a line without newline.
- F04 — transcript truncation can write partial JSON/UTF-8.

## Target repository

`heihei0299/pi-plugins`

## Goal

Complete the streaming safety boundary so that:

1. total stdout no longer needs whole-run buffering;
2. one malformed/huge JSONL line cannot consume unbounded memory;
3. a truncated transcript remains a sequence of complete UTF-8 JSONL lines rather than a partial byte fragment;
4. final-state parsing continues after transcript archiving stops.

## Read scope

Read only:

- `pi-locked-subagents/stream-parser.ts`;
- `pi-locked-subagents/runner.ts`;
- `pi-locked-subagents/runner.test.ts`;
- `pi-locked-subagents/README.md`.

## Problem 1 — single-line memory remains unbounded

The current parser appends every stdout chunk to:

```ts
private pending = "";
```

and only releases memory after a newline.

A worker can therefore emit an arbitrarily large line without `\n`, recreating an unbounded-memory failure even though total stdout is now streamed.

## Required repair

### 1. Add a hard JSONL line limit

Introduce an explicit `maxJsonLineBytes` (name may differ) as a protocol/resource limit.

Recommended default:

```text
8 MiB
```

It must be independent from:

- total transcript archive budget;
- parent output budget;
- stderr budget.

### 2. Enforce the line limit while chunks arrive

Do not wait until EOF/newline to discover that the line is huge.

The parser/runner must detect when the pending line exceeds the hard byte limit and stop the child with a deterministic failure reason such as:

```text
subagent JSONL line exceeded <N> bytes
```

The implementation must remain correct for UTF-8 strings and arbitrary chunk boundaries.

### 3. Keep normal large final output possible within the protocol limit

The parent-output limit is not the same as the line limit.

A final assistant result may exceed 24 KiB and still be valid; it should be persisted/projected by the existing parent-output mechanism as long as the full JSONL event remains under the protocol hard limit.

Do not accidentally reduce the line limit to `parentOutputMaxBytes`.

## Problem 2 — transcript archive can end in a partial line

Current transcript truncation writes:

```ts
bytes.subarray(0, remaining)
```

when the next complete line would exceed the archive budget.

That can produce:

- an incomplete JSON object;
- an incomplete UTF-8 code point;
- a file ending mid-line even though it is named `.jsonl`.

## Required repair

### 4. Archive complete lines only

For each **redacted complete line**:

- if the entire line (plus newline when present) fits, write it;
- otherwise write none of that line;
- set `transcriptTruncated = true`;
- stop archiving later lines;
- continue parsing stdout for the final state.

Do not partially write a line to fill the last few bytes.

### 5. Preserve the archive byte guarantee

The transcript file must remain:

```text
byteLength <= transcriptMaxBytes
```

No complete-line write may exceed that bound.

### 6. Clarify transcript semantics

Update README wording to state:

- transcript truncation preserves complete archived JSONL lines;
- once the archive budget is exhausted, later events may be absent from the transcript;
- parsing still continues so the child can complete normally.

## Tests to add/update when execution is authorized

1. a line split over many chunks below the line limit succeeds;
2. a line exceeding `maxJsonLineBytes` before newline fails deterministically without unbounded growth;
3. a >24 KiB but <line-limit final result still succeeds and is parent-projected;
4. transcript budget ending in the middle of the next line does not write any fragment of that line;
5. transcript remains valid UTF-8 after truncation;
6. every archived non-empty line parses as JSON in the test fixture;
7. parsing continues after archive truncation and still captures final `message_end`.

Do not run tests without explicit authorization.

## Static verification

Confirm:

- `pending` has a hard byte ceiling;
- the ceiling is enforced during `push`, not only at `finish`;
- the runner converts parser overflow into a controlled child failure;
- transcript writes are line-atomic relative to the archive budget;
- no partial Buffer slice is used for transcript truncation;
- archive exhaustion does not stop normal stdout parsing.

## Non-goals

Do not add:

- LLM summarization;
- transcript recall/search;
- new reviewer policies;
- generic stream infrastructure for unrelated plugins.

## Acceptance criteria

- [ ] One no-newline line cannot grow memory without bound.
- [ ] The hard line limit is configurable through the runner limit structure.
- [ ] Normal projected final output still works below the line hard cap.
- [ ] Transcript truncation never writes partial JSONL lines.
- [ ] Transcript truncation never intentionally writes partial UTF-8.
- [ ] Final-state parsing continues after transcript archive exhaustion.

## Commit

Use one repair commit:

```text
fix(subagents): harden JSONL stream bounds
```

Stop after the commit.
