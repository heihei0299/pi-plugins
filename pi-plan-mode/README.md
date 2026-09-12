# pi-plan-mode

A deliberately small, planning-only Pi extension based on Pi's official Plan Mode example.

Its responsibility ends when the plan is handed back to the normal agent. It does not implement a task runner, todo tracker, workflow engine, or subagent system.

## Features

- `/plan`, `/plan on`, `/plan off`, `/plan status`
- `Ctrl+Alt+P`
- disables built-in `edit` / `write` while planning
- conservative read-only bash allowlist
- extracts the last complete `Plan:` section without a plugin length limit
- Execute / Refine / Stay / Exit UI
- restores the exact pre-plan tool set before handoff
- minimal session persistence for Plan Mode state
- registers **no LLM-callable tools**

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp pi-plan-mode.ts ~/.pi/agent/extensions/
```

Restart Pi or run `/reload`.

## Usage

```text
/plan
```

Pi enters read-only planning mode and is instructed to return an implementation-ready numbered plan under a `Plan:` header.

After a plan is produced:

- **Execute the plan** — leave Plan Mode, restore the previous tools, and hand the complete plan to the normal agent for execution.
- **Refine the plan** — stay in Plan Mode and send refinement instructions.
- **Stay in Plan Mode** — keep exploring/planning.
- **Exit Plan Mode** — discard the mode and restore the previous tools.

## Deliberately not included

- todo/progress tracking
- `[DONE:n]` markers
- execution state machine
- execution prompts
- workflow orchestration
- subagent orchestration
- execution-progress session recovery

Those responsibilities belong to the main agent, project skills, or a separate subagent extension.

## Context overhead

No LLM-callable tool schema is added. The hidden Plan Mode instruction is injected only while Plan Mode is active and is removed from model context after leaving the mode.

There is no plugin-level plan length limit. Normal model/provider/runtime limits still apply.

## Safety boundary

Plan Mode disables built-in `edit` / `write` and blocks non-read-only `bash` commands. Custom extension tools remain active; disable mutating custom tools separately if you require a strict sandbox.
