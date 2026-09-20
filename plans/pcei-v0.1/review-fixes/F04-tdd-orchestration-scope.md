# F04 — Close the Multi-Issue Orchestration Context Loophole

## Finding fixed

- F07 — `orchestration.md` still tells the agent to read every issue's `Blocked by`, which can cause full future issue files to be opened while building the dependency graph.

## Target repository

`heihei0299/matt-skills`

Target branch: `main` or a repair branch created from the reviewed `main`, according to the user's normal workflow.

This plan is stored in `pi-plugins` only as the PCEI review record.

## Goal

Make multi-issue dependency scheduling consistent with the new current-issue context rule.

The orchestrator may inspect future-issue scheduling metadata, but must not load future issue bodies merely to construct the dependency graph.

## Read scope

Read only:

- `.agents/skills/tdd-implement/SKILL.md`;
- `.agents/skills/tdd-implement/references/orchestration.md`;
- `test/tdd-implement-context-scope.test.js`.

Read an existing orchestration test only if needed to avoid duplicating a current assertion.

Do not inspect unrelated Skills.

## Current inconsistency

`SKILL.md` now states:

```text
Do not read future issue bodies.
Future issues may be inspected only by compact metadata:
ID, title, status, and dependency.
```

But `orchestration.md` still says:

```text
读取每个 issue 的 Blocked by
```

Without an access rule, an agent can satisfy that sentence by opening every future issue file in full, defeating the cold-start change.

## Required repair

### 1. Change dependency-graph wording

Replace/augment the dependency-graph instruction so it explicitly requires metadata-only access.

Equivalent behavior:

```text
构建依赖图时，只提取各 issue 的调度元数据：
ID、Status、Blocked by / dependency。

不得为构建依赖图读取未来 issue 正文、Acceptance Criteria、
实现说明或其它 body 内容。

如果调度元数据位于独立 issue 文件中，使用定点搜索/范围读取只取得
对应 metadata 字段；不要全文打开所有 future issue 文件。
```

Keep the final text concise and consistent with the existing Chinese style.

### 2. Preserve dependency correctness

Do not weaken these existing rules:

- missing dependency remains an error;
- unparseable dependency remains an error;
- cycles remain an error;
- Kahn ordering remains unchanged;
- layers/issues remain serial as currently specified.

Context reduction must not silently treat unknown dependencies as empty.

### 3. Current issue body still loads normally

Once an issue becomes the current executable issue, normal `SKILL.md` rules still require its full body.

Do not accidentally make implementation depend only on metadata.

### 4. Dependency-contract exception remains narrow

If the current issue explicitly requires a contract from another issue and the contract cannot otherwise be resolved, the existing current-issue scope exception may load the specific required section.

Do not make dependency-graph construction itself such an exception.

## Test change

Extend the existing context-scope static test so it also inspects `references/orchestration.md` and asserts the essential contract:

- dependency graph uses scheduling metadata;
- future issue body is not read for graph construction;
- targeted field/range extraction is required/preferred;
- existing invalid/missing/cycle dependency failure semantics still appear.

Avoid brittle assertions on every sentence.

Do not run tests without explicit authorization.

## Static verification

Confirm:

- no instruction in `orchestration.md` still suggests whole-body future issue reads;
- the dependency graph can still be built from ID/status/dependency metadata;
- current issue full-body loading remains intact;
- no code-review lifecycle behavior changed;
- no commit lifecycle behavior changed.

## Non-goals

Do not change:

- Red-Green lifecycle;
- Verify;
- Record;
- Finalize;
- code-review policy;
- commit policy;
- batch state sync behavior;
- dependency algorithm.

## Acceptance criteria

- [ ] Multi-issue dependency discovery is explicitly metadata-only.
- [ ] Future issue body/AC/implementation text is explicitly deferred.
- [ ] Targeted metadata extraction is required when issues live in separate files.
- [ ] Missing/unparseable/cyclic dependencies still fail closed.
- [ ] Current issue full-body reading remains required when it becomes executable.
- [ ] Existing TDD/review/commit semantics are untouched.

## Commit

Use one repair commit:

```text
fix(tdd): keep orchestration metadata-only
```

Stop after the commit.
