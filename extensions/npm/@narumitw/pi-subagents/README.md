# 🧑‍🤝‍🧑 pi-subagents — Isolated Subagents for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-subagents` is a native [Pi coding agent](https://pi.dev) extension for delegating work to specialized agents. By default, it exposes eight capability-specific tools: blocking batches, explicit autonomous workflow planning, four detached lifecycle tools, side-effect-free inspection, and synchronous read-only consultation. Users can keep every delegation method, choose async-only delegation, retain only blocking delegation, or disable delegation while keeping inspection available.

Use it to split independent research, planning, implementation, and review work across focused workers. Under the default next-turn delivery policy, background delegation is for work the current response does not depend on. Opt-in auto-resume also supports final-answer-dependent background work by requesting a synthesis turn after completion.

## ✨ Features

- Offers all delegation methods by default, with goal-oriented presets for async-only, blocking-only, or disabled delegation.
- Adds `subagent_inspect` for bounded metadata without child launch, mailbox-content access, acknowledgement, or mutation.
- Adds `subagent_consult` for one synchronous ephemeral child constrained to built-in `read`, `grep`, `find`, and `ls` tools (or a narrower agent allow-list).
- Adds explicit `subagent_auto` requests that use one bounded read-only planning turn and a deterministic compiler to select the smallest justified existing workflow without changing omitted-field behavior.
- Keeps batch workers isolated in `pi --mode json -p --no-session` subprocesses.
- Lets users set a blocking parallel call's maximum worker count from 1 through 64 while keeping four-at-a-time execution.
- Registers detached stateful lifecycle tools by default; completion can stay queued for the next turn or opt into an idle root synthesis turn.
- Supports an opt-in public-SDK `in-process` stateful transport with one reusable child `AgentSession` per `agentId`.
- Supports an opt-in persistent `rpc` transport with one isolated Pi RPC process per active retained agent and `pi-subagents:v1` lifecycle metadata.
- Supports deterministic opt-in `auto` routing: read-only built-ins use in-process, write-capable built-ins use RPC, and custom tools use the compatibility subprocess path.
- Supports built-in `scout`, `planner`, `reviewer`, and `worker` agents.
- Loads custom user agents from `~/.pi/agent/agents/*.md`.
- Optionally loads project agents from `.pi/agents/*.md` with confirmation.
- Provides a current-session-first `/subagents` manager, direct `settings|status|help` routes, and compatibility aliases for agent tools and retained agents.
- Supports trust-aware per-task `cwd` policies, task-selected work, workflow, idle, turn, and tool-call budgets, deterministic timeout checkpoints, bounded abort-then-summary recovery, progress telemetry, and explicit Fast, Balanced, or Deep thinking profiles.
- Uses Pi-native tool rows throughout; blocking and consultation calls add bounded custom live activity.
- Bounds JSON lines, captured messages, stderr, final output, chain substitution, and fan-in context.
- Enforces a recursion-depth guard and deterministic process-group termination.
- Provides addressable stateful agents with follow-up, consolidated mailbox/management actions, idempotent spawn retries, context selection and preview, versioned structured outcomes, and persistence.
- Publishes built-in and custom agent capability manifests, then records the executor-owned `ExecutionPlan` that resolves requested authority to effective tools, model, thinking, timeout, transport, trust, and workspace controls.
- Runs explicit dependency workflows through a persistent `WorkItem` ledger, dependency-aware scheduler, declared scope-conflict checks, artifact provenance, stale-result invalidation, and bounded overall deadlines.
- Runs first-class blocking panels with two or more independent reviewers, incremental bounded evidence artifacts, preserved blockers and dissent, a minimum-valid-review barrier, reserved synthesis and cleanup budgets, and one evidence-preserving synthesis.
- Supports bounded retries only for explicitly idempotent work and hedged execution only for explicitly read-only work.
- Detects retained-agent semantic skew across agent definitions, role prompts, tools, model resolution, transport, trust, repository generation, artifacts, and scheduler policy before follow-up work starts.
- Publishes transient runtime status through Pi's generic extension status API while subagents are running.
- Returns complete bounded worker output in tool details and a concise result for the main agent.

## 📦 Install

```bash
pi install npm:@narumitw/pi-subagents
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-subagents
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-subagents
```

## 🛠️ Pi tool

`pi-subagents` registers eight tools by default. Run `/subagents`, choose **Change delegation**, review the concrete tool changes, then select **Save and reload** to apply one of these workflows:

| Workflow | Registered tools |
| --- | --- |
| **All delegation methods** (default) | Existing five delegation/lifecycle tools, `subagent_auto`, `subagent_inspect`, and `subagent_consult` |
| **Async only** | Four detached lifecycle tools plus `subagent_inspect`; blocking `subagent` and `subagent_consult` are omitted |
| **Blocking only** | `subagent`, `subagent_auto`, `subagent_consult`, and `subagent_inspect` |
| **Disabled** | `subagent_inspect` only; delegation is disabled |

The preview compares the selection with the tools registered in the current session, even when a manual settings edit is pending, and remains read-only until confirmation. Escape or **Cancel** leaves settings unchanged. Tool removal requires an extension reload because Pi does not expose extension tool unregistration. To avoid aborting work or removing isolated worktrees during `session_shutdown`, workflow changes are blocked while detached agents are retained; finish or clear them through **Current agents** first. Pi owns reload-error reporting and does not return a success result to extensions, so the save notification also tells users to run `/reload` if the tool surface does not refresh.

The available tools are:

- `subagent` — delegate blocking single, parallel, fan-in, chained, panel-review, or explicit dependency-workflow tasks. The main agent cannot process queued steering until the call returns.
- `subagent_auto` — explicitly request one read-only planning turn followed by deterministic compilation and, only when admitted, execution through the existing blocking workflow engine.
- `subagent_spawn` and related lifecycle tools — when enabled, start reusable detached work, return immediately, and receive bounded completion messages automatically.
- `subagent_inspect` — inspect agent/model/run/runtime metadata without launching work or changing state.
- `subagent_consult` — run one ephemeral read-only consultation and wait for its answer.

### Interactive tool rows

In Pi's interactive TUI, every registered tool uses Pi's native tool shell and theme. Call rows identify the action, agent or retained id, scope, and a bounded task/message preview. Result rows use explicit `Starting`, `Running`, `Completed`, `Failed`, `Cancelled`, `Interrupted`, or `Closed` text in addition to icons and color.

Collapsed rows stay scan-friendly: consultation and blocking calls show recent activity while running, completed answers show up to three lines, and list actions show up to five items. Use Pi's configured `app.tools.expand` keybinding (Ctrl+O by default) for the additional bounded task, policy, activity, answer, usage, inspection, or mailbox details available to that tool. The hint follows the user's keybinding rather than assuming Ctrl+O.

`subagent_consult` emits an initial starting update before launching its child and then reports the actual provider/model, thinking request, usage, and a safe projection of recent `read`, `grep`, `find`, and `ls` activity. Progress never includes full child messages, prompts, credentials, headers, or environment values. Tool-row previews remove terminal controls and redact private text.

`subagent_spawn` remains deliberately detached and non-polling: its tool row ends after returning the new `agentId` and initial retained state. It does not pretend to stream the background child after the tool call has completed; the existing completion message and configured delivery policy report eventual completion.

Custom transcript rendering is TUI presentation only. Tool names, parameter schemas, model-facing final content/details, errors, completion delivery, and print/JSON/RPC final output remain unchanged; JSON/RPC observers may see additive bounded consultation partial-progress details.

After each session starts, the descriptions of the registered `subagent`, `subagent_spawn`, and
`subagent_consult` tools include the same bounded parent-facing catalog of the agents available in
that session. Entries show the source (`built-in`, `user`, or `project`) and the `agentScope` needed to
invoke them; the `agent` parameters remain unconstrained strings for cwd and scope flexibility. The
catalog is rebuilt on
`/reload` or the next session start, and omitted entries are reported explicitly when the catalog
exceeds its metadata bounds.

Choose the API by lifecycle:

| Need | Use |
| --- | --- |
| The caller explicitly wants a high-level objective decomposed under an authority ceiling and aggregate budget | `subagent_auto`, when blocking delegation is enabled |
| A delegated result is required before the root's next action under default next-turn delivery | Use one blocking `subagent` call when registered. In **Async only**, complete the critical-path work directly or switch workflows before delegating it |
| Broad research/review the current response does not depend on | Prefer one `subagent_spawn` covering related branches, when lifecycle tools are enabled |
| Final-answer-dependent broad work with `completionDelivery: "auto-resume"` | Prefer one `subagent_spawn`; completion requests a synthesis turn |
| Reusable history, follow-ups, or mailboxes | `subagent_spawn` and lifecycle tools, when enabled |
| Side-effect-free agent/model/run diagnostics | `subagent_inspect` |
| Synchronous reconnaissance, planning, or review that must not write | `subagent_consult`, when blocking delegation is enabled |
| One simple or critical-path action the root can perform directly | No subagent |

Execution modes:

- **single** — run one `{ agent, task }` job.
- **parallel** — run multiple `{ agent, task }` jobs independently.
- **parallel + aggregator** — run parallel jobs, then pass all outputs into one fan-in agent.
- **chain** — run sequential steps, passing prior output with `{previous}`.
- **workflow** — run named tasks only after declared `dependsOn` tasks and required `inputArtifacts` are ready; independent conflict-free tasks may run concurrently.
- **panel** — run at least two independent reviewers over one shared task and snapshot, then run one synthesizer only when `minValidReviews` valid evidence artifacts remain.

