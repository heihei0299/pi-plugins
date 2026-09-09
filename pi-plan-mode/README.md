# pi-plan-mode

A compact single-file Plan Mode extension based on Pi's official `examples/extensions/plan-mode`.

## Features

- `/plan`, `/plan on`, `/plan off`, `/plan status`
- `Ctrl+Alt+P`
- disables `edit` / `write` during planning
- conservative read-only bash allowlist
- extracts numbered steps from the **last** `Plan:` section
- Execute / Stay / Refine / Exit UI
- restores the exact pre-plan tool set before execution
- `[DONE:n]` progress tracking
- reads DONE markers from both text and thinking blocks
- status + todo widget
- session persistence / resume
- registers **no LLM-callable tool**

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp pi-plan-mode.ts ~/.pi/agent/extensions/
```

Then restart Pi or run `/reload`.

## Usage

```text
/plan
```

Ask Pi to analyze the task. It will be instructed to return:

```text
Plan:
1. ...
2. ...
3. ...
```

After the plan is produced, choose whether to execute, stay in Plan Mode, refine it, or exit.

Use `/todos` during execution to view progress.

## Context overhead

No LLM tool schema is added. Plan instructions are injected only while Plan Mode is active; execution instructions are injected only while a plan is executing.

## Changes vs. the current official sample

This copy keeps the official lifecycle, but fixes two known rough edges:

1. DONE tracking reads `thinking` blocks as well as final text.
2. Plan parsing uses the last `Plan:` section and does not truncate step descriptions.

## Safety boundary

Like the official example, this primarily guards built-in `edit` / `write` and `bash`. Custom extension tools remain active; disable mutating custom tools separately if you require a strict sandbox.
