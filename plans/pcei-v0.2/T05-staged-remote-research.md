# T05 — Staged Remote Research

## Target repository

`heihei0299/matt-skills` or the repository that owns the active `research` Skill.

## Goal

Prevent one reasoning turn from fetching many remote sources before evaluating the first results.

Observed waste pattern:

```text
fetch A
fetch B
fetch C
fetch D
→ large outputs enter context together
→ only then decide what mattered
```

## Required workflow

Remote research should proceed:

```text
discover/search
→ rank candidate sources
→ fetch 1–2 strongest sources
→ inspect
→ identify remaining uncertainty
→ fetch additional source only for that uncertainty
```

## Rules

- Do not fetch several URLs merely for coverage.
- Prefer source selection before source ingestion.
- Prefer targeted page/section retrieval when supported.
- Stop fetching once the current question has sufficient evidence.
- Add another source when it contributes independent evidence or resolves a real uncertainty.

## Exceptions

Broader parallel source collection remains valid when the user explicitly requests:

- comprehensive literature/review coverage;
- multi-source fact verification;
- a survey where source breadth is itself the task.

Even then, batch sources rather than flooding one model turn when possible.

## Implementation boundary

This ticket changes research workflow instructions only.

Do not implement a tool-call blocker yet.

## Acceptance criteria

- [ ] Research Skill uses staged fetch.
- [ ] Default initial fetch batch is 1–2 sources.
- [ ] More fetches require an unresolved question.
- [ ] Explicit broad-research requests retain a documented exception.
- [ ] No runtime guard is introduced in v0.2.

## Commit

```text
docs(research): stage remote source ingestion
```