Common controls:

- `cwd` — choose a launch directory subject to the user-owned trust-aware target policy described below.
- `timeoutMs` — choose the per-turn work deadline for the task difficulty.
- `totalTimeoutMs` — cap an entire blocking single, parallel, chain, panel, or fan-in workflow, including queued work and reserved panel phases.
- `idleTimeoutMs` — stop work that produces no completed assistant turn or tool result within the selected interval.
- `maxTurns` / `maxToolCalls` — stop unfinished repeated work after bounded assistant turns or tool calls.
- `thinkingLevel` — request `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` thinking for the spawned Pi process or retained child.
- `idempotencyKey` — make an exact `subagent_spawn` retry return the existing retained `agentId`; reuse with different parameters fails before confirmation, worktree creation, or child launch.
- `resultFormat` — keep bounded text by default, request legacy `structured-v1`, or request `structured-v2` with explicit outcome status, reason code, claims, artifacts, verification, limitations, and unresolved dependencies.
- `totalTimeoutMs` — bound a whole explicit blocking workflow; no new task starts after the budget is exhausted.

For `subagent_spawn`, the root agent selects the lowest thinking level and shortest realistic work deadline sufficient for the delegated task. These are tool-argument decisions made from the task already in context; `pi-subagents` does not run a string heuristic or an extra classifier model call.

## 🔐 Working-directory trust policy

Pi records saved project trust in `~/.pi/agent/trust.json`. The closest saved decision for the canonical target or one of its parents wins, so trusting a worktree parent covers worktrees below it while a nearer `false` overrides a trusted parent. `pi-subagents` reads this through Pi's public `ProjectTrustStore`; it never parses, writes, or migrates the file. Open Pi in a folder and use `/trust` to manage trust, then restart Pi before expecting retained-runtime behavior to change.

The default target policies are:

| Setting | Values | Default behavior |
| --- | --- | --- |
| `cwdPolicy.consultation` | `"anywhere"`, `"current-workspace"` | `"anywhere"`: consultation may start in any existing directory, but a target without effective trust is forced to `resources: "none"` |
| `cwdPolicy.delegation` | `"trusted-targets"`, `"current-workspace"`, `"anywhere"` | `"trusted-targets"`: blocking and detached delegation may target the current workspace or an external folder covered by a saved `true` decision |

All paths are resolved relative to the current session workspace and canonicalized before containment and trust checks. Missing paths, non-directories, sibling paths, and symlink escapes cannot bypass the policy. Blocking parallel, chain, panel, and fan-in calls preflight every target before any child starts. A generated `workspaceMode: "worktree"` inherits the resolved trust of its approved base cwd.

`"anywhere"` for general delegation restores the previous external-target flexibility. An external target without effective trust starts with `projectTrusted: false`, so Pi-protected project settings, packages, extensions, skills, prompts, and system resources stay disabled. General agents still have their configured tools and ordinary Pi/OS permissions, and Pi may still load `AGENTS.md` or `CLAUDE.md` because those context files are not protected by project trust. Resource-free consultation is stricter: it also passes `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-approve`, and `--no-extensions`.

These controls govern child starting directories and automatically loaded resources. They do **not** restrict absolute paths, shell commands, custom tools, network access, extension code, or filesystem access available to the Pi process. For real isolation, run Pi in a container, VM, micro-VM, or OS sandbox with only the required paths and credentials mounted.

## 🧭 Proactive use

When registered, the blocking `subagent` tool advertises only blocking guidance. When stateful lifecycle tools
are registered, `subagent_spawn` adds detached guidance for the active completion-delivery policy.
Changing the policy through `/subagents settings` refreshes that guidance immediately.

The `subagent`, `subagent_spawn`, and `subagent_consult` descriptions advertise the current agent
catalog automatically; no preliminary list call is needed. Built-ins and user agents appear under the
default `agentScope: "user"`. Trusted project agents appear separately and explicitly require
`agentScope: "project"` or `"both"`; project-authored names and descriptions are not read into
metadata for untrusted projects. If a project definition
shares a name with a user or built-in definition, the user version is the default and the project
version is used only for `"project"`/`"both"`. A user override of a built-in also shows the
built-in fallback available with `agentScope: "project"`; `"both"` keeps the user definition. The
catalog is bounded and reports its omission count; metadata discovery also caps files and bytes read
per scope. Refreshed metadata replaces the previous session's catalog rather than accumulating stale
entries.

Count-selection guidance:

- Use **no subagent** for simple answers, quick targeted edits, latency-sensitive one-step work, or
  critical-path work the main agent can perform directly.
- `subagent` is deliberately blocking: while it runs, the main agent cannot answer queued steering.
  Use it when delegated outputs are required before the next root action and waiting is intentional.
- With default `completionDelivery: "next-turn"`, prefer **one detached `subagent_spawn`** for broad
  research or review only when the current response does not depend on its result. When blocking
  `subagent` is registered, use it for required delegated output because an idle root is not awakened.
  In **Async only**, complete required work directly, opt into `auto-resume` when a later synthesis
  turn is appropriate, or switch delegation workflows.
- With `completionDelivery: "auto-resume"`, prefer one detached `subagent_spawn` for broad related
  research or review even when the final answer depends on it; completion requests a later synthesis
  turn. Do not choose blocking parallel fan-out merely to keep delegation in one turn.
- Use detached `subagent_spawn` only when lifecycle tools are enabled and a bounded independent task
  has a concrete isolation or specialization benefit. After spawning, do useful non-overlapping work
  immediately. Do not poll lifecycle tools for progress or duplicate the delegated work.
- Add another detached agent only for truly independent work with safe workspace concurrency.
  If synchronous parallel or fan-in output is genuinely required, keep blocking `subagent` tasks independent, stay within the configured `blocking.maxParallelTasks` limit, and do not parallelize implementation that may edit the same files or shared state.
  The limit defaults to 8, accepts 1 through 64, and bounds total worker tasks in one call rather than the four-at-a-time execution concurrency.
- Do not use project-local agents unless the user explicitly opts into them with
  `agentScope: "project"` or `"both"`; keep confirmation enabled for untrusted repositories.

Examples where the main agent chooses the count:

No subagent for a known-file edit:

```txt
Rename one symbol in src/foo.ts.
```

One detached agent for a broad asynchronous review that the current response does not require, or when auto-resume is enabled (call `subagent_spawn`):

```json
{
  "agent": "reviewer",
  "task": "Review source, tests, and integration risks for the current changes. Do not edit files. Report PASS/FAIL/PARTIAL with evidence."
}
```

