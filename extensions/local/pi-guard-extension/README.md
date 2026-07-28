# Pi Guard Extension 🔒

A [pi](https://pi.dev) extension that enforces the **"no unauthorized actions after skill conversations"** policy at the tool-call level.

## Problem

When an AI assistant finishes a skill-based conversation (e.g., `/skill:to-spec`, `/skill:grill-me`), it might attempt to write files or execute commands without explicit user permission — violating project rules like the one in `AGENTS.md`:

> 使用 `grill-with-docs`、`wayfinder`、`grill-me`、`to-spec`、`to-tickets` 技能与用户完成讨论后，不得对工作目录下的任何文件执行写操作（创建、修改、删除），不得执行任何命令。

This extension enforces that rule mechanically by intercepting tool calls.

## How It Works

The guard is a **three-state state machine**:

```
                    input target skill command
  ┌─────┐  ──────────────────────────────────► ┌──────┐
  │normal│                                      │skill │
  │      │◄──── /guard:allow ────────────────── │_active│
  └─────┘                                       └──┬───┘
       ▲                                            │
       │                              agent_settled  │
       │                                            ▼
       │                                        ┌────────┐
       └───────── /guard:allow ──────────────── │guarded │
                                                └────────┘
```

| Transition | Trigger |
|---|---|
| `normal` → `skill_active` | User runs `/skill:to-spec`, `/skill:to-tickets`, `/skill:grill-me`, `/skill:grill-with-docs`, or `/skill:wayfinder` |
| `skill_active` → `guarded` | `agent_settled` event (skill processing fully complete) |
| `guarded` → `normal` | User runs `/guard:allow` command |
| `guarded` → `skill_active` | User runs another target skill command |

In **`guarded`** mode, the following tools are **blocked**:
- `write` — blocked + `ctx.abort()`
- `edit` — blocked + `ctx.abort()`
- `bash` — blocked + `ctx.abort()` (all commands, including read-only ones)

Read-only tools (`read`, `grep`, `find`, `ls`) pass through normally.

When a session is **resumed** (`/resume`), the extension scans session history and restores `guarded` state if a target skill was previously activated.

## Installation

### Quick test

```bash
pi -e ./pi-guard-extension
```

### Install as a pi package

```bash
pi install ./pi-guard-extension
```

Or from npm (once published):

```bash
pi install npm:pi-guard-extension
```

### Project-local installation

```bash
pi install -l ./pi-guard-extension
```

## Usage

After installation, the guard is active automatically.

### Blocking behavior

When the guard is in `guarded` mode and the AI attempts a blocked operation, you'll see:

```
🔒 技能讨论已完成，禁止擅自操作。
Guard mode: skill conversation completed, unauthorized actions blocked.
请使用 /guard:allow 临时关闭守卫。
Use /guard:allow to temporarily disable guard mode.
```

The tool call is blocked and the agent turn is aborted.

### `/guard:allow` command

To temporarily disable the guard (e.g., when you want the AI to write files after a skill conversation):

```
/guard:allow
```

The guard returns to `normal` mode. It will re-activate automatically when you run another target skill command.

### Session resume

When you `/resume` a session where target skills were used, the guard is automatically restored to `guarded` state.

## Configuration

### Custom target skills

You can customize which skills trigger the guard by importing `createGuard` in your own extension:

```typescript
import { createGuard } from "./path/to/pi-guard-extension/src/index.ts";

export default createGuard({
  targetSkills: ["to-tickets", "grill-me", "my-custom-skill"],
});
```

### Default skills

```typescript
const DEFAULT_TARGET_SKILLS = [
  "to-spec",
  "to-tickets",
  "grill-me",
  "grill-with-docs",
  "wayfinder",
];
```

## Architecture

pi-guard-extension/
├── package.json          # Package manifest with pi extension entry
├── tsconfig.json         # TypeScript configuration
├── vitest.config.ts      # Test configuration
├── src/
│   ├── index.ts          # Extension main logic (event handlers + factory)
│   ├── index.test.ts     # Integration tests for event handlers
│   ├── guard.ts          # Pure state machine (normal → skill_active → guarded)
│   └── guard.test.ts     # Unit tests for state machine
└── README.md             # This file

### Key components

- **`guard.ts`** — `createStateMachine()` factory returning a pure state machine (GuardMachine interface) managing the three states and transitions.
- **`index.ts`** — Extension glue that wires the state machine to pi events:
  - `session_start` — Rebuild state from session history.
  - `input` — Detect target skill commands.
  - `agent_settled` — Transition to guarded mode.
  - `tool_call` — Block write/edit/bash when guarded.
- **`/guard:allow`** — Command to temporarily disable guard.

### Events used

| Event | Purpose |
|---|---|
| `session_start` | Rebuild guard state on session load/resume |
| `input` | Detect target skill commands |
| `agent_settled` | Detect skill completion → enter guarded |
| `tool_call` | Intercept write/edit/bash in guarded mode |

## Development

```bash
# Type-check
npx tsc --noEmit --strict

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Test in print mode
pi -e . -p "test prompt"
```

## Publishing

To publish to npm:

```bash
npm publish
```

Make sure `package.json` includes the `"pi-package"` keyword for pi gallery discoverability.

## License

MIT
