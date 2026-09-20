# T02 — TDD Cold-Start Context Scope

## Target repository

`heihei0299/matt-skills`

This ticket is stored in `pi-plugins` only as the PCEI execution record. **Do not implement it in pi-plugins.**

## Goal

Reduce TDD cold-start context growth by fixing exactly two confirmed behaviors:

1. future issue bodies are read before they are needed;
2. a Skill already fully present in the active conversation is read again from disk.

Do not redesign the TDD lifecycle.

## Scope boundary

### Required behavior changes

At the beginning of an issue:

- read the current issue body;
- do not read future issue bodies;
- future issues may expose only compact metadata such as id/title/status/dependency;
- read a future issue body only if the current issue explicitly depends on a contract that cannot otherwise be resolved;
- do not re-read a Skill whose full content is already present in the current conversation.

### Must remain unchanged

Do not change:

- one issue = one implementation unit;
- existing formal code-review Skill;
- existing dual-axis review requirement;
- one issue = one commit;
- incremental fixes inside the same issue;
- final verification semantics;
- compile/test/lint/typecheck authorization policy.

Do not remove or replace upstream review Skills.

## Read scope

At ticket start:

1. locate the current TDD implementation Skill;
2. read that `SKILL.md`;
3. read only directly referenced material needed to understand issue-loading behavior.

Do not read every Skill in the repository.

Do not read every reference document preemptively.

Do not read every existing ticket example.

## Implementation steps

### 1. Identify current startup instructions

Locate the rules that cause or allow:

- issue-batch enumeration;
- reading multiple issue bodies;
- repository-wide startup exploration;
- re-reading a Skill for confirmation.

Record the exact rules in the implementation notes before changing them.

### 2. Add current-issue scope rule

Add an explicit rule equivalent to:

```text
Implementation context is current-issue scoped.

At issue startup:
1. Read the current issue body.
2. Do not read future issue bodies.
3. Future issues may be inspected only by compact metadata:
   ID, title, status, and dependency.
4. Expand another issue only when the current issue explicitly depends
   on a contract that cannot otherwise be resolved.
5. Read only the specific dependent section needed.
```

Keep the wording compact.

### 3. Add duplicate-Skill rule

Add an explicit rule equivalent to:

```text
If the complete active Skill content is already present in the current
conversation, do not read the same Skill file again merely to confirm
its rules.

Re-read only when:
- the conversation contains only a partial/summary copy;
- the file is known to have changed during the session; or
- the user explicitly requests a fresh read.
```

Do not implement a plugin, hash database, or runtime cache for this ticket.

### 4. Preserve necessary exploration

The rule must not prohibit:

- current-issue referenced specs;
- code required to implement the current issue;
- relevant tests;
- a dependency contract that is genuinely required.

The goal is not "read as little as possible"; it is "do not preload future work or duplicate already-present instructions."

### 5. Avoid unrelated restructuring

Do not split the Skill into multiple files in this ticket unless a tiny edit is strictly necessary to express the two rules.

Do not add a context-budget framework.

Do not add token counting.

Do not modify unrelated workflow phases.

## Static verification checklist

Review the final Skill text and verify:

- current issue body remains required;
- future issue bodies are explicitly deferred;
- compact future-issue metadata remains allowed;
- dependency exception is narrow;
- already injected complete Skill content is not re-read;
- partial/outdated Skill exceptions remain possible;
- review/commit workflow is unchanged;
- no new unrelated workflow policy was introduced.

Do not run tests/typecheck/build/lint unless explicitly authorized.

## Formal review

Run one formal review cycle for this ticket only.

The reviewer checks whether the two requested behavioral constraints are clear, enforceable, and non-conflicting with the existing TDD workflow.

Do not ask the reviewer to redesign TDD.

Fix accepted findings in the same issue.

## Acceptance criteria

- [ ] Startup rules require the current issue body.
- [ ] Startup rules explicitly prohibit pre-reading future issue bodies.
- [ ] Future issues may still expose compact metadata.
- [ ] There is a narrow dependency exception.
- [ ] A complete Skill already in conversation is not re-read merely for confirmation.
- [ ] Review semantics are unchanged.
- [ ] Commit semantics are unchanged.
- [ ] No token-budget/context-framework feature was added.

## Runtime verification to perform later

When authorized to run a real TDD session, compare a new issue startup against the previous behavior:

```text
future issue body reads = 0
duplicate Skill reads    = 0
```

Use provider usage data separately to measure cold-start uncached-token impact.

Runtime verification is not required to make the code/documentation change if execution authorization has not been given.

## Commit

After review findings are resolved:

```text
fix: scope TDD startup context to current issue
```

Stop after the commit. Do not automatically execute another PCEI ticket.
