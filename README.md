# pi-plugins

Pi extensions monorepo. Each directory is self-contained; see its own README.

- `pi-locked-subagents/` — config-locked subagents (`subagent(agent, task)`)
- `pi-plan-mode/` — planning-only variant of Pi plan mode
- `pi-fff-minimal/` — low-context fork of `@ff-labs/pi-fff`
- `cpa-codex-ws/` — CPA GPT channels via Pi native Codex Responses WebSocket transport
- `native-responses-web-search/` — opt-in Standard Responses native hosted web search channel
- `cpa-plugin-muse-spark/` — CLIProxyAPI v7 native plugin for `muse-spark-1.3-contributor`

## Design rule

Keep the always-visible surface small. Put behavior in local configuration or opt-in commands instead of adding more LLM-callable tools and schemas.
