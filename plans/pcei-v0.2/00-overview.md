# PCEI v0.2 — Context Discipline

## Purpose

v0.2 addresses agent-behavior waste already observed in real coding sessions after the v0.1 infrastructure work.

Confirmed patterns:

- reviewers independently re-explore repositories after the parent already established scope;
- cold-start exploration loads heterogeneous repository material too early;
- the same fact is reacquired from Skill, codegraph, grep/read, tickets, and reviewer exploration;
- codegraph findings are followed by broad duplicate grep/read passes;
- remote research fans out into several fetches before the agent evaluates the first results;
- cache percentage alone hides absolute context growth.

## Tickets

| Ticket | Target | Goal |
|---|---|---|
| T01 | pi-plugins | Review Packet for locked reviewers |
| T02 | matt-skills | Progressive discovery discipline |
| T03 | matt-skills | Evidence reuse / no equivalent rereads |
| T04 | matt-skills | Codegraph query convergence |
| T05 | matt-skills research workflow | Staged remote fetch |
| T06 | measurement only | usage-events benchmark |

## Execution contract

- Execute one ticket at a time.
- Do not pre-read later ticket bodies.
- Main agent implements; subagents do not implement.
- Existing review skills remain review-only.
- Do not add new generic tool-result compression.
- Do not add history compaction.
- Do not modify RTK / SoL / VCC / cache-optimizer responsibilities.
- Test/build/lint/typecheck execution still requires explicit user authorization.
- One ticket → one review cycle → one commit.

## Exit

v0.2 is complete only after T06 demonstrates whether workflow changes materially reduce absolute uncached input without harming task completion.
