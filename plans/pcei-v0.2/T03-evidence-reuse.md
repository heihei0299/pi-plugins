# T03 — Reuse Existing Evidence

## Target repository

`heihei0299/matt-skills`

## Goal

Prevent the agent from reacquiring the same fact from multiple equivalent sources.

Observed examples:

- full Skill already injected, then Skill file is read again;
- codegraph already identifies a call path, then broad grep/read repeats the same discovery;
- parent already extracts issue requirements, reviewer rereads the full ticket;
- earlier issue ledger/git history already records a fact, later issue researches it again.

## Required rule

Add a general evidence discipline:

> If current context already contains sufficient reliable evidence for a fact, do not perform an equivalent search/read merely to reconfirm it.

Acquire more evidence only when:

- the existing evidence is incomplete;
- it conflicts with another source;
- it may be stale because the relevant file changed;
- a required exact source location/content is still missing;
- verification specifically requires a fresh observation.

## Evidence priority

Prefer reuse in this order when appropriate:

```text
current exact source/result
current issue evidence
codegraph result
ledger / git history from completed issue
new targeted read/search
broad exploration (last resort)
```

This is not a rule that summaries override source code; exact source reads remain appropriate when implementation/editing requires exact content.

## Do not implement

- semantic-hash database;
- embeddings;
- automatic tool-result dedupe plugin;
- hidden global memory system.

This ticket is workflow discipline only.

## Acceptance criteria

- [ ] Equivalent rereads are explicitly discouraged.
- [ ] Stale/incomplete/conflicting evidence has clear exceptions.
- [ ] Exact source is still read when necessary for edits or proof.
- [ ] Prior issue ledger/git evidence is reusable for later issue scheduling.
- [ ] No runtime dedupe subsystem is introduced.

## Commit

```text
docs(agent): reuse sufficient existing evidence
```