A blocking fan-out is reserved for output that must be synthesized before the root continues (call
`subagent`):

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Research auth-related source files. Report paths and open questions. Do not edit files."
    },
    {
      "agent": "scout",
      "task": "Research auth-related tests. Report coverage gaps. Do not edit files."
    }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge these findings into a concise implementation-risk summary. Use {previous}."
  }
}
```

## 🧠 Explicit autonomous workflow planning

`subagent_auto` is an opt-in surface separate from the large multi-mode `subagent` schema.
It never intercepts ordinary prompts and does not change existing calls when omitted.
The caller supplies one versioned objective, non-goals, required inputs, acceptance criteria, required evidence, an authority ceiling, an aggregate budget, and deterministic constraints.

```json
{
  "request": {
    "version": "pi-subagents:automation-request:v1",
    "objective": "Implement and verify the package change",
    "nonGoals": ["Do not publish or release"],
    "requiredInputs": ["current trusted repository"],
    "acceptanceCriteria": ["Focused and root checks pass"],
    "requiredEvidence": ["test output", "final diff review"],
    "authorityCeiling": {
      "capabilities": ["implementation", "code-review"],
      "tools": ["read", "bash", "edit", "write"],
      "readPaths": ["packages/pi-subagents"],
      "writePaths": ["packages/pi-subagents"],
      "network": "unspecified",
      "secrets": "unspecified",
      "sideEffectPolicy": "mutating"
    },
    "aggregateBudget": {
      "timeoutMs": 180000,
      "maxTurns": 30,
      "maxToolCalls": 60,
      "maxTasks": 4,
      "maxRevisions": 1
    },
    "constraints": {
      "contextPressure": "high",
      "maxMutatingWidth": 2,
      "requireVerification": true,
      "workspaceMode": "shared"
    }
  }
}
```

The planner always uses the built-in `planner` with only `read`, `grep`, `find`, and `ls`, disabled extensions and session persistence, trust-aware prompt resources, a maximum 60-second planning deadline, and bounded turn/tool-call counts.
The planner returns only `pi-subagents:workflow-plan:v1` JSON and cannot choose agents, grant authority, create descendants, or forge executor identities.
The executor reserves at most one quarter of the aggregate timeout, turns, and tool calls for planning before compiling execution work.
It rejects before planning when that reservation leaves no positive execution budget, and it narrows the request task ceiling to the configured blocking-task limit before compilation or persistence.

The compiler validates strict unknown-field and UTF-8 bounds, relative scopes, cycles, artifacts, ownership, capability routes, aggregate budgets, task generations, integration ownership, and the two-mutating-worker limit before execution.
Caller-level acceptance criteria and required evidence are merged into the authoritative terminal, integration-owner, and verifier contracts without exceeding contract item limits.
Path ceilings are compiler and conflict-scheduling constraints, not operating-system filesystem isolation; use a container or sandbox when host-level containment is required.
Network and secrets guarantees other than `"unspecified"` fail closed because the current executor cannot enforce them.
It can narrow or reject a proposal and can add one verifier only within the caller's remaining authority and budget.
Parent-owned, needs-input, planner-failed, and compiler-rejected outcomes launch no execution workers.
Every admitted mutating workflow has one authoritative integration owner and one distinct `structured-v2` verifier before any mutating worker starts.
Project-local agents are not selected by this first surface, workflow grandchildren are rejected, and `workspaceMode: "worktree"` fails closed until blocking workflow worktree execution is supported.

Pending, needs-input, verification-rework, stale, or invalidated work can be revised through the internal `pi-subagents:workflow-plan-patch:v1` contract.
Each accepted patch must match the current plan identity and workflow generation, rotates both identity and task generations, preserves accepted history/artifacts/receipts, and stops after the caller's revision limit.
The initial tool surface does not expose free-form public graph editing.

For compatibility or exact task control, use caller-authored `subagent.workflow`.
Before downgrading, use that explicit workflow fallback and let active automation calls finish.
Older releases do not register `subagent_auto` and ignore the separate versioned automation records under `~/.pi/agent/pi-subagents-workflows/`; no settings migration is required.
No benchmark result in this release changes the default delegation policy or makes a production-quality claim.

## 🔎 Read-only inspection

`subagent_inspect` is registered in every workflow, including disabled delegation. It never starts a child, sends or acknowledges mailbox messages, interrupts or closes a run, changes settings, refreshes providers, resolves credentials, or modifies files.

| Action | Parameters | Result |
| --- | --- | --- |
| `list_agents` | Optional `agentScope` (default `user`) and `limit` (default 32, maximum 100) | Bounded agent metadata and omission counts |
| `get_agent` | Required `agent`; optional `agentScope` | One resolved definition, safe source path, configured tools, and consultation-effective tools; never the system prompt |
| `list_runs` | Optional `includeClosed` and `limit` (default 50, maximum 100) | Metadata-only retained-run summaries, turn generation, pending-completion count, and unread counts |
| `get_run` | Required `agentId` | Safe `cwd`, current run and turn generation, current-task/error summaries, thinking level, context footprint, protocol, effective transport, bounded timing/usage telemetry, structured result when valid, policy, history count, pending-completion count, and unread count |
| `list_workflows` | Optional `limit` (default 50, maximum 100) | Metadata-only persisted blocking-workflow summaries for the current session |
| `get_workflow` | Required `workflowId` | Bounded task states, generations, dependencies, plan identities, artifact metadata, verification state, and outcome reasons without artifact contents |
| `list_models` | Optional `limit` (default 50, maximum 100) | Session-scoped models, or the already-loaded available snapshot |
| `preview_context` | Optional `context` and `contextEntryIds` | Selected mode, user turns, source count, UTF-8 bytes, and truncation without returning context text |
| `status` | No additional fields | Effective workflow, runtime counts/transport, detached limit values, completion delivery, consultation resources, and configured/runtime settings with per-field sources |
| `diagnose` | No additional fields | Structured `pass`, `warning`, and `fail` checks; failed checks are report data rather than a tool error |

The schema rejects fields that do not belong to the selected action. Explicit `project` or `both` scope fails before project-agent discovery unless Pi already trusts the project. Run inspection never returns history output, stored context, or mailbox content; unread counts come from a metadata-only snapshot and do not acknowledge messages. Workflow inspection reads validated, redacted snapshots without quarantining or rewriting invalid files. Paths beneath the Pi agent directory use `~`, project paths are workspace-relative, model objects are projected through an allow-list, and model-facing text is bounded to 50 KiB or 2,000 lines.

`subagent_manage` no longer accepts its former compatibility `list` action. Use `subagent_inspect({ "action": "list_runs", "includeClosed": true })` for metadata-only discovery and `get_run` for detail.

## 📖 Read-only consultation

`subagent_consult` is registered whenever blocking delegation is enabled. It runs exactly one synchronous, non-retained child with `--no-session`, `--no-extensions`, and only the effective intersection of the agent tools with `read`, `grep`, `find`, and `ls`. A missing tool list receives those four defaults; an explicit `tools: []` receives `--no-tools`; write, shell, lifecycle, custom, and extension tools cannot enter the child allow-list. The executor policy remains authoritative even when the task or agent prompt asks for implementation.

```json
{
  "agent": "reviewer",
  "task": "Inspect the authentication changes and report correctness and security findings with paths.",
  "thinkingLevel": "high"
}
```

The actionless schema requires `agent` and `task` and accepts optional `agentScope`,
`confirmProjectAgents`, `cwd`, `timeoutMs`, and `thinkingLevel`. Any agent resolved from that scope may
be selected; consultation always intersects its configured tools with the enforced read-only
allow-list rather than defining a separate read-only agent category. An unknown name fails before
launch with a bounded name/source list for the requested scope. Project scope is rejected before
discovery when the project is untrusted. A trusted project agent still asks for confirmation by
default; non-interactive calls fail closed unless they explicitly send
`confirmProjectAgents: false`. Declining an interactive confirmation returns a normal cancelled result
without launching or charging a child.

`consult.resources` controls automatically inherited instruction resources:

| Value | Behavior |
| --- | --- |
| `"project-context"` (default) | Keep ordinary user context/system files and trusted project `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md`; disable skills and prompt templates |
| `"none"` | Use only the package consultation base, selected agent prompt, and enforced read-only instruction |
| `"all"` | Keep ordinarily discoverable trusted context/system/append-system files, skills, and prompt templates |

Extensions remain disabled for all three values. Pi core owns system-prompt source precedence: a trusted project prompt wins over the global prompt, with the global prompt used as fallback. A selected Pi prompt source must be a readable regular file; directories, FIFOs, devices, sockets, and unreadable sources fail before child launch. A current target uses the session's effective project trust, including session-only or CLI overrides. An external target uses the nearest saved trust decision. For an untrusted, explicitly denied, unsaved, or trust-error target, consultation remains available when `cwdPolicy.consultation` permits it but automatically downgrades to `resources: "none"`. This also disables context files because Pi does not protect `AGENTS.md` and `CLAUDE.md` with project trust alone. A saved-trusted external target uses the configured resource policy and discovers `SYSTEM.md`, `APPEND_SYSTEM.md`, and ordinary child context from that target rather than the parent workspace.

Both settings are user-owned in `~/.pi/agent/pi-subagents.json`; projects cannot override them. `cwdPolicy.consultation: "current-workspace"` rejects every canonical external target before agent discovery or launch even when that target is saved-trusted. This is not a path sandbox: read-only tools can still read an explicitly requested accessible absolute path.

Result details report the canonical safe cwd, current/external boundary, bounded target-trust decision/source/warning, requested and effective tools/resources, downgrade reason, agent/model/thinking/timeout metadata, and the facts that extensions, session persistence, and retained-agent state are disabled. They never dump prompt contents or the full trust store. Nested model usage is returned through Pi's usage field, so footer, `/session`, and RPC totals include consultation cost. Validation, disallowed targets, and launch failures throw. Failures after model launch preserve bounded partial evidence and usage while the finalized Pi tool result is marked as an error. Explicit abort, session replacement, and shutdown use the existing process-tree termination and temporary-file cleanup path; a work timeout additionally makes one separately bounded, tool-less summary attempt after abort.

## 🚀 Blocking batch examples

Every example in this section calls `subagent` and keeps the main agent unavailable until the batch
finishes. Use `subagent_spawn` instead when the work can complete asynchronously and its configured
completion policy supports when synthesis is needed.

Run one read-only reconnaissance agent:

```json
{
  "agent": "scout",
  "task": "Find the statusline extension entry points"
}
```

For genuinely random values, specify the range, duplicate policy, and a system randomness source instead of relying on model sampling, for example: `Use Python secrets to return 10 integers from 0 through 999; duplicates are allowed.`

Run multiple agents in parallel with a shared thinking level and one per-task override:

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Map package metadata files",
      "timeoutMs": 30000,
      "thinkingLevel": "low"
    },
    {
      "agent": "reviewer",
      "task": "Review TypeScript config consistency"
    }
  ],
  "timeoutMs": 120000,
  "thinkingLevel": "medium"
}
```

Omit `aggregator` entirely when parallel worker outputs should return directly. Do not send `null`,
empty strings, or an empty object for an unused optional field; for compatibility, an aggregator with
an empty or whitespace-only `agent` or `task` is treated as absent.

Run parallel workers, then aggregate their results:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find auth-related code" },
    { "agent": "scout", "task": "Find auth-related tests" }
  ],
  "aggregator": {
    "agent": "reviewer",
    "task": "Merge, dedupe, and verify these findings. Use {previous}."
  }
}
```

Run a chain where each step receives the previous output:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find subagent-related code" },
    {
      "agent": "planner",
      "task": "Using this context, plan the extension: {previous}"
    }
  ]
}
```

Run an evidence-preserving panel:

```json
{
  "panel": {
    "id": "auth-panel",
    "preset": "code-review",
    "task": "Review the authentication change for correctness and regressions.",
    "context": "Inspect the current repository snapshot and existing test evidence.",
    "reviewers": [
      { "id": "correctness", "agent": "reviewer", "focus": "Control flow and edge cases" },
      { "id": "tests", "agent": "reviewer", "focus": "Coverage and regression risk" }
    ],
    "synthesizer": { "agent": "reviewer" },
    "minValidReviews": 2
  },
  "totalTimeoutMs": 120000
}
```

