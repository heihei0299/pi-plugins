# T01 — Review Packet

## Target repository

`heihei0299/pi-plugins`

## Goal

Prevent reviewer subagents from repeating repository-wide discovery already performed by the parent.

The parent must give the reviewer a bounded packet describing the exact review surface.

## Required packet

For a review task, provide:

```text
Issue
- id
- title
- relevant requirements / acceptance criteria

Diff boundary
- fixedPoint / issue_base
- current HEAD / issue_head
- changedFiles

Verification state
- checks already performed
- known limitations

Review scope
- review this issue/change only
- inspect additional files only to prove/disprove a concrete finding
```

Do not inline a large complete diff into the task when the reviewer can read the bounded diff directly from git.

## Reviewer behavior

Reviewer starts from:

```bash
git diff <fixedPoint>...HEAD -- <changed files>
```

or equivalent bounded inspection.

Repository-wide exploration is forbidden by default.

Extra reads are allowed only when tied to a specific potential finding.

## Parent implementation rule

Do not create a second general subagent framework.

Implement Review Packet as the smallest addition to the existing locked-subagent/reviewer invocation path or local workflow configuration.

Do not change model/provider locking.

## Output contract

Reviewer final output should contain findings/evidence, not an exploration diary.

Preferred structure:

```text
VERDICT

Findings:
1. severity / location
   requirement
   problem
   evidence
```

Do not require long reasoning traces.

## Acceptance criteria

- [ ] Reviewer receives explicit issue and diff boundary.
- [ ] Changed files are explicit.
- [ ] Large complete diff is not duplicated into parent→child task unnecessarily.
- [ ] Reviewer defaults to bounded diff inspection.
- [ ] Extra repository reads require a concrete finding hypothesis.
- [ ] Existing locked model/isolation behavior is unchanged.

## Measurement

Compare old vs new reviewer sessions:

```text
child tool calls
read/grep/codegraph calls
child input tokens
transcript bytes
parent-visible result bytes
```

## Commit

```text
feat(subagents): add bounded review packet
```
