# F03 — Correct Context Audit Measurement Semantics

## Findings fixed

- F05 — `Estimated input` implies a wider measurement than the extension actually observes.
- F06 — tool result snapshot labels point at the already-existing snapshot, not the context that will consume the result.

## Target repository

`heihei0299/pi-plugins`

## Goal

Keep `pi-context-audit` passive and small while making every displayed number semantically honest.

Do not expand it into provider-level token accounting.

## Read scope

Read only:

- `pi-context-audit/index.ts`;
- `pi-context-audit/collector.ts`;
- `pi-context-audit/report.ts`;
- `pi-context-audit/types.ts`;
- `pi-context-audit/README.md`;
- relevant focused tests.

## Problem 1 — "Estimated input" is too broad

The `context` hook sees the conversation/context messages supplied through that hook.

The current estimator does not account for all provider request material, including at least:

- system prompt sections outside the observed message list;
- serialized tool schemas;
- provider/request framing.

Therefore:

```text
Estimated input: 28.4K
```

can be read as "the model request has 28.4K tokens", which is not what is measured.

## Required repair

### 1. Rename the metric

Use wording such as:

```text
Estimated message context: 28.4K tokens
```

or another equally explicit phrase.

Do not use `input tokens` for this approximate message-only measure.

### 2. Document exclusions

README must explicitly say:

- estimates are based on observed context-message content;
- they do not represent provider-reported input tokens;
- system prompt/tool-schema/provider framing may add additional input;
- use provider usage events for billing/cache-accurate token counts.

Keep the explanation short.

### 3. Preserve the useful delta behavior

Do not remove adjacent-snapshot deltas.

The extension remains useful for detecting message-context growth even though it is not a full provider-request meter.

## Problem 2 — tool snapshot label is misleading

At `tool_call` time, the stored `snapshotSequence` refers to the last model context that already occurred.

The resulting tool output generally becomes visible to a later context/model request.

Current reporting:

```text
read (3.0K chars, snapshot #17)
```

can therefore imply the result was part of snapshot #17.

## Required repair

Choose the smaller of these designs:

### Preferred minimal design

Rename the field/report meaning to:

```text
observed after snapshot #17
```

For example:

```text
read (3.0K chars, after #17)
```

This accurately describes the known relationship without building attribution logic.

### Alternative

Associate the tool record with the next observed snapshot only if this can be done simply and deterministically without retaining tool payloads.

Do not build a complex event-correlation system in v0.1.

## Optional cleanup allowed

If `customTypes` is retained but not displayed, either:

- keep it as harmless bounded data for a near-term use; or
- remove it if doing so simplifies the implementation.

Do not add plugin fingerprinting/attribution in this ticket.

## Tests to update when execution is authorized

- command output uses `Estimated message context` or equivalent;
- README/format does not claim exact provider input;
- tool-result report says `after #N` (or has a correct next-snapshot association);
- delta calculations remain unchanged.

Do not run tests without explicit authorization.

## Static verification

Confirm:

- extension remains observation-only;
- no provider hook was added;
- no LLM tool was registered;
- no full tool result is retained;
- displayed labels match the actual measurement scope.

## Acceptance criteria

- [ ] UI no longer labels message-only estimate as total `input`.
- [ ] README explicitly states major excluded request components.
- [ ] Provider usage events remain the stated source for exact token/cache accounting.
- [ ] Tool records no longer imply they were contained in the previous snapshot.
- [ ] No new attribution framework was added.

## Commit

Use one repair commit:

```text
fix(context-audit): clarify measurement semantics
```

Stop after the commit.