Every reviewer receives the same shared task, context, target snapshot, and scope, but never receives sibling output.
Reviewer-specific `focus` text is appended after the shared block.
The executor accepts only strict `pi-subagents:panel-review:v1` artifacts, stamps reviewer provenance, and starts synthesis only after the valid-review barrier.
Agreement is corroboration rather than proof, and a vote cannot clear a correctness, safety, security, or explicit-requirement blocker.
If too few valid reviews remain, the tool returns `insufficient-panel` with bounded partial evidence and failure classes without running synthesis or claiming consensus.
Review, evidence-finalization, synthesis, and cleanup receive explicit phase allocations, and reviewer work cannot consume the synthesis or cleanup reserve.
Only transient launch or transport failures receive one bounded retry; invalid contracts, semantic stalls, permission failures, exhausted budgets, cancellation, and deterministic task failures do not.
Read-only reviewers share the approved target, while conservatively write-capable reviewers receive separate disposable Git worktrees from one clean base.
Worktrees isolate repository writes but do not isolate processes, the network, secrets, credentials, or the rest of the filesystem.
The blocking panel owns every reviewer, synthesizer, timer, generation, transport, and worktree and closes them when the call settles or Pi emits graceful session replacement or shutdown.
An uncatchable host kill or forced process termination cannot guarantee cleanup; inspect `git worktree list`, remove any confirmed generated `pi-subagent-worktree-*` entry, and run `git worktree prune` if the host terminated before Pi dispatched lifecycle cleanup.
Panel WorkItem snapshots persist metadata and artifact references for current-session inspection without storing raw review bodies.

Run an explicit dependency workflow:

```json
{
  "workflow": {
    "id": "auth-review",
    "tasks": [
      {
        "id": "inventory",
        "agent": "scout",
        "task": "Produce the auth inventory artifact.",
        "resultFormat": "structured-v2",
        "readPaths": ["src/auth"]
      },
      {
        "id": "review",
        "agent": "reviewer",
        "task": "Review the inventory and report verification evidence.",
        "dependsOn": ["inventory"],
        "inputArtifacts": ["auth-inventory"],
        "resultFormat": "structured-v2"
      }
    ]
  },
  "totalTimeoutMs": 120000
}
```

Managed verified execution is an explicit per-workflow contract.
The executor infers the final mutating integration owner when none is declared, synthesizes one distinct read-only verifier, runs declared deterministic checks in a disposable Git worktree overlaid with the submitted state, and accepts only the exact unchanged submitted state.
Every deterministic check has a stable evidence ID, a direct executable with argument-array invocation, and an optional relative `cwd` and timeout.
Only `git`, `node`, `npm`, and `npx` are accepted; shell command strings fail before child allocation.
The integration owner must request `structured-v2`, declare a non-empty `writePaths` scope, and name current required evidence through its delegation contract.
Every required evidence ID must match a currently passed executor-owned check; worker-authored artifact metadata never satisfies that binding.

```json
{
  "workflow": {
    "verifiedExecution": {
      "verifierAgent": "reviewer",
      "maxReworkCycles": 1,
      "checks": [
        {
          "id": "focused-test",
          "command": "npm",
          "args": ["test", "--", "feature"],
          "timeoutMs": 120000
        }
      ]
    },
    "tasks": [
      {
        "id": "implementation",
        "agent": "worker",
        "task": "Implement the contracted change.",
        "writePaths": ["src", "test"],
        "acceptanceCriteria": ["The focused regression test passes"],
        "resultFormat": "structured-v2",
        "contract": {
          "version": "pi-subagents:delegation:v2",
          "level": "full",
          "taskId": "implementation",
          "objective": "Implement the contracted change",
          "requiredEvidence": ["focused-test"],
          "sideEffectPolicy": "mutating"
        }
      }
    ]
  }
}
```

An advanced caller may provide the verifier task instead of letting the executor synthesize it.
That task must directly and only depend on the integration owner, use `structured-v2`, select the configured distinct verifier agent, and declare an enforced read-only contract without shell or custom tools.
The executor narrows accepted verifier authority to `read` even when the selected agent normally has broader tools, and disables verifier extensions, skills, prompt templates, and inherited context files.

The older explicit verifier contract remains available as a compatibility gate without managed integration:

```json
{
  "workflow": {
    "tasks": [
      {
        "id": "implementation",
        "agent": "worker",
        "task": "Implement the contracted change.",
        "resultFormat": "structured-v2",
        "contract": {
          "version": "pi-subagents:delegation:v2",
          "level": "full",
          "taskId": "implementation",
          "objective": "Implement the contracted change",
          "admission": {
            "contextPressure": "medium",
            "independentWorkItems": 1,
            "coupling": "dense",
            "verificationRequired": true,
            "verificationAvailable": true,
            "budgetAllowsChildren": true,
            "requirementsComplete": true
          }
        }
      },
      {
        "id": "verification",
        "agent": "reviewer",
        "task": "Independently verify the staged result.",
        "dependsOn": ["implementation"],
        "verifierFor": "implementation",
        "resultFormat": "structured-v2"
      }
    ]
  }
}
```

Cycles, missing dependencies, conflicting integration owners, recursive workflow grandchildren, and unsafe retry or hedge policies fail before child launch.
Workflow scheduling starts at most two mutating tasks concurrently, while declared read-only work may use the existing four-child ceiling.
Set `workflow.honorAdmission: true` only when explicit contract admission metadata should be allowed to decline parent-owned or insufficient-evidence work before launch; admission never silently widens the requested architecture.
Workflow result details include the final ledger, scheduling decisions, artifact versions, task generations, attempts, hedge use, accepted plan identity, and bounded capability-grant metadata.
A task that explicitly requires independent verification must have exactly one direct-dependent `verifierFor` task using a different agent, and both tasks must request `structured-v2`.
The producer stops in `awaiting-verification`, its own passing verification claims remain untrusted, and ordinary downstream tasks stay blocked until the executor records an accepted verifier receipt.
The verifier runs alone in a fresh subprocess context against one bounded Git-visible tree identity and must encode `verification-accepted`, `verification-rework`, or `verification-rejected` through the documented `structured-v2` status and reason fields.
Dirty-tree identity covers at most 1 MiB across separately framed staged and unstaged binary diffs plus bounded non-ignored untracked paths and bytes; submodules, unsupported states, and changing trees fail closed.
The compatibility gate preserves bounded rework or rejection evidence but does not replay the producer automatically.

With `verifiedExecution`, execution completion and acceptance are separate `pi-subagents:work-acceptance:v1` states.
A worker's own verification, confidence, prose, consensus, or exit status cannot move `pending` acceptance to `accepted`.
The executor-owned `pi-subagents:verification-receipt:v1` binds both tree captures, patch digest, changed paths, accepted scope, target and verifier generations and `ExecutionPlan` IDs, verifier identity, acceptance criteria, required current evidence, and bounded deterministic check receipts.
Each receipt is capped at 12 KiB, each stored check stream at 2 KiB, and oversized acceptance evidence fails closed rather than expanding tool details.
The verifier receives the original objective, current artifact metadata, immutable tree identity, and executor-owned check output rather than the worker narrative.
Verifier mutation, a stale or replaced generation, a failed or unsafe check, missing evidence, wrong scope, patch, plan, tree, or identity, cancellation, timeout, and unsupported Git state all produce non-success.
One verifier `rework` decision may rotate the worker and verifier generations when `maxReworkCycles` is `1`; prior grants are revoked, prior evidence remains history, only current requirements and findings are added, and a second rejection is terminal.
Crashes, timeouts, cancellation, ambiguous settlement, and drift are never replayed.
The disposable check worktree includes bounded tracked and non-ignored untracked files and is removed after checks.
When the repository has a local `node_modules` directory, the worktree is nested beneath it so normal Node and npm resolution can read the installed dependency tree without copying it.
The worktree isolates repository build output, but it does not make the installed dependency tree read-only and is not an operating-system sandbox for processes, network, secrets, absolute paths, or host credentials.
The accepted state remains the selected shared workspace; no general patch merge or conflict resolver is added.

Omitting `verifiedExecution` preserves prior workflow behavior, including the older explicit verifier gate above.
To downgrade, finish active workflows, remove `verifiedExecution`, and either use the explicit `verifierFor` compatibility form or perform verification in the parent.
Older package versions reject the unknown managed contract rather than silently providing its guarantees.
Explicit workflow transitions are atomically persisted as mode-0600, private-text-redacted snapshots for current-session `list_workflows` and `get_workflow` inspection; in-flight execution or acceptance restores as interrupted non-success, and no prior side effect is automatically resumed.
Legacy v1 and v2 records without acceptance fields retain their prior completed terminal meaning, while v1 self-reported verification flags and artifact trust remain untrusted.

## 🔁 Stateful agents

Stateful lifecycle tools are available by default. `subagent_spawn` is detached: it schedules work, returns immediately with an opaque `agentId`, and later injects a bounded `pi-subagent-completion` custom message. Every turn receives an executor-owned `runId`, monotonically increasing agent-local generation, and unique `completionId`. The terminal completion is persisted before delivery, simultaneous completions are batched, and the broker allows at most one in-flight root wake until that parent turn starts.

Detached work follows a non-polling policy. With default `next-turn` delivery, prefer one bounded `subagent_spawn` for related asynchronous research or review only when the current response does not depend on its result. If it does, use blocking `subagent` when registered; in **Async only**, complete required work directly, opt into `auto-resume` when a later synthesis turn is appropriate, or switch workflows. With opt-in `auto-resume`, detached broad work may be final-answer-dependent because completion requests a synthesis turn after the root settles. In either mode, do useful non-overlapping main-agent work immediately, do not poll `subagent_inspect` or `subagent_mailbox` with `action: "read"`, and do not duplicate delegated work. Add another detached agent only for truly independent work with safe workspace concurrency. Detached lifecycle work intentionally has no `subagent_wait` tool.

