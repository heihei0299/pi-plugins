# pi-locked-subagents

A deliberately small Pi extension for one job:

- expose **one** parent-facing LLM tool: `subagent`
- expose only **two** arguments: `agent` and `task`
- lock `model`, `thinking`, tools, system prompt, and child resource policy in a local JSON file
- use a fresh one-shot child (`pi -p --no-session`)
- do not impose a plugin token limit, turn limit, or deadline
- keep custom Pi provider extensions available by default

## Why this is smaller in the parent context

The parent model gets only one custom tool schema:

```text
subagent(agent, task)
```

There is intentionally no:

```text
model
thinking
tools
timeout
max_turns
inherit_context
```

The parent LLM therefore cannot request another model. The extension reads the locked model from local config after the tool call.

Agent definitions and system prompts are **not** injected into the parent LLM context.

## Install

Copy:

```bash
mkdir -p ~/.pi/agent/extensions
cp pi-locked-subagents.ts ~/.pi/agent/extensions/
cp locked-subagents.example.json ~/.pi/agent/locked-subagents.json
```

Then edit:

```bash
$EDITOR ~/.pi/agent/locked-subagents.json
```

Restart Pi or run:

```text
/reload
```

Check configuration:

```text
/subagents
```

## Config

Default config path:

```text
~/.pi/agent/locked-subagents.json
```

Override it without changing the tool schema:

```bash
export PI_LOCKED_SUBAGENTS_CONFIG=/path/to/locked-subagents.json
```

Example:

```json
{
  "piBinary": "pi",
  "agents": {
    "reviewer": {
      "model": "cpa/gpt-5.6-luna",
      "thinking": "high",
      "tools": ["read", "grep", "find", "ls", "bash"],
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

## Important for CPA/provider shims

`noExtensions` defaults to **false**.

This is intentional. If `cpa/gpt-5.6-luna` is registered by a Pi extension/provider shim, starting the child with `--no-extensions` can make the model disappear.

If your provider works without extension discovery and you want the smallest child context, set:

```json
"noExtensions": true
```

Pi supports explicit `-e` extensions even with `--no-extensions`; add paths under `isolate.extensions` if you need only a specific provider extension.

## Hard model lock

The tool call has no model field. For:

```json
"reviewer": {
  "model": "cpa/gpt-5.6-luna"
}
```

the process command is constructed from local config as:

```bash
pi -p --no-session --model cpa/gpt-5.6-luna ...
```

The task supplied by the parent is placed after `--`, so task text cannot become CLI flags.

There is also deliberately no arbitrary `extraArgs` config controlled by the LLM.

## Limits

This extension adds **no** token ceiling, max-turn setting, child deadline, or concurrency governor.

Normal limits still exist outside the extension:
- the selected model's context window
- provider/API limits
- Pi/runtime tool-result truncation and process behavior

## Security note

The child inherits the parent process environment, including provider credentials, because that is how Pi normally finds them. Tool access is controlled per configured agent.
