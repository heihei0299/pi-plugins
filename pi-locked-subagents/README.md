# Pi Locked Subagents

A Pi extension that exposes `subagent(agent, task)` only for roles declared in a local configuration file. The role, model, thinking level, tools, system prompt, and delegation policy are read from that file; callers cannot select another model or provider at runtime.

## Install

The root package declares this extension:

```bash
pi install /absolute/path/to/pi-plugins
```

After changing the configuration, run `/reload`. Use `/subagents` to display the configured roles.

## Configuration

Default path: `~/.pi/agent/locked-subagents.json`. Override it with `PI_LOCKED_SUBAGENTS_CONFIG`.

```json
{
  "piBinary": "pi",
  "maxDepth": 2,
  "agents": {
    "worker": {
      "description": "Implement a self-contained coding task.",
      "model": "provider/model-id",
      "thinking": "high",
      "tools": ["read", "bash", "edit", "write"],
      "env": ["OPENAI_API_KEY"],
      "allowedAgents": ["scout"],
      "isolate": {
        "noExtensions": true,
        "noSkills": true,
        "noContextFiles": true,
        "noPromptTemplates": true,
        "noThemes": true,
        "noApprove": true
      }
    },
    "scout": {
      "description": "Explore the codebase without modifying files.",
      "model": "provider/model-id",
      "tools": ["read", "grep", "find", "ls"]
    }
  }
}
```

`model` is passed to the child Pi with `--model`; the corresponding provider/model and credentials must be available to that Pi installation. `allowedAgents` controls which roles a worker may delegate to. Delegation is also limited by `maxDepth` (default `2`).

## Worker permissions and isolation

The configured `tools` list is the worker's Pi tool list. Giving a worker `bash` allows it to run shell commands with the child process user's operating-system permissions; giving it `edit` or `write` allows file changes. This extension is not an operating-system sandbox and does not restrict filesystem, network, or provider access granted by those tools.

Isolation flags disable skills, context files, prompt templates, themes, and approval handling by default. Extensions remain enabled unless `noExtensions` is set; when extensions are disabled, entries in `isolate.extensions` are loaded explicitly. These flags reduce Pi input and extension surface but do not make a worker safe to trust with arbitrary tasks.

The child receives a small default environment (`HOME`, `PATH`, locale/terminal variables, selected XDG paths, and the locked-subagent control/configuration paths). Parent environment variables are not copied wholesale. Provider credentials are not inherited by default: list the required variable names under the agent's `env` array, for example `OPENAI_API_KEY`. Values are copied from the parent only for those names. Environment allowlisting does not prevent a worker with `bash` from reading credentials stored in files accessible through its `HOME` or filesystem permissions.

## Resource and failure boundaries

Each worker has these fixed defaults:

- execution timeout: 120 seconds;
- bounded stderr retained: 256 KiB;
- transcript archive: 8 MiB;
- parent-visible final output: 24 KiB.

Child JSONL stdout is parsed and archived incrementally, so event-stream volume is not treated as the final reviewer-result size and does not trigger the old 1 MiB stdout kill switch. When the transcript archive reaches its limit, additional lines are not archived, `transcriptTruncated` is reported, and the worker continues so its final state can still be parsed. Stderr is retained only up to its bound and does not terminate a healthy worker by itself.

If the final assistant text exceeds the parent-visible limit, the complete redacted text is written to a restricted sidecar file below `~/.pi/agent/subagent-runs` (or `PI_LOCKED_SUBAGENTS_RUN_DIR`). The parent receives a bounded head/tail projection with the sidecar path, and result details include `outputPath`, `projected`, and the byte counts. Transcripts use the same restricted directory/file permissions. A worker succeeds only when it exits normally and emits a valid final `message_end` event; a zero exit code alone is not sufficient.

The transcript path is included in failure details for diagnosis. Error messages do not copy the child environment or credential values.

## Tool usage

Call the registered tool with a configured role and a self-contained task:

```text
subagent(agent="worker", task="Inspect the parser and add a focused regression test.")
```

If configuration cannot be loaded, the requested role is unknown, the depth limit is reached, the worker protocol is incomplete, or the worker exits/times out/exceeds an output limit, the tool returns an error instead of reporting success.