A detached agent additionally needs a concrete isolation or specialization benefit such as independent review, bounded context/output, a distinct model/tool profile, or workspace isolation. Simple work that the main agent can perform directly should not be delegated.

`stateful.completionDelivery` controls settled completion delivery:

- `"next-turn"` (default) preserves the previous behavior: use `deliverAs: "steer"` with `triggerTurn: false`. An active root can consume completion naturally; an idle root is not awakened.
- `"auto-resume"` holds completion while the root is active, then requests one synthesis turn after the parent settles when no user or extension messages are already pending. Simultaneous completions share that turn, active work is not interrupted, and pending input suppresses the autonomous wake.

The bounded persisted completion outbox provides ordered at-least-once delivery across process restart without replaying the child turn. When state must be reduced to its storage bound, persistence drops roots without pending completions first and trims old history rather than discarding an outbox-owned root. A completion is acknowledged only after parent context assembly observes its exact `completionId`; an injection that returns synchronously but never reaches context remains pending for retry. If the process exits after context assembly but before acknowledgement is persisted, the same ID can be delivered again and consumers must deduplicate it. Auto-resume wake admission remains best-effort because Pi's custom-message API is fire-and-forget, but an unacknowledged terminal completion itself remains available for redelivery on the next start of the owning session. Transient terminal-persistence failures retry with bounded exponential backoff and keep the run pending; shutdown cancels retry waits and reports a final persistence failure instead of silently resolving unsaved work.

The default `subprocess` transport preserves compatibility: each turn starts a fresh isolated `pi --mode json -p --no-session` child and receives sanitized, bounded history.
Set `transport` to `in-process` to retain one public Pi SDK `AgentSession` per stateful `agentId`, avoiding repeated process startup while preserving native child history in memory.
Set it to `rpc` to retain one `pi --mode rpc --no-session --no-extensions` process per active retained agent, preserving native child history with a separate process boundary.
Set it to `auto` for deterministic preflight selection: read-only built-in tools use in-process, write-capable built-in tools use RPC, and extension/custom tools use subprocess.
Automatic selection never falls back after child creation or prompt acceptance.

Run `/subagents` in TUI mode to open the standard primary manager.
It leads with the current delegation workflow, human-readable async completion behavior, consultation/delegation target policies, consultation-resource policy, parallel-worker limit, and active/retained counts.
**Change delegation**, **Current agents**, and **Settings** cover the common workflows.
Agent permissions, **Maximum parallel workers**, **Detached agent limits**, **Performance and execution**, transport/runtime details, source, and settings path remain under **Advanced settings**.
**Performance and execution** provides responsiveness guidance, transport previews, Fast/Balanced/Deep thinking profiles, and per-agent model/thinking/timeout defaults.
Profiles are explicit atomic thinking patches, preserve model/tool/timeout/context settings, never select `max`, and can be customized afterward.
The parallel-worker input rejects invalid values without discarding the draft and applies a successful save immediately.
The detached-limit screen edits retained capacity, active-turn concurrency, direct children, tree depth, and stored-record capacity.
Detached-limit saves are durable immediately but apply to the runtime after `/reload` or the next Pi session.
Escape returns from a nested screen to a newly refreshed manager, while Ctrl+C closes the full flow.
Exact workflow/reload and project-agent safety confirmations remain extension-owned because they guard live agent and trust-boundary policy rather than ordinary navigation.

The direct routes remain predictable: `/subagents settings` changes both target policies, consultation resources, and completion delivery and applies them immediately, including refreshing model-facing tool guidance; `/subagents status` reports current-session runtime values separately from configured values, per-field sources, and path; `/subagents help` summarizes the single-command interface and the non-sandbox limitation. In RPC mode, bare `/subagents` emits the same bounded status through Pi's notification protocol instead of opening a custom TUI. JSON and print modes do not emit ad hoc command output. Manual edits use `~/.pi/agent/pi-subagents.json` and take effect after reloading Pi:

```json
{
  "blocking": {
    "enabled": false,
    "maxParallelTasks": 8
  },
  "stateful": {
    "enabled": true,
    "transport": "auto",
    "completionDelivery": "auto-resume",
    "maxAgents": 16,
    "maxActiveTurns": 4,
    "maxDepth": 3,
    "maxChildrenPerAgent": 8,
    "maxMailboxMessages": 100,
    "maxMailboxMessageBytes": 16384,
    "idleTtlMs": 3600000,
    "retentionDays": 30,
    "maxStoredAgents": 50
  },
  "cwdPolicy": {
    "consultation": "anywhere",
    "delegation": "trusted-targets"
  },
  "consult": {
    "resources": "project-context"
  }
}
```

The settings UI patches the raw JSON atomically and preserves unknown fields.
It refuses to overwrite malformed or invalid settings.
Supported Pi writers serialize the latest-document read and same-directory temporary-file rename through `pi-subagents.json.mutation-lock`.
Editors and older extension versions do not participate in that lock, so avoid manual edits while a settings save is in progress.
`blocking.enabled` defaults to `true`; set it to `false` for async-only delegation.
`blocking.maxParallelTasks` defaults to `8` and accepts positive integers from `1` through `64`.
It limits worker tasks in one blocking parallel call, while execution still starts at most four workers at once and treats an optional aggregator separately.
`stateful.enabled` also defaults to `true`; its existing `false` value remains the blocking-only workflow.
The detached defaults are `maxAgents: 16`, `maxActiveTurns: 4`, `maxChildrenPerAgent: 8`, `maxDepth: 3`, and `maxStoredAgents: 50`.
`maxDepth` accepts zero or a positive safe integer, while the other four detached limits accept positive safe integers.
Use `/subagents` → **Advanced settings** → **Detached agent limits** to edit them without replacing unknown JSON fields.
The screen shows current-session and configured values separately because changes apply after `/reload`.
It never reloads automatically, because reload can interrupt retained detached work.
Lowering retained, depth, or stored capacity shows a projected recovery warning when current records would be omitted.
Restored parents that already exceed a lowered `maxChildrenPerAgent` remain available, but they cannot gain another child until they fall below the configured limit.
`cwdPolicy.consultation` defaults to `"anywhere"`, `cwdPolicy.delegation` defaults to `"trusted-targets"`, and `consult.resources` defaults to `"project-context"`.
The Settings UI applies a saved change immediately to subsequent launches and refreshes the affected tool descriptions; manual edits take effect on session start or `/reload`.
The UI explicitly states that target/trust settings are not filesystem sandboxing and directs trust changes to Pi `/trust`.
When stateful tools are enabled, their membership stays fixed across spawn, completion, interrupt, close, and mailbox transitions.
This avoids lifecycle-driven tool-schema churn and preserves a stable provider prompt prefix for KV caching.

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start detached work with optional task-selected thinking and retained timeout, exact-retry `idempotencyKey`, and `text`, `structured-v1`, or `structured-v2` result format; return an opaque `agentId` immediately and deliver completion asynchronously. |
| `subagent_send` | Send follow-up work with an optional one-turn timeout override and trigger a new turn on a reusable agent; semantic skew requires explicit `revalidate: true`, and shared-workspace write conflicts are guarded unless explicitly overridden. |
| `subagent_manage` | Use `"interrupt"` to retain an agent after aborting active work or `"close"` to release it; both actions accept optional `subtree`. Use `subagent_inspect` for all list and detail operations. |
| `subagent_mailbox` | Use `action: "send"` for queue-only messages that do not start a turn, or `"read"` to read and optionally acknowledge unread messages. |

The action schemas are flat for provider compatibility and reject parameters that belong to another action. For example:

```json
{
  "action": "interrupt",
  "agentId": "sa_example",
  "subtree": true
}
```

```json
{
  "action": "send",
  "agentId": "sa_example",
  "message": "Check the API compatibility note before finishing."
}
```

Use the **Current agents** action in `/subagents` to inspect the indented agent tree, lifecycle state, unread count, and available actions, or to confirm clearing retained agents.
Active turns are FIFO-limited by `maxActiveTurns`; excess retained work remains in `starting` state until a slot is available.
`maxAgents` separately bounds running, queued, and idle records.
`maxChildrenPerAgent` bounds direct children, while `maxDepth` counts nested levels below a depth-zero root.
`maxStoredAgents` bounds sanitized records persisted per session and does not increase live runtime capacity.
`parentId` creates a bounded child relationship; subtree interrupt and close operate child-first.

### Migrating from the previous seven-tool lifecycle surface

The five replaced names are intentionally not registered as aliases. Update explicit prompts and integrations as follows:

| Previous call | Fixed-surface call |
| --- | --- |
| `subagent_list({ includeClosed })` | `subagent_inspect({ action: "list_runs", includeClosed })` |
| `subagent_manage({ action: "list", includeClosed })` | `subagent_inspect({ action: "list_runs", includeClosed })` |
| `subagent_interrupt({ agentId, subtree })` | `subagent_manage({ action: "interrupt", agentId, subtree })` |
| `subagent_close({ agentId, subtree })` | `subagent_manage({ action: "close", agentId, subtree })` |
| `subagent_message({ agentId, message, ... })` | `subagent_mailbox({ action: "send", agentId, message, ... })` |
| `subagent_messages({ agentId, acknowledge, limit })` | `subagent_mailbox({ action: "read", agentId, acknowledge, limit })` |

