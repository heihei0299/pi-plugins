# T03 — Stream pi-locked-subagents Output

## Target repository

`heihei0299/pi-plugins`

## Goal

Fix the confirmed `pi-locked-subagents` failure mode where the child process JSONL stdout is buffered in memory and the child is terminated once stdout exceeds 1 MiB.

Transport volume must no longer be treated as equivalent to final reviewer-result size.

The new runner must:

- parse child JSONL incrementally;
- write the transcript incrementally;
- retain only the state needed to return the final result;
- bound the text injected back into the parent agent;
- preserve existing cancellation, timeout, error, and secret-redaction behavior.

## Scope boundary

### Primary files

Read and modify only what is required under:

```text
pi-locked-subagents/
├── runner.ts
├── runner.test.ts
├── config.ts           # only if limits become configurable
├── README.md
└── stream-parser.ts    # add if useful
```

Read `index.ts` only to confirm the return contract between `runChild` and the tool.

Do not modify other extensions.

### Out of scope

Do not implement:

- Review Packet;
- repository-scope restrictions for reviewers;
- a generic context compressor;
- generic output reduction for normal Pi tools;
- new subagent roles;
- model-selection changes;
- parallel-agent orchestration;
- new permission behavior.

## Current defect to preserve as the problem statement

The current runner accumulates child stdout in `stdoutChunks` and stops the child when:

```text
stdoutBytes > stdoutMaxBytes
```

The default stdout cap is 1,048,576 bytes.

Pi JSON mode stdout contains intermediate event traffic as well as the final assistant message. Therefore a reviewer can be killed because of event-stream volume even when its final answer would have been acceptable.

## Implementation steps

### 1. Confirm existing runner contract

Read:

- `runner.ts`;
- `runner.test.ts`;
- `index.ts` only around `runChild` consumption;
- `config.ts` only for existing types/limits.

Before editing, identify the existing behaviors that must remain:

- child process group termination;
- abort handling;
- timeout handling;
- valid `message_end` detection;
- `stopReason`;
- `errorMessage`;
- protocol error handling;
- transcript path creation;
- sensitive environment-value redaction.

Do not change these semantics unless required by streaming.

### 2. Introduce incremental JSONL parsing

Prefer a small dedicated parser if that keeps `runner.ts` simple.

The parser must correctly handle:

- multiple JSON lines in one chunk;
- one JSON line split across multiple chunks;
- blank lines;
- final line without trailing newline;
- invalid JSON reporting.

Do not assume one stdout chunk equals one JSON event.

### 3. Remove whole-stdout buffering

Eliminate the need to retain every stdout chunk until child exit.

The runner should retain only:

- incomplete current line;
- latest valid final assistant text;
- stop reason;
- error message;
- protocol state;
- byte counters needed for diagnostics.

Do not preserve a second complete copy of the transcript in memory.

### 4. Stream transcript writes

For each complete JSONL line:

1. apply existing secret redaction to the complete line;
2. write it to the transcript stream;
3. update the transcript byte counter.

Do not redact arbitrary partial chunks because a sensitive value can cross chunk boundaries.

Keep file permissions at least as restrictive as the existing implementation.

### 5. Redefine limits by responsibility

Remove `stdoutMaxBytes` as the 1 MiB kill switch.

Use separate concepts:

```ts
interface RunLimits {
  timeoutMs: number;
  stderrMaxBytes: number;
  transcriptMaxBytes: number;
  parentOutputMaxBytes: number;
}
```

Exact naming may differ.

Recommended initial defaults:

```text
timeout             120 seconds
stderr              256 KiB
transcript            8 MiB
parent output         24 KiB
```

Do not add more limits unless a concrete failure mode requires them.

### 6. Transcript limit behavior

Reaching the transcript archive limit must not automatically kill an otherwise healthy subagent.

Preferred behavior:

- stop archiving additional transcript bytes;
- mark `transcriptTruncated=true`;
- continue parsing stdout for final state;
- allow the child to finish.

If the existing stream API makes this unsafe, implement the smallest safe alternative and document it.

### 7. stderr handling

Keep stderr bounded.

Do not treat "stderr produced many bytes" as equivalent to an invalid final result unless the actual process/assistant state indicates failure.

Preserve enough bounded stderr text for diagnostics.

### 8. Bound parent-visible final output

The complete final assistant text may itself be large.

If it is within `parentOutputMaxBytes`, return it normally.

If it exceeds the limit:

1. persist the complete redacted final text to a sidecar file under the existing subagent run directory;
2. return a bounded preview to the parent;
3. clearly state that the output was projected;
4. include the path to the complete output in `details`.

The parent-visible text must not pretend to be the complete result.

Suggested marker:

```text
[output projected: <original bytes> → <visible bytes>]
Full output: <path>
```

A simple head/tail projection is sufficient. Do not add LLM summarization.

### 9. Extend result details

Expose enough metadata for diagnostics, for example:

```ts
{
  transcriptPath,
  transcriptTruncated,
  finalOutputBytes,
  parentOutputBytes,
  outputPath,
  projected
}
```

Keep existing fields expected by `index.ts`.

### 10. Update documentation

Document:

- stdout event traffic is streamed rather than accumulated;
- transcript archive behavior;
- parent-result projection;
- configured/default size limits;
- full output remains locally retrievable when projected.

Do not document Review Packet or other future work.

## Static verification checklist

Before formal review, inspect the diff and confirm:

- no `stdoutChunks` whole-run accumulation remains;
- chunk boundaries cannot corrupt JSONL parsing;
- the final no-newline line is handled;
- complete lines are redacted before transcript write;
- `message_end` semantics are preserved;
- timeout and abort still terminate the child process group;
- a large event stream no longer triggers the old 1 MiB stdout kill;
- transcript truncation does not prevent final-state parsing;
- oversized final output is clearly projected;
- full projected output has a retrievable local path;
- no unrelated subagent/model policy changed.

Do not run tests/typecheck/build/lint unless explicitly authorized.

## Required tests when execution authorization is granted

Use or add focused tests for:

1. two JSON events in one chunk;
2. one JSON event split across chunks;
3. final line without newline;
4. invalid JSON event;
5. valid `message_end` extraction;
6. >1 MiB cumulative stdout with valid final result;
7. transcript exceeding archive budget while child still completes;
8. oversized final result creates bounded parent projection;
9. secret redaction in transcript;
10. abort;
11. timeout.

Do not run the entire repository test suite unless separately authorized.

## Formal review

Run one formal code-review cycle for T03 only.

The reviewer should focus on:

- stream correctness;
- loss of existing error/cancellation behavior;
- secret handling;
- resource bounds;
- parent-output semantics.

Do not expand the review into redesigning the subagent architecture.

The main agent fixes accepted findings.

## Acceptance criteria

- [ ] Whole child stdout is no longer accumulated in memory.
- [ ] The old 1 MiB stdout threshold no longer kills a reviewer solely because of JSONL event volume.
- [ ] JSONL parsing works across arbitrary chunk boundaries.
- [ ] Transcript is written incrementally.
- [ ] Secret redaction remains effective.
- [ ] Abort and timeout behavior remain intact.
- [ ] Valid final `message_end` output is still returned.
- [ ] Transcript archive size is bounded independently.
- [ ] Parent-visible final output is bounded independently.
- [ ] Oversized final output remains retrievable from a local sidecar.
- [ ] No Review Packet or unrelated context feature was added.

## Commit

After review findings are resolved:

```text
fix: stream locked subagent output
```

Stop after the commit. Do not automatically execute another PCEI ticket.
