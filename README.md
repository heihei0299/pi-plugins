# pi-plugins

Small Pi extensions optimized for low parent-context overhead.

## pi-locked-subagents

A deliberately small subagent extension:

- exactly **one** parent-facing LLM tool: `subagent`
- exactly **two** arguments: `agent` and `task`
- model, thinking, tools and policy are locked in local config
- optional `allowedAgents` restricts which roles a child can discover and delegate to
- nested delegation is bounded by `maxDepth` (default: `2`)
- fresh one-shot child: `pi -p --no-session`
- child context files, skills, prompts and themes are disabled by default
- custom provider extensions remain available by default for providers such as CPA
- no plugin token, line, byte, turn or deadline limit
- full child JSON event stream is written to disk
- only the child's final assistant answer is handed back to the parent

The parent sees one tool plus a bounded role catalog:

```text
subagent(agent, task)

Available subagents:
- reviewer: Review code independently for concrete defects.
- scout: Explore the codebase and locate relevant files and flows.
- worker: Implement a self-contained coding task.
```

The `agent` parameter is advertised as an enum when the config is readable at extension load time, so the model can select a role directly instead of searching the filesystem. Only role names and short descriptions are exposed; model/thinking/tools/system prompt/session/timeout controls stay local and locked. Reload Pi after adding or renaming roles so the advertised catalog refreshes.

### Nested delegation

`allowedAgents` is a child visibility allowlist. Before a child Pi starts, the parent passes only that role list to the child process. The child extension filters its registry before building the tool description, so disallowed role names never enter that child's model context.

Example:

```text
worker
├── scout
└── reviewer
    └── scout

scout
└── no delegation
```

Use:

```json
{
  "maxDepth": 2,
  "agents": {
    "worker": {
      "allowedAgents": ["scout", "reviewer"],
      "tools": ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"]
    },
    "reviewer": {
      "allowedAgents": ["scout"],
      "tools": ["read", "grep", "find", "ls", "bash", "subagent"]
    },
    "scout": {
      "allowedAgents": [],
      "tools": ["read", "grep", "find", "ls"]
    }
  }
}
```

If `allowedAgents` is omitted, delegation defaults to none. A child only receives the `subagent` tool when all three conditions hold: its role has allowed agents, its configured tools include `subagent`, and the next child would remain below `maxDepth`. The default `maxDepth: 2` permits root → child → grandchild, but no deeper delegation.

Configuration validation rejects non-string allowlists, unknown agent names, direct self-reference, and invalid depth values. Indirect cycles are bounded by the depth guard instead of requiring a complex graph scheduler.

### Why transcripts are separate

The child runs in Pi JSON mode. Its complete stdout event stream is written incrementally to:

```text
~/.pi/agent/subagent-runs/<timestamp>-<uuid>.jsonl
```

The extension parses only enough of that stream to retain the latest completed assistant message. Tool calls, intermediate messages and other child events stay out of the parent context.

There is no plugin-level output truncation. This does not remove natural limits imposed by the selected model, provider, Pi runtime or the parent model's own context window.

Override the run directory with:

```bash
export PI_LOCKED_SUBAGENTS_RUN_DIR=/path/to/runs
```

### Structure

```text
pi-locked-subagents/
├── index.ts                      # tool registration and orchestration entry
├── config.ts                     # config types, validation, env-scoped filtering
├── registry.ts                   # model-visible agent catalog
├── runner.ts                     # child Pi args, spawn, JSONL result capture
└── locked-subagents.example.json
```

The root `pi-locked-subagents.ts` file is only a compatibility shim that re-exports the folder entrypoint.

### Install

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-locked-subagents ~/.pi/agent/extensions/
cp pi-locked-subagents/locked-subagents.example.json ~/.pi/agent/locked-subagents.json
```

Then edit the JSON and reload Pi:

```text
/reload
/subagents
```

Example agent:

```json
{
  "agents": {
    "reviewer": {
      "description": "Review code independently for concrete defects.",
      "allowedAgents": ["scout"],
      "model": "cpa/gpt-5.6-luna",
      "thinking": "high",
      "tools": ["read", "grep", "find", "ls", "bash", "subagent"],
      "systemPrompt": "Review independently. Do not modify files.",
      "isolate": {
        "noExtensions": false,
        "noSkills": true,
        "noContextFiles": true,
        "noPromptTemplates": true,
        "noThemes": true,
        "noApprove": true
      }
    }
  }
}
```

The model cannot be overridden by the parent because `model` is not part of the tool schema. Task text is passed after `--`, so it cannot become a Pi CLI flag.

## pi-plan-mode

A separate lightweight plan-mode extension lives under `pi-plan-mode/`. Plan and subagent orchestration intentionally remain independent: plan mode should not require a subagent framework, and subagents should not inject planning machinery into every parent turn.

## pi-fff-minimal

A low-context fork of `@ff-labs/pi-fff` lives under `pi-fff-minimal/`.

- defaults to FFF-backed `find` / `grep` override mode
- removes upstream `promptGuidelines`
- keeps compact tool snippets and parameter schemas
- preserves FFF indexing, fuzzy search, frecency/git ranking, pagination, watcher, health/rescan commands, and @-mention support
- keeps multi-grep disabled by default

Use this fork when you want FFF search performance without adding duplicate `fffind` / `ffgrep` tools or verbose model instructions.

## Design rule

Keep the always-visible surface small. Put behavior in local configuration or opt-in commands instead of adding more LLM-callable tools and schemas.

For locked subagents, keep the architecture layered but intentionally small:

```text
config -> registry/advertisement -> runner -> child Pi -> final result
             ^
             |
        parent tool entry
```

Do not add a lifecycle manager until the extension actually needs background agents, resume, steering, or durable orchestration.
