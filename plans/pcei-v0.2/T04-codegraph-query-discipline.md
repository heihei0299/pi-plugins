# T04 — Codegraph Query Discipline

## Target repository

`heihei0299/matt-skills`

## Goal

Preserve the existing rule that understanding/call-chain work starts with codegraph, while preventing codegraph from becoming the first half of a duplicate broad exploration.

## Required behavior

For a concrete implementation question:

1. formulate a narrow symbol/behavior/call-chain query;
2. use codegraph to identify the relevant path;
3. read only the files/ranges needed to answer the unresolved question;
4. do not repeat the same discovery with broad grep/find/read unless codegraph evidence is insufficient.

## Query shape

Prefer:

```text
How does symbol X reach Y?
Where is behavior Z implemented?
What calls function A?
Which component owns state B?
```

Avoid open-ended repository tours such as:

```text
Explain the whole architecture
Explore all relevant files
Find everything related to X
```

unless the user explicitly asks for broad architecture analysis.

## Read/grep role

Read/grep remain supplemental.

They are appropriate for:

- exact implementation text;
- ranges codegraph does not provide;
- generated/dynamic paths absent from graph;
- confirming a concrete suspected reference.

They should not automatically replay the same call-chain search.

## Acceptance criteria

- [ ] codegraph queries are explicitly scoped to a current question.
- [ ] broad follow-up grep is not the default after a sufficient graph result.
- [ ] exact source reads remain allowed where implementation requires them.
- [ ] architecture-wide exploration remains available only for architecture-wide tasks.

## Commit

```text
docs(agent): narrow codegraph exploration
```