Persisted agent and mailbox records require no manual migration; older records load with an empty completion outbox and generation zero. If an explicit prompt in a resumed conversation keeps requesting an old name, update it with the mapping above or start a fresh conversation. To roll back after an upgrade, pin the package version used before the upgrade; for this migration, use `pi install npm:@narumitw/pi-subagents@0.26.0`. The previous release can read the same state directory.

A spawn can request a thinking level explicitly:

```json
{
  "agent": "reviewer",
  "task": "Analyze the cross-package concurrency failure and identify the safest fix",
  "thinkingLevel": "high"
}
```

The requested level and spawn `timeoutMs`, `idleTimeoutMs`, `maxTurns`, and `maxToolCalls` are stored with the stateful agent and remain in effect for all follow-ups and after persisted restore. The same fields on `subagent_send` override only that follow-up turn. `subagent_send` does not provide a per-turn thinking override; create a new agent when a later task needs a different level.

An exact retry can use a bounded session-owned idempotency key:

```json
{
  "agent": "worker",
  "task": "Implement the approved change",
  "idempotencyKey": "approved-change-1"
}
```

The same key and canonical request returns the existing retained `agentId` without another confirmation, worktree, or child.
Reusing the key with different behavior-affecting parameters fails.
Closing the retained record releases the key.

Set `resultFormat: "structured-v1"` to ask for legacy `summary`, `evidence`, `changes`, `verification`, and `risks` fields.
Prefer `resultFormat: "structured-v2"` when orchestration must distinguish `completed`, `partial`, `blocked`, `needs-input`, `failed`, `interrupted`, `abstained`, `stale`, or `contract-invalid` outcomes and consume typed artifact evidence.
Valid structured data and deterministic recovery classification appear in completion and inspection details, while malformed structured output becomes `contract-invalid` instead of being treated as success.
The executor stamps task generation, cancellation lineage, and accepted `ExecutionPlan` identity after parsing, so model output cannot forge the provenance used for stale-result containment.

`subagent_spawn.context` accepts:

- `"none"` (default) — no parent conversation.
- `"all"` — bounded user/assistant text from the active branch.
- `"summary"` — a bounded earlier-context checkpoint plus recent messages verbatim.
- A positive number — the most recent N user turns and related assistant text.

Use `contextEntryIds` to select exact session entries.
Supplying IDs without `context` implies `context: "all"`; an explicit `context: "none"` still disables parent context.
Stable source IDs are retained so repeated follow-ups do not need to duplicate parent context.
Use `subagent_inspect` with `action: "preview_context"` to inspect selected turns, source count, UTF-8 bytes, and truncation before spawning without returning the context text.
The byte count is not a provider token estimate.

Reasoning, tool results, custom transport messages, and non-text parts are excluded. Text inside `<private>...</private>` and lines containing `[subagent-private]` are omitted before context, mailbox content, or history is persisted.

Stateful execution uses a transport boundary:

- `subprocess` is the default compatibility and rollback path and starts a fresh child for every turn.
- `in-process` uses only public Pi SDK APIs: `createAgentSessionServices()`, `createAgentSessionFromServices()`, `SessionManager.inMemory()`, and normal session lifecycle methods. It isolates conversation/tool selection, not memory or crashes; child failures share the parent Node.js process.
- `rpc` uses strict bounded JSONL over one lazy child process per active retained agent. A `get_state` response proves readiness, prompt response means accepted only, and `agent_settled` is the completion boundary after retry or compaction.
- `auto` selects one transport before launch and retains the choice for that agent's runtime lifetime. It never retries through another transport after startup or accepted work.
- In-process and RPC child resource loading disables extensions to prevent recursive `pi-subagents` loading and duplicate extension side effects while retaining trust-eligible context/skill resources and the selected agent prompt. The compatibility subprocess path retains its recursion-depth guard and configured tool behavior. Transports receive the same resolved target-trust boolean through their public SDK or explicit CLI trust controls.
- Agent model strings use Pi core's CLI resolver, including provider/model patterns, fuzzy matching, custom provider model IDs, and `:<thinking>` suffixes. Thinking level and built-in tool allow-list overrides are applied when the child is created. Parent model/thinking changes are snapshotted for subsequently created children; an existing child keeps its own session configuration.
- Extension/custom tool names are rejected by in-process and RPC v1 before child creation; automatic mode selects `subprocess` for them, and permissions are never silently widened.
- Timeout, parent abort, close, expiry, and session shutdown abort/dispose owned child sessions or process groups. A child that does not settle after abort grace is discarded rather than reused.
- RPC progress uses `pi-subagents:v1` metadata and reports only bounded phase, queue, timing, effective model/thinking, and validated usage fields; it never exposes raw prompts, reasoning, credentials, environment values, or full RPC events.
- A successful RPC prompt response is never treated as completion, and accepted or ambiguously accepted work is never replayed automatically.
- In-process startup failures do not silently retry through subprocesses, preventing duplicate side effects. If the loaded Pi core lacks public `createAgentSessionServices()`, `createAgentSessionFromServices()`, or `resolveCliModel()` support, startup fails with an actionable instruction to select `stateful.transport: "subprocess"`.

No private Pi imports, runtime casts, or `ExtensionAPI` monkey-patching are used.
The package uses public Pi root RPC types but owns exact CLI resolution, bounded framing, readiness, stderr, cancellation, and process-group cleanup because the stock client does not provide those package-specific guarantees.
Approval policy, sandbox profile, provider-header hooks, extension state, global scheduling, and parent/child transcript switching are not inherited or provided by in-process or RPC transport.

Write-capable agents share the workspace by default. Concurrent write-capable starts in the same cwd are rejected unless `allowConcurrentWrites` is explicitly set. Classification is intentionally conservative: an agent with `bash`, `write`, or `edit` is write-capable even when its task prompt says “read only,” because prompt wording is not a filesystem sandbox. Prefer one detached agent when asynchronous work can be combined. If concurrent work is genuinely required, use the blocking batch only when synchronous outputs justify making the root unavailable, explicitly accept safe detached overlap with `allowConcurrentWrites`, or use isolated worktrees when repository isolation is needed.

Set `workspaceMode: "worktree"` to opt into a disposable detached Git worktree; this requires a clean repository and the worktree is removed on close or session shutdown. The generated path inherits the approved base cwd's trust snapshot. Retained records mark disposable worktrees explicitly, so they are never restored even if cleanup could not remove the generated directory. Shared-workspace retained records store an additive bounded target-trust snapshot for transport and inspection parity; session restore canonicalizes the retained cwd and re-resolves current/saved trust rather than blindly trusting the persisted value. Older records without either field remain readable.

## 📜 Compatibility and failure contract

Existing accepted `subagent` payload shapes remain unchanged.
`subagent_spawn` adds optional `idempotencyKey` and `resultFormat` fields without changing omitted behavior.
Older releases do not recognize `stateful.transport: "rpc"` or `"auto"`; change the value to `"subprocess"` and reload before downgrading.
Retained records remain transport-neutral, and older readers ignore the additive idempotency and context-footprint fields while the state version remains compatible.
The `tasks` schema now advertises the absolute 64-item safety bound, while the effective `blocking.maxParallelTasks` value may be lower.
The intentional compatibility change is that an external target without saved trust is rejected by the new default `cwdPolicy.delegation: "trusted-targets"`; set the user-owned policy to `"anywhere"` to restore the preceding target flexibility.

| Mode | Ordering | Failure behavior |
| --- | --- | --- |
| Single | One result. | A failed/aborted/timed-out worker is marked as a tool error while preserving bounded details. |
| Chain | Input order. | Stops at the first failed step; completed steps remain in details. |
| Parallel | Input order, up to `blocking.maxParallelTasks` total workers and at most four active children. | Rejects calls above the configured limit; otherwise collects all task results, and partial worker failure does not discard successful results. |
| Parallel + aggregator | Source input order, then aggregator. | The aggregator runs with successful outputs and failure descriptions only when total budget remains; aggregator failure or orchestration expiry marks the tool result as an error. |
| Workflow | Deterministic dependency-ready and critical-path order, with results returned in declared task order. | Invalid graphs fail before launch; blocked or failed dependencies prevent downstream start; bounded retry and hedging require explicit side-effect contracts. |
| Panel | Reviewer declaration order, then at most one synthesizer. | Invalid or failed reviews remain visible; synthesis requires `minValidReviews`; insufficient panels preserve partial evidence without a consensus claim; synthesis contract failure marks the tool result as an error. |

An aggregator whose `agent` or `task` is empty or whitespace-only is treated as absent, so successful
parallel outputs remain available instead of being replaced by a malformed fan-in failure.

Blocking work-timeout precedence remains: task/step/aggregator → call → agent setting → `PI_SUBAGENT_TIMEOUT_MS` → 600000 ms, then `totalTimeoutMs` caps the effective remaining time. Blocking idle, turn, and tool-call precedence is task/step/aggregator → call → omitted. Stateful budget precedence is the explicit `subagent_send` field for one follow-up → retained `subagent_spawn` field → timeout-only agent/environment fallback where applicable. Blocking thinking precedence remains: task/step/aggregator → call → agent setting → child default. Stateful spawn thinking precedence is: `subagent_spawn.thinkingLevel` → agent setting → transport fallback. Project-agent resolution and confirmation behavior is unchanged after target preflight. Blocking and retained result/inspection details add bounded target, budget, termination, and effective trust metadata.

## 🤖 Built-in agents

Built-in agents are available without setup and can be overridden by user or project agents with the same name.

