# T01 — Passive Context Audit Extension

## Target repository

`heihei0299/pi-plugins`

## Goal

Add a new extension named `pi-context-audit` that passively measures Pi context growth.

It must answer:

- What is the approximate size of the current context?
- How much did it grow since the previous context snapshot?
- How much is user, assistant, tool, and custom content?
- Which recent tool results were large?

It must **not** change what the model receives.

## Scope boundary

### Allowed changes

Create:

```text
pi-context-audit/
├── index.ts
├── collector.ts
├── estimator.ts
├── report.ts
├── types.ts
└── README.md
```

Modify only as required:

```text
package.json
package.test.ts
README.md
```

Add test files only if verification is authorized or the repository workflow requires them to define expected behavior. Do not run them without explicit authorization.

### Forbidden changes

Do not modify:

- `pi-locked-subagents/*`;
- `pi-plan-mode/*`;
- `native-responses-web-search/*`;
- `jev/*`;
- provider/model configuration;
- existing cache/RTK/SoL/VCC behavior.

Do not register an LLM-callable tool.

Do not inject system/user/custom prompt content.

Do not return transformed messages from the `context` hook.

Do not retain complete copies of tool results.

## Read scope

At ticket start, read only:

1. root `package.json`;
2. root `package.test.ts`;
3. root `README.md`;
4. `pi-plan-mode/index.ts` only for extension hook/command patterns.

Read additional files only when a concrete API/type question cannot be resolved from those files.

Do not scan unrelated plugin directories.

## Required behavior

### 1. Snapshot model

Implement a minimal in-memory model equivalent to:

```ts
interface ContextBucket {
  messages: number;
  chars: number;
  estimatedTokens: number;
}

interface ContextSnapshot {
  sequence: number;
  timestamp: number;
  totalChars: number;
  estimatedTokens: number;
  user: ContextBucket;
  assistant: ContextBucket;
  tool: ContextBucket;
  custom: ContextBucket;
  customTypes: Record<string, ContextBucket>;
  delta?: {
    chars: number;
    estimatedTokens: number;
    user: number;
    assistant: number;
    tool: number;
    custom: number;
  };
}

interface ToolRecord {
  toolCallId: string;
  toolName: string;
  inputChars: number;
  resultChars?: number;
}
```

Exact internal names may differ, but do not add plugin-attribution, budgeting, mutation, or compression abstractions.

### 2. Estimation

Use a deterministic approximation:

```text
estimatedTokens = ceil(chars / 4)
```

Do not add tokenizer dependencies.

The UI must call the value `estimated`, never provider-reported or exact tokens.

### 3. Context observation

Register a `context` observer that:

1. receives the outgoing context messages;
2. counts them;
3. creates a snapshot;
4. stores a bounded recent history;
5. returns no replacement messages.

The hook must be behaviorally passive.

### 4. Tool observation

Observe tool calls/results only to record:

- tool-call id;
- tool name;
- approximate input character count;
- result character count;
- sequence/time needed to associate recent results with a snapshot.

Do not store full tool outputs.

Bound the retained records, for example to the most recent 100 records.

### 5. Commands

Register only extension commands visible to the user, not LLM tools.

Required commands:

```text
/context-audit
/context-audit recent
/context-audit reset
```

`/context-audit` should show the latest snapshot, e.g.:

```text
Context Audit
Estimated input: 28.4K tokens
Delta: +6.1K

user        3.7K
assistant   8.1K
tool       14.2K
custom      2.4K
```

`/context-audit recent` should show a compact list of recent snapshots and deltas.

`/context-audit reset` clears only audit state.

### 6. Root package integration

Add `./pi-context-audit/index.ts` to the root Pi extension manifest and update the manifest test accordingly.

Document the extension in the root README.

## Static verification checklist

Before formal review, inspect the diff and confirm:

- no `registerTool`;
- no prompt injection;
- no provider-request mutation;
- no tool-result mutation;
- no context-message replacement;
- no full tool-result storage;
- no new runtime dependency;
- snapshot/history structures are bounded;
- existing extension order is unchanged except for adding the new entry.

Do not run build/test/typecheck/lint unless explicitly authorized.

## Formal review

Run exactly one normal code-review cycle for this ticket after implementation and static self-review.

Review scope is this ticket's diff only.

Do not allow the reviewer to expand into redesigning the other plugins.

The main agent fixes accepted findings.

## Acceptance criteria

- [ ] `pi-context-audit` is registered by the root Pi package.
- [ ] It registers no LLM-callable tool.
- [ ] It injects no prompt/context messages.
- [ ] The `context` hook is observation-only.
- [ ] It reports estimated current context size.
- [ ] It reports delta from the previous snapshot.
- [ ] It reports user/assistant/tool/custom buckets.
- [ ] It records recent tool-result sizes without storing full results.
- [ ] `/context-audit recent` works from retained in-memory snapshots.
- [ ] `/context-audit reset` touches only audit state.
- [ ] No existing optimizer/compactor behavior is duplicated.

## Commit

After review findings are resolved, create one ticket commit:

```text
feat: add passive context audit extension
```

Stop after the commit. Do not begin T02 or T03 automatically.
