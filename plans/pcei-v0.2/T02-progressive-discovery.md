# T02 — Progressive Discovery

## Target repository

`heihei0299/matt-skills`

## Goal

Stop coding agents from loading repository context in a broad fixed startup sequence.

Observed waste pattern:

```text
Skill
→ codegraph
→ README
→ package.json
→ tests
→ docs
→ multiple source files
```

before the agent knows which of those sources are actually necessary.

## Required rule

For implementation/diagnosis work, discovery proceeds progressively:

```text
1. current issue/spec
2. locate relevant symbol/path
3. inspect the smallest implementation surface
4. expand only when a concrete unresolved question requires it
```

## Explicit prohibitions

Do not automatically read at task startup merely because they exist:

- repository README;
- package manifest;
- all tests;
- architecture docs;
- neighboring modules;
- all files returned by a broad search.

Each additional source must answer a current question.

## Exceptions

README/package/config may be read when they are directly needed for:

- command/package behavior;
- public usage contract;
- dependency/version question;
- repository-specific execution instruction.

Tests may be read when:

- locating existing behavior coverage;
- adding/changing behavior;
- validating an actual test contract.

## Scope

Prefer adding this as a compact common workflow rule reused by relevant Skills.

Do not create a runtime plugin or hard token budget.

## Acceptance criteria

- [ ] Startup no longer prescribes broad repository reading.
- [ ] Discovery expands from current issue/symbol outward.
- [ ] README/package/tests/docs are demand-loaded.
- [ ] Legitimate direct dependencies remain readable.
- [ ] No generic tool restriction is introduced.

## Commit

```text
docs(agent): enforce progressive repository discovery
```