| Agent | Purpose | Tools |
| --- | --- | --- |
| `scout` | Read-only codebase reconnaissance. | `read`, `grep`, `find`, `ls`, `bash` |
| `planner` | Grounded implementation plans. | `read`, `grep`, `find`, `ls` |
| `reviewer` | Independent review of code and existing verification evidence. | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation. | Pi default tools |
| `general`, `general-purpose` | Aliases for `worker`. | Pi default tools |

The built-in `reviewer` does not run tests, builds, benchmarks, or formatters. It recommends additional verification commands for the main agent to run instead. Custom agents can override this behavior.

Built-in agents inherit the active/default Pi model instead of forcing a provider-specific model alias, which keeps every transport usable across different Pi setups.
Built-ins also have no fixed thinking override until a caller, frontmatter, per-agent setting, or execution profile selects one.

The optional profiles apply these provider-neutral thinking defaults:

| Profile | `scout` | `planner` | `reviewer` | `worker` and aliases |
| --- | --- | --- | --- | --- |
| Fast | `low` | `low` | `medium` | `low` |
| Balanced | `low` | `medium` | `medium` | `medium` |
| Deep | `medium` | `high` | `high` | `high` |

Profiles preserve model, timeout, tools, transport, completion delivery, and parent-context behavior.

## ⚙️ Configure agent tools

Open `/subagents`, choose **Advanced settings**, then **Agent tool permissions** in an interactive
Pi session to edit the tools each subagent may use.
Choose **Performance and execution** → **Agent execution defaults** to edit provider-neutral inherited model patterns, thinking levels, and timeouts without changing tools. The standard bounded multi-select keeps a
one-save draft: toggles do not write until **Save changes**, Escape leaves the draft without writing,
and unavailable configured tool names remain visible and preserved. In TUI mode, type to fuzzy-search
tool names and availability metadata; Save and Discard remain pinned below the matches. These are user
settings stored in `~/.pi/agent/pi-subagents.json` and affect future sessions.

Compatibility: a valid legacy `pi-subagents-config.json` remains readable with a warning and is never modified automatically; rename it to `pi-subagents.json`. The first subsequent settings save writes the canonical file. If both files exist, the new filename takes precedence.

- Select an agent, then press Enter or Space to toggle tools.
- Choose **Save changes** to write the draft, choose **Discard draft** to abandon it, or press Esc to
  return to agent selection without writing.
- Save the default selection to remove a custom override and use the agent defaults again.
- Deselect every tool and save to run that agent with no tools. An explicit empty list remains distinct from an absent list; blank `tools:` or `tools: []` in agent frontmatter also means no tools.

Configured tool names that are not currently registered are preserved, so settings for tools from
other extension sessions are not silently dropped.

## 🧩 Custom agents

Create markdown agent definitions in either location:

- `~/.pi/agent/agents/*.md` for user agents.
- `.pi/agents/*.md` for project-local agents.

Example:

