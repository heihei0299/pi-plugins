# PCEI v0.1 — Execution Overview

## Purpose

PCEI v0.1 addresses only three confirmed context-efficiency problems:

1. Pi lacks a passive way to see where context growth comes from.
2. TDD cold start reads future issue bodies and/or re-reads an already injected Skill.
3. `pi-locked-subagents` buffers the child JSONL stream and can terminate a useful reviewer when stdout exceeds 1 MiB.

This milestone intentionally does **not** build a general context-management framework.

## Tickets

| Ticket | Target repository | Goal | Depends on |
|---|---|---|---|
| T01 | `heihei0299/pi-plugins` | Add passive `pi-context-audit` | none |
| T02 | `heihei0299/matt-skills` | Scope TDD cold start to current issue and avoid duplicate Skill reads | none |
| T03 | `heihei0299/pi-plugins` | Stream subagent JSONL and bound parent-visible final output | none |

The tickets are independent. Execute one ticket at a time.

## Agent execution contract

When an agent is asked to execute a ticket:

1. Read **this overview only for global rules**, then read **only the current ticket**.
2. Do not read future ticket bodies for context.
3. Do not delegate implementation to subagents.
4. Use subagents only when the established workflow requires a reviewer. Reviewers may inspect and report; they must not modify code.
5. Do not broaden scope to adjacent architecture cleanup.
6. Do not install new dependencies unless the current ticket explicitly requires one.
7. Do not change existing behavior owned by:
   - `pi-cache-optimizer` — provider/prompt cache behavior;
   - `pi-rtk-optimizer` — normal CLI/tool output compression;
   - SoL-Pi — observation packing/action fusion;
   - `pi-vcc` — long-session compaction/recall;
   - `pi-permission-system` — permission enforcement.
8. Build, test, lint, typecheck, compile, or other executable verification requires explicit user authorization. Without it, perform static inspection only and report verification as pending.
9. Each ticket gets exactly one normal implementation cycle:
   - implement;
   - static self-review;
   - one formal code-review cycle according to the repository workflow;
   - fix findings;
   - one commit.
10. Do not start the next ticket until the current ticket is committed or explicitly deferred.

## Non-goals for v0.1

Do not implement:

- a new generic Bash/Read/Grep reducer;
- history compaction;
- output parking or recall databases;
- semantic deduplication;
- embeddings/vector search;
- remote-research fan-out control;
- plugin auto-disable logic;
- automatic plugin-conflict resolution;
- a generic Context Governor;
- hard token budgets.

## Definition of milestone complete

PCEI v0.1 is complete when all three tickets independently satisfy their acceptance criteria and the implementation remains compatible with the currently installed optimization stack.
