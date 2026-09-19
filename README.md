# pi-plugins

Pi extensions monorepo. Each directory is self-contained; see its own README.

- `jev/` — explicit typed Jev decisions through Vercel AI Gateway (`jev_evaluate`)
- `pi-locked-subagents/` — config-locked subagents (`subagent(agent, task)`)
- `pi-plan-mode/` — planning-only variant of Pi plan mode
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

This installs the root Pi package and loads only the extensions declared in its manifest. A local-path install references the checkout; a Git/package install manages the root package separately and does not recursively install nested package manifests. For standalone deployment of `native-responses-web-search/`, copy the whole directory and follow its README so its runtime dependency is available.

Pi's core extension packages remain peer dependencies supplied by Pi.

## Design rule

Keep the always-visible surface small. Put behavior in local configuration or opt-in commands instead of adding more LLM-callable tools and schemas.