```markdown
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls, bash
model: sonnet
thinkingLevel: high
capabilityManifest:
  version: pi-subagents:capabilities:v1
  capabilities: [code-review, evidence-review]
  modalities: [text]
  resultFormats: [text, structured-v2]
  authority:
    filesystem: read
  verificationRoles: [independent-review]
  contextStrengths: [repository]
  costHint: medium
  latencyHint: medium
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

`tools` accepts either the comma-separated form above or a YAML string array such as `tools: [read, grep]`. An omitted field keeps the agent's default tools; blank, `null`, or `[]` explicitly selects no tools.

`capabilityManifest` is optional for legacy custom agents and never grants authority by itself.
Explicit workflow routing can match declared capabilities, configured tools, filesystem authority, verification roles, and low/medium/high cost or latency hints.
A missing or malformed manifest remains unknown and cannot satisfy a capability-routed task.

`agentScope` is a top-level tool argument supplied per invocation. It is not a setting in
`~/.pi/agent/pi-subagents.json` and does not belong in agent frontmatter. The parent-facing tool
metadata discovers these definitions after session start and labels their source and required scope.
Edit agent files and run `/reload` (or start a new session) to refresh the catalog; there is no live
filesystem watcher. The scope selects which custom agent directories are loaded; built-in agents remain available in every scope:

| `agentScope` | Custom agents loaded |
| --- | --- |
| `"user"` (default) | User agents only. |
| `"project"` | Project-local agents only. |
| `"both"` | User and project-local agents. Project definitions override same-named user definitions. |

For example, invoke a project-local agent with the blocking `subagent` tool:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

Or select the scope when creating a stateful agent with `subagent_spawn`:

```json
{
  "agent": "api-reviewer",
  "task": "Review this project's API changes",
  "agentScope": "project"
}
```

A stateful agent retains the scope selected by `subagent_spawn` for its follow-ups. Every new
blocking `subagent` invocation or `subagent_spawn` call that needs project agents must supply
`agentScope: "project"` or `"both"` again.

Project-local agents require a trusted Pi project. Interactive sessions also ask for confirmation
before using them by default. Passing `confirmProjectAgents: false` as another top-level tool
argument skips that confirmation dialog, but it does not bypass the project trust requirement.

## ⏱️ Runtime limits and thinking levels

Every turn can combine main-agent-selected wall-clock, idle, assistant-turn, and tool-call budgets with an extension-owned hard-bounded finalization deadline.

- Set `blocking.maxParallelTasks` in `~/.pi/agent/pi-subagents.json`, or use `/subagents` → **Advanced settings** → **Maximum parallel workers**, to allow 1 through 64 worker tasks in one blocking parallel call.
- The worker-count limit defaults to 8 and does not change the fixed four-at-a-time execution concurrency.
- Set `timeoutMs` on the top-level blocking call to apply a work deadline to all jobs.
- Set `timeoutMs` on a task, chain step, or aggregator to override it locally.
- Set top-level blocking `totalTimeoutMs` to cap model work across the whole call; each child receives at most the remaining budget, queued work is not started after expiry, fan-in receives only remaining time, and an orchestration-expired child skips model finalization. Bounded process-cleanup grace may follow the deadline.
- Set `idleTimeoutMs` to stop a turn that has produced no completed assistant turn or tool result within that interval.
- Set `maxTurns` or `maxToolCalls` to stop unfinished repeated work; a terminal answer at the exact turn limit remains successful.
- Set spawn budgets as retained defaults, or the same fields on `subagent_send` to override one follow-up turn.
- Top-level blocking turn budgets apply to every job, while a task, chain step, or aggregator can override them locally.
- Choose the shortest realistic budgets for the task difficulty; split an oversized task instead of extending limits merely to compensate for broad scope.
- Valid time values range from 1 to 2,147,483,647 milliseconds, matching the runtime timer limit.
- `maxTurns` and `maxToolCalls` accept integers from 1 through 1,000,000.
- If `timeoutMs` is omitted, the default is the retained or agent setting, then `PI_SUBAGENT_TIMEOUT_MS`, or `600000` milliseconds (10 minutes) when unset; the other new budgets remain opt-in.

Set `thinkingLevel` to request one of Pi's supported levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Blocking subprocess calls pass the resolved value through `--thinking <level>`.

For `subagent_spawn`, the root agent should choose the lowest sufficient level:

| Level | Appropriate delegated work |
| --- | --- |
| `off` / `minimal` | Extraction, formatting, or mechanical work requiring almost no reasoning. |
| `low` | Straightforward, bounded tasks with direct steps. |
| `medium` | Ordinary multi-step research or implementation. |
| `high` | Complex debugging, design, review, or cross-file analysis. |
| `xhigh` | Highly ambiguous, cross-system, or high-risk analysis. |
| `max` | Exceptional hardest tasks where quality clearly outweighs latency and cost. |

Blocking thinking precedence is: task/chain step/aggregator `thinkingLevel` → top-level `thinkingLevel` → agent default from config or frontmatter → Pi subprocess default.

Stateful spawn precedence is: `subagent_spawn.thinkingLevel` → agent default from settings or frontmatter → model suffix → transport fallback.
Subprocess uses spawned Pi model/default resolution.
In-process delegates configured model parsing to loaded Pi core and then uses the parent thinking snapshot captured at child creation.
RPC passes the selected CLI model and thinking controls before its readiness handshake and reports the effective state returned by Pi.
An explicit spawn value is retained for the agent lifecycle and wins over every fallback.

Omit `thinkingLevel` to preserve existing behavior. Reported stateful details show the requested level, not a guarantee of the provider's effective value. Pi still owns model capability clamping; `pi-subagents` does not duplicate capability detection.

When any execution budget expires, the extension aborts the active run first and creates a versioned, bounded, redacted checkpoint containing partial assistant notes, completed tool evidence, changed-file hints, and whether side effects may already have occurred. After authoritative settlement it may make one concise summary attempt over that checkpoint without replaying the stopped task. The summary attempt has its own extension-owned model-work deadline of at most 45 seconds, followed only by bounded abort and process-cleanup grace. Fresh subprocess summaries run with no tools or project resources. Retained RPC and in-process summaries reuse their child context and are explicitly instructed not to call tools; the current child APIs do not support replacing an existing session's tool set for one turn, so their separate deadline and abort path remain the enforcement boundary. The deterministic checkpoint remains available when finalization or the provider fails, and results retain exit `124` plus a structured termination reason and finalization status. Explicit parent or user abort stops immediately, never starts finalization, and is not mislabeled as a budget stop.

This release does not claim a cooperative soft-wrap-up phase because print-mode subprocess children cannot receive steering while they are running. It also does not retry budget-stopped work automatically because file or external side effects may already have occurred.

The child event protocol limits each JSON line to 256 KiB. Captured output uses these defaults:

- final output and fan-in/chain context: 50 KiB;
- stderr: 16 KiB;
- captured messages: 200.

Truncated text includes a `truncated by pi-subagents` marker and details expose `truncated: true`. Inspection and consultation model-facing content also stops at 2,000 lines, whichever limit is reached first. `PI_SUBAGENT_MAX_DEPTH` controls nested delegation depth and defaults to 1; child processes receive `PI_SUBAGENT_DEPTH` automatically.

## 📡 Runtime status

Run the offline transport benchmark from the repository root when comparing startup overhead:

```bash
just benchmark-subagents
```

It reports serial median and median absolute deviation for deterministic fake fresh-subprocess and retained-RPC turns plus isolated real Pi RPC readiness, retained commands, in-process session creation, and retained in-process state access without making a provider request.
Queue time starts when the registry accepts work, transport startup starts when execution begins, RPC readiness comes from `get_state`, RPC acceptance comes from the correlated `prompt` response, first activity comes from a bounded lifecycle event, settlement comes from `agent_settled`, and delivery is recorded after the parent accepts the completion message.
Subprocess and in-process timing fields use the nearest public lifecycle boundary and may be coarser than RPC.
Timing and progress are current-session diagnostics and are not persisted.
The benchmark measures transport overhead rather than model latency or output quality.

While the `subagent` tool is running, `pi-subagents` publishes compact activity status with `ctx.ui.setStatus("subagents", "...")`. Any statusline extension that reads Pi's generic extension status API can display it; no package-to-package dependency is required.

## 🔒 Safety notes

Subagents have separate processes and context windows, but they are **not security sandboxes**. They run as the same OS user, share the host filesystem and network access, and may conflict if they edit the same files. Tool allow-lists reduce available Pi tools but do not reduce operating-system permissions. `subagent_consult` prevents writes through its Pi tool surface and disables extensions, but it can read accessible paths, call the configured model over the network, and incur cost; its instruction-resource policy is not a filesystem or confidentiality boundary. Panel write-capable reviewers use separate disposable Git worktrees, but those worktrees provide repository-write isolation only.

Every contracted execution records a hashed immutable `ExecutionPlan` and an executor-owned capability grant bound to its task generation, effective tools, issuance time, and expiry.
Interrupt, close, shutdown, replacement, persistence, and restore revoke active grants before signalling work or accepting another generation, and late old-plan results become `stale` diagnostic evidence.

The runner explicitly reports policy continuity in result details:

- inherited: process environment;
- overridden when selected: cwd, model, thinking level, and tool list;
- unsupported guarantees: parent approval policy, sandbox profile, and provider headers.

Treat project-local agent prompts like executable project configuration: only enable them in trusted repositories. Stateful project agents require Pi's project trust; interactive use also keeps confirmation enabled by default.

Stateful records are stored as versioned mode-0600 JSON under `~/.pi/agent/pi-subagents-state/` (or the configured Pi agent directory).
Explicit blocking-workflow snapshots use separate mode-0600 files under `~/.pi/agent/pi-subagents-workflows/`, retain at most 64 workflows per session for 30 days, and are available only through current-session workflow inspection.
Records contain sanitized logical history, never process IDs or credentials.
Corrupt or unsupported state is quarantined, completed and actionable terminal outcomes are preserved, in-flight records restore as `interrupted`, and no prior side effect is automatically resumed.
Retained follow-ups compare a privacy-safe hashed semantic snapshot before model work; incompatible resource changes require explicit `revalidate: true`, while unknown snapshot versions fail closed.
Snapshots hash agent manifests, prompts, effective tools, model/thinking, transport, trust, Git tracked and untracked state, and bounded user/project skill and prompt resources without persisting their contents.
A non-Git target has no stable repository generation proof, so each later follow-up requires explicit revalidation.
Count projection keeps complete ancestor chains together when stored or restored limits omit older trees.
Retention and count limits are configurable.
Downgrading is safe: older extension versions ignore this separate state directory; clear **Current agents** from `/subagents` before downgrade if the histories should be removed.

## 🗂️ Package layout

```txt
packages/pi-subagents/
├── src/
│   ├── index.ts                  # Pi package entrypoint
│   ├── subagents.ts              # Extension registration and blocking tool schema
│   ├── automation.ts             # Explicit autonomous planning tool and lifecycle owner
│   ├── automation-contract.ts    # Strict request, proposal, and graph-patch contracts
│   ├── automation-planner.ts     # Bounded read-only planner prompt and resource policy
│   ├── workflow-plan-compiler.ts # Deterministic admission, routing, and workflow compilation
│   ├── workflow-plan-patch.ts    # Generation-safe revisions and atomic plan persistence
│   ├── workflow-planning-benchmark.ts # Frozen matched offline evaluation protocol
│   ├── inspect.ts                # Side-effect-free metadata inspection tool
│   ├── consult.ts                # Synchronous read-only consultation tool
│   ├── consult-policy.ts         # Enforced read-only tool intersection
│   ├── cwd-policy.ts             # Canonical target and saved-trust resolution
│   ├── prompt-resources.ts       # Core-selected SYSTEM and APPEND_SYSTEM resources
│   ├── safe-text.ts              # Shared byte/line/path sanitization
│   ├── stateful.ts               # Detached lifecycle registration and dispatch
│   ├── rpc-transport.ts          # Persistent strict-JSONL Pi RPC child transport
│   ├── rpc-timeout-finalization.ts # RPC abort-settle-summary recovery
│   ├── rpc-transport-metadata.ts # RPC result policy and bounded metadata helpers
│   ├── rpc-turn-capture.ts       # RPC evidence capture, usage, and budget events
│   ├── auto-transport.ts         # Deterministic preflight transport routing
│   ├── transport-types.ts        # Bounded pi-subagents:v1 progress and telemetry contract
│   ├── completion-delivery.ts    # Completion batching and optional idle-root wake
│   ├── admission-policy.ts       # Audit-only deterministic delegation admission
│   ├── capability-grant.ts       # Generation-bound authority lifetime and revocation
│   ├── execution-plan.ts         # Executor-owned authority and resource resolution
│   ├── work-item-ledger.ts       # Persistent dependency and artifact state machine
│   ├── work-item-persistence.ts  # Atomic redacted workflow state and inspection
│   ├── workflow-verification.ts  # Compatibility independent-verifier receipts
│   ├── verified-execution-contract.ts # Explicit managed-verification request boundary
│   ├── workflow-completion-controller.ts # Sole opted-in terminal acceptance owner
│   ├── verification-harness.ts   # Disposable deterministic check execution
│   ├── verification-receipt.ts   # Strict executor-owned managed receipts
│   ├── verified-execution-benchmark.ts # Matched offline acceptance/cost fixture
│   ├── workflow-tree-identity.ts # Bounded exact Git-visible tree identities
│   ├── integration-controller.ts # Fail-closed canonical integration admission
│   ├── adaptive-scheduler.ts     # Dependency, capacity, budget, and conflict scheduling
│   ├── semantic-snapshot.ts      # Privacy-safe continuation compatibility checks
│   ├── supervision.ts            # Bounded idempotent retries and read-only hedging
│   ├── panel-execution.ts        # Blocking review barrier, synthesis, and lifecycle owner
│   ├── panel-contract.ts         # Strict review and synthesis evidence contracts
│   ├── panel-evidence.ts         # Bounded monotonic reviewer evidence ledger
│   ├── panel-planning.ts         # Panel validation, phase budgets, and WorkItems
│   ├── panel-prompts.ts          # Shared-task reviewer and synthesis prompts
│   ├── panel-reconciliation.ts   # Objection-preserving valid-review barrier
│   ├── panel-child-group.ts      # Child signals and disposable-worktree cleanup
│   ├── panel-render.ts           # Compact and expanded sanitized panel rows
│   ├── execution-profiles.ts     # Provider-neutral thinking profile patches
│   ├── execution-ui.ts           # Profile and per-agent execution settings screens
│   ├── stateful-guidance.ts      # Detached model-facing workflow guidance
│   ├── stateful-lifecycle.ts     # Runtime disposal and spawn ownership guards
│   ├── timeout-finalization.ts   # Abort-time bounded summary prompts and deadlines
│   ├── timeout-checkpoint.ts     # Redacted deterministic termination evidence
│   ├── turn-budget.ts            # Idle, assistant-turn, and tool-call enforcement
│   ├── runner-usage.ts           # Bounded subprocess usage accumulation
│   ├── runner-result.ts          # Shared subprocess result interpretation
│   ├── stateful-limit-ui.ts      # Detached capacity settings and recovery previews
│   ├── stateful-limits.ts        # Shared detached defaults, labels, and validation
│   ├── stateful-safety.ts        # Project-agent and shared-write safety checks
│   ├── stateful-tool-params.ts   # Consolidated action schemas and validation
│   └── *.ts                      # Package-local discovery, execution, rendering, and settings modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `subagents.ts`; the other source modules are internal.
Workflow settings remain backward compatible: older files without `blocking.enabled` receive the eight-tool default, and an absent `blocking.maxParallelTasks` keeps the previous eight-worker limit.
Existing `stateful.enabled: false` files expose blocking delegation plus inspection/consultation.
Older package releases ignore and preserve the optional `blocking.maxParallelTasks`, `consult`, and `cwdPolicy` fields.
The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, subagents, agent delegation, parallel agents, review panels, evidence synthesis, fan-in aggregation, chained agents, isolated subprocesses, AI coding workflow, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
