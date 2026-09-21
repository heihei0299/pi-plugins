# pi-plugins

Pi extensions monorepo. Each directory is self-contained; see its own README.

- `jev/` — explicit typed Jev decisions through Vercel AI Gateway (`jev_evaluate`)
- `pi-locked-subagents/` — config-locked subagents (`subagent(agent, task)`)
- `pi-plan-mode/` — planning-only variant of Pi plan mode
- `pi-context-audit/` — passive context-size and tool-result audit
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

This installs the root package, its runtime dependencies, and all five extensions declared in its manifest. A local-path install references the checkout; a Git/package install manages the root package separately.

Pi's other core extension packages remain peer dependencies supplied by Pi.

## Testing

Run the targeted locked-subagents tests with Bun:

```bash
bun test pi-locked-subagents/runner.test.ts
```

## Design rule

Keep the always-visible surface small. Put behavior in local configuration or opt-in commands instead of adding more LLM-callable tools and schemas.
