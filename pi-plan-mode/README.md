# pi-plan-mode

A planning-only variant of Pi's official `examples/extensions/plan-mode`.

It keeps the official Plan Mode mechanics for read-only exploration and state/tool handling, but deliberately stops at plan handoff. Execution tracking belongs to the normal agent, project skills, or a separate subagent extension.

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
- exact restoration of the pre-plan tool set on exit/handoff
- disables built-in `edit` / `write` while planning
- preserves other active tools
- adds the standard planning tools: `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`
- read-only bash allowlist
- hidden `[PLAN MODE ACTIVE]` context only while the mode is enabled
- stale Plan Mode context cleanup after exit
- text-only extraction from the final assistant message
- session persistence for enabled state and the pre-plan tool snapshot

The bash helper is based on Pi's official allowlist and keeps an extra fail-closed rule: for `&&`, `||`, `;`, and pipelines, every segment must independently match the read-only allowlist.

## Deliberate differences

The following official execution features are intentionally **not** included:

- todo extraction
- `[DONE:n]` markers
- execution state machine
- execution progress widget
- `/todos`
- execution-state recovery

When the user chooses **Execute the plan**, this extension leaves Plan Mode, restores the exact previous tools, and sends the complete plan back to the normal agent as a follow-up turn.

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
    ├── remove edit/write
    ├── add read-only planning tools
    ├── restrict bash
    └── inject Plan Mode instructions
    │
    ▼
agent produces Plan:
    │
    ├── Execute ──► restore tools ──► hand plan to normal agent
    ├── Refine  ──► remain in Plan Mode
    ├── Stay    ──► remain in Plan Mode
    └── Exit    ──► restore tools
```

## Context overhead

The extension registers no LLM-callable tools.

The Plan Mode instruction is injected only while Plan Mode is active. After exit, the context hook removes stale Plan Mode instruction messages so they do not remain in later model turns.

There is no plugin-level plan length limit.

## Safety boundary

Plan Mode disables built-in `edit` / `write` and filters `bash` through a read-only allowlist.

As in Pi's official example, other already-active custom extension tools remain available. If a custom tool can mutate state, Plan Mode does not automatically make that custom tool read-only.
