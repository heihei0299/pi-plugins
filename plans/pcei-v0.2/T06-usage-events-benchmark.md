# T06 — Usage-Events Benchmark

## Target

Measurement only. Do not change production behavior in this ticket.

## Goal

Measure whether v0.1 + v0.2 reduce real provider cost/context growth.

Do not use plugin self-reported savings as the final result.

## Primary metric

```text
total uncached input tokens per completed task
```

## Secondary metrics

```text
cold-start uncached input
max request-to-request context delta
total input tokens
warm-session cache rate
reviewer child input / transcript / parent output
remote fetch count per model turn
duplicate equivalent reads
```

## Workloads

### A — TDD implementation

Use a representative issue comparable to earlier observed sessions.

Measure:

- first request input;
- first three requests uncached input;
- issue/Skill/source reads;
- completed-task uncached total.

### B — reviewer

Use the same bounded commit/diff for baseline and Review Packet.

Measure:

- reviewer tool calls;
- repository-wide discovery calls;
- child input;
- transcript bytes;
- parent-visible output;
- completion/failure.

### C — research

Use the same Pi/plugin research question.

Measure:

- fetch calls;
- fetches per reasoning turn;
- maximum context delta;
- total uncached input;
- whether the task still reaches a supported answer.

## Interpretation

Do not declare success based only on cache percentage.

Example:

```text
98% cache on a 200K prompt
```

may still be worse than:

```text
94% cache on a 40K prompt
```

depending on actual uncached/read costs.

## Exit decision

After benchmark:

- if staged research keeps remote fan-out under control, do **not** implement v0.3 Research Guard;
- if agents still repeatedly fetch multiple remote sources in one turn and this materially drives uncached/context growth, v0.3 entry condition is met.

## Deliverable

Produce a compact table with baseline vs optimized measurements and a conclusion for each workload.

No implementation commit is required unless the repository stores benchmark reports by convention.
