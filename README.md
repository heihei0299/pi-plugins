# pi-plugins

Pi extensions monorepo. Each directory is self-contained; see its own README.

- `pi-locked-subagents/` — config-locked subagents (`subagent(agent, task)`)
- `pi-plan-mode/` — planning-only variant of Pi plan mode
- `pi-fff-minimal/` — low-context fork of `@ff-labs/pi-fff`
- `cpa-codex-ws/` — CPA GPT channels via Pi native Codex Responses WebSocket transport
- `native-responses-web-search/` — opt-in Standard/Codex Responses native hosted web search channels

## Install as a Pi package

The repository root is a Pi package. Install it from Git and Pi will discover all TypeScript extensions declared in `package.json`:

```bash
pi install git:<host>/<owner>/pi-plugins
```

For a local checkout:

```bash
pi install /absolute/path/to/pi-plugins
```

The package installs the FFF runtime dependencies automatically. Pi's core extension packages remain peer dependencies supplied by Pi.

## Design rule

Keep the always-visible surface small. Put behavior in local configuration or opt-in commands instead of adding more LLM-callable tools and schemas.
