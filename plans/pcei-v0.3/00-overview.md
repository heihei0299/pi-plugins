# PCEI v0.3 — Conditional Enforcement

## Entry condition

Do not execute v0.3 until PCEI v0.2 T06 is complete.

v0.3 is justified only if real usage data shows:

- staged research instructions are insufficient;
- agents still fan out remote fetches in the same reasoning turn;
- those fetches materially increase context/uncached cost.

If those conditions are not met, close v0.3 as unnecessary.

## Ticket

- T01 — Remote Research Fan-out Guard

## Non-goals

v0.3 still does not add:

- generic Read/Bash/Grep compression;
- history compaction;
- semantic dedupe;
- vector database;
- provider cache replacement.
