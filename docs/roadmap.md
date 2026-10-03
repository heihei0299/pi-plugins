# PCEI Roadmap

## Principle

PCEI is executed as small independent tickets. Do not combine phases into a single implementation batch.

The roadmap is ordered by observed cost and confidence:

```text
v0.1 — confirmed defects / observability
v0.2 — confirmed agent-behavior waste
v0.3 — hard enforcement only if v0.2 proves insufficient
```

## v0.1 — Foundation

Existing plans:

- Context Audit
- TDD current-issue cold-start scope
- Locked subagent streaming
- post-implementation repair tickets

Complete v0.1 repair findings before treating the milestone as closed.

## v0.2 — Context Discipline

Execute in this order:

1. Review Packet
2. Progressive Discovery
3. Evidence Reuse
4. Codegraph Query Discipline
5. Staged Remote Research
6. Usage-Events Benchmark

These tickets primarily change agent workflow, not low-level tool-result compression.

## v0.3 — Conditional Enforcement

Execute only after v0.2 benchmark data.

1. Research Fan-out Guard

Do not implement v0.3 merely because it exists in the roadmap. Its entry condition is explicit in the ticket.

## Success metric

Do not optimize cache percentage in isolation.

Primary metric:

```text
total uncached input tokens per completed ticket/task
```

Secondary metrics:

```text
cold-start uncached input
max context delta per request
warm-session cache rate
subagent parent-visible output
remote fetches per reasoning turn
duplicate evidence reads
```

Provider usage data remains authoritative for token/cache accounting.
