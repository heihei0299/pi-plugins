# T01 — Remote Research Fan-out Guard

## Entry condition

Execute only when v0.2 benchmark demonstrates that staged research instructions did not sufficiently control remote fetch fan-out.

## Target repository

`heihei0299/pi-plugins`

## Goal

Add a very small runtime guard that limits the number of new remote fetch calls initiated in a single agent/model turn.

This guard addresses **ingestion rate**, not output compression.

## Initial command scope

Classify only well-understood remote-fetch Bash commands such as:

```text
curl
wget
gh api
```

Do not intercept ordinary Bash.

Do not modify tool results.

## Turn-level budget

Recommended initial configuration:

```json
{
  "enabled": true,
  "maxRemoteFetchesPerTurn": 2
}
```

Behavior:

```text
fetch #1 → allow
fetch #2 → allow
fetch #3 → block with a short deterministic message
```

Counter resets on the next model/agent turn.

Do not impose a session-wide fetch quota.

## Block response

Keep it short:

```text
Remote research fan-out limit reached for this turn.
Inspect existing results before fetching another source.
```

Do not inject additional permanent system instructions.

## Safety / compatibility

The guard can add an extra deny condition but must never override:

- `pi-permission-system` deny/ask decisions;
- model/provider locking;
- RTK/SoL output processing.

## Configuration

Keep configuration minimal. Do not add source ranking, semantic URL dedupe, or domain intelligence in the first version.

## Acceptance criteria

- [ ] Only classified remote-fetch calls count.
- [ ] Limit is per model/agent turn.
- [ ] Counter resets on the next turn.
- [ ] The third fetch is deterministically blocked at the default limit.
- [ ] Ordinary local Bash is unaffected.
- [ ] Tool results are not rewritten.
- [ ] Permission enforcement cannot be bypassed.
- [ ] Guard adds no LLM-callable tool and no permanent prompt injection.

## Measurement

Repeat the v0.2 research benchmark and compare:

```text
remote fetches per turn
max context delta
total uncached input
task completion quality
```

## Commit

```text
feat: add remote research fan-out guard
```
