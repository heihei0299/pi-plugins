# pi-plan-mode

A planning-only variant of Pi's official `examples/extensions/plan-mode`.

It provides a safe, read-only exploration mode for producing professional implementation plans. Plan output is the end of the extension's responsibility; implementation and execution belong to the normal agent or developer.

## Structure

```text
pi-plan-mode/
├── index.ts         # extension entrypoint and Plan Mode lifecycle
├── utils.ts         # read-only bash allowlist
├── pi-plan-mode.ts  # compatibility shim
└── README.md
```

This follows Pi's official extension-directory layout: `~/.pi/agent/extensions/*/index.ts`.

## Kept from the official implementation

- `--plan` startup flag
- `/plan` toggle and `Ctrl+Alt+P`
- snapshot of the active tool set before entering Plan Mode
- exact restoration of the pre-plan tool set on exit
- disables built-in `edit` / `write` while planning
- uses a configurable Plan Mode tool list
- uses the standard planning tools by default: `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`
- read-only bash allowlist
- hidden `[PLAN MODE ACTIVE]` context only while the mode is enabled
- stale Plan Mode context cleanup after exit
- professional implementation-plan instructions
- session persistence for enabled state and the pre-plan tool snapshot

The bash helper is based on Pi's official allowlist and keeps an extra fail-closed rule: for `&&`, `||`, `;`, and pipelines, every segment must independently match the read-only allowlist.

## Plan output

When the user explicitly asks for a plan, Plan Mode first explores the relevant repository with its read-only tools, then produces an implementation-ready numbered plan under a `Plan:` header.

For non-trivial work, the plan should cover:

- goal, scope, and success criteria;
- current implementation and repository evidence;
- affected paths, symbols, call paths, and boundaries;
- why the current implementation is insufficient and its root cause;
- proposed design and important invariants;
- scope and non-goals;
- ordered implementation steps and dependencies;
- tests, verification commands, and expected observations;
- compatibility and migration impact when interfaces, state, configuration, or data formats change;
- risks, assumptions, alternatives, and open questions;
- observable acceptance criteria.

The plan must distinguish confirmed repository facts from proposed decisions and assumptions. It must not invent code, APIs, constraints, or test results. It does not modify files, execute the implementation, hand the plan to another agent, or track progress.

## Commands

```text
/plan
/plan on
/plan off
/plan status
```

Shortcut:

```text
Ctrl+Alt+P
```

## Tool configuration

Plan Mode reads its tool list from `~/.pi/agent/plan-mode.json` every time it is entered:

```json
{
  "tools": ["read", "bash", "grep", "find", "ls", "questionnaire"]
}
```

The configured list replaces the active tool list while Plan Mode is active. Duplicate names are removed while preserving order. Unknown tool names are ignored by Pi. `edit` and `write` are always filtered out, and `bash` remains restricted to the read-only allowlist.

If the file is missing, the default list is used. Invalid or unreadable configuration falls back to the default list with a warning. Changes take effect the next time Plan Mode is entered. The extension does not create the file automatically.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-plan-mode ~/.pi/agent/extensions/
```

Then restart Pi or run:

```text
/reload
```

## Flow

```text
normal mode
    │
    ▼
/plan
    │
    ├── snapshot current tools
    ├── load the configured tool list
    ├── filter edit/write
    ├── restrict bash
    └── inject professional planning instructions
    │
    ▼
read-only repository exploration
    │
    ▼
user explicitly requests a plan
    │
    ▼
implementation-ready Plan output
    │
    └── /plan off ──► restore previous tools
```

## Context overhead

The extension registers no LLM-callable tools.

The Plan Mode instruction is injected only while Plan Mode is active. After exit, the context hook removes stale Plan Mode instruction messages so they do not remain in later model turns.

There is no plugin-level plan length limit.

## Safety boundary

Plan Mode disables built-in `edit` / `write` and filters `bash` through a read-only allowlist.

Any configured custom tool is active as-is. If it can mutate state, Plan Mode does not automatically make that custom tool read-only.
