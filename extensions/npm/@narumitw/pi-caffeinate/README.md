# ☕ pi-caffeinate — Keep Your Computer Awake While Pi Runs

[![npm](https://img.shields.io/npm/v/@narumitw/pi-caffeinate)](https://www.npmjs.com/package/@narumitw/pi-caffeinate) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Prevent system or display sleep while Pi is processing a prompt, then release the inhibitor as soon as the run ends.

## ✨ Features

- Starts an OS sleep inhibitor when a Pi run begins and releases it when the run or session ends.
- Supports macOS, Windows, WSL, and Linux with a display-awake default.
- Provides `/caffeinate` controls for the keep-awake mode, current status, and quiet mode.
- Persists preferences locally and accepts an optional custom inhibitor command.
- Shows activity only while the inhibitor is active and fails safely when no supported mechanism is available.

## 📦 Install

```bash
pi install npm:@narumitw/pi-caffeinate
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-caffeinate
```

Try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-caffeinate run build
pi -e ./packages/pi-caffeinate
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.

## 🚀 Quick start

Load the extension and use Pi normally.
During an agent run, pi-caffeinate uses the saved keep-awake mode and defaults to keeping both the system and display awake.
Run `/caffeinate` to open the controls or `/caffeinate status` to inspect the current state.

## 🖥️ Supported platforms

The default mode is `display` on every supported OS.
That means pi-caffeinate prevents system sleep, suspend, or hibernate and keeps the screen/display awake.

Use `/caffeinate sleep` if you want to prevent system sleep while allowing normal display idle behavior such as screen blanking or monitor power-off.

| Platform | `sleep` mode | `display` mode, default |
| --- | --- | --- |
| macOS | `caffeinate -ims` | `caffeinate -dimsu` |
| Windows | PowerShell `SetThreadExecutionState(0x80000001)` | PowerShell `SetThreadExecutionState(0x80000003)` |
| WSL | Windows `powershell.exe` with `SetThreadExecutionState(0x80000001)` | Windows `powershell.exe` with `SetThreadExecutionState(0x80000003)` |
| Linux with systemd | `systemd-inhibit --what=sleep ... sleep infinity` | D-Bus `org.freedesktop.ScreenSaver.Inhibit` + `systemd-inhibit --what=idle:sleep ... sleep infinity` |
| Linux without systemd | `caffeinate -ims` when available | D-Bus `org.freedesktop.ScreenSaver.Inhibit` + `caffeinate -dimsu` when available; D-Bus only otherwise |

On Linux, `display` mode requests idle inhibition through the standard `org.freedesktop.ScreenSaver` D-Bus service, trying both `/org/freedesktop/ScreenSaver` and `/ScreenSaver` for desktop compatibility.
The session-bus connection stays open for the whole agent turn.
The inhibition ends when `UnInhibit` is called or the connection closes.
`systemd-inhibit --what=idle:sleep` runs alongside it to preserve logind idle and sleep inhibition.
If no ScreenSaver service is available, pi-caffeinate keeps the systemd blocker or `caffeinate` fallback and reports a partial-activation warning.
If only D-Bus is available, pi-caffeinate reports partial activation because desktop idle is inhibited but direct system suspend may remain possible.
D-Bus method calls use short deadlines, and stop or shutdown aborts an in-flight acquisition before closing its session-bus connection.

If no supported inhibitor is available, the extension stays loaded and reports that caffeinate is unavailable.

## 💬 Commands

```text
/caffeinate
```

Opens standard keep-awake controls in TUI or RPC mode.
Print and JSON modes reject the interactive menu observably; use the direct `status`, `sleep`, `display`, `stop`, or `help` routes instead.

```text
/caffeinate display
```

Keeps the system and screen/display awake.
If an inhibitor is currently active, it is restarted so the new mode applies immediately.

```text
/caffeinate sleep
```

Keeps the system awake while allowing normal display sleep.
If an inhibitor is currently active, it is restarted so the new mode applies immediately.

```text
/caffeinate status
```

Shows whether an inhibitor is active, unavailable, disabled, or idle.
The status includes the current mode, quiet mode, and settings file path.

```text
/caffeinate mode
```

Opens the standard keep-awake mode selector in TUI or RPC mode.
Escape closes the selector.

```text
/caffeinate stop
```

Releases any active inhibitor until Pi starts another agent run.

## ⚙️ Settings

### Persisted settings

`/caffeinate sleep` and `/caffeinate display` save the selected mode to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate.json
```

Example:

```json
{
  "mode": "display",
  "quiet": true,
  "updatedAt": 1791763200000
}
```

Set `"quiet": true` to hide the routine `Keeping computer awake (...)` and `Released pi-caffeinate (agent finished)` lifecycle notifications and keep the `caffeinate` status item clear while active or unavailable.
Quiet mode does not hide warnings or explicit feedback from `/caffeinate` commands such as `status`, mode changes, help, and manual stop.
It defaults to `false` when omitted.
The file is read at startup and on `/reload`; run `/reload` after editing it in a running Pi session before using mode commands.

Missing, invalid, or deleted settings default back to `display` mode with quiet mode disabled on every supported OS.
A missing file stays absent until the first successful mode change.
Within one Pi process, mode saves run in invocation order, reread the latest valid document, and preserve unknown fields.
Malformed JSON or an invalid recognized field blocks mode saves until repaired instead of being overwritten.
A failed save keeps the prior runtime mode; if restarting an active inhibitor fails after publication, the extension restores the prior saved mode and inhibitor behavior or reports an explicit rollback failure.

Compatibility: older versions used `pi-caffeinate-settings.json`.
A legacy-only file remains readable with a warning and is never modified automatically; rename it to `pi-caffeinate.json`.
The first subsequent settings save writes the canonical file.
If both files exist, `pi-caffeinate.json` wins and the legacy file is ignored.
The legacy filename is deprecated and will be removed in a future major release.

### Environment variables

Disable the extension:

```bash
PI_CAFFEINATE_DISABLED=1 pi
```

Use a custom inhibitor command:

```bash
PI_CAFFEINATE_COMMAND='systemd-inhibit --what=idle:sleep --why="pi running" --mode=block sleep infinity' pi
```

The custom command is parsed with shell-like quoting and is run directly without a shell.
`PI_CAFFEINATE_COMMAND` takes precedence over the saved mode; `/caffeinate status` reports when a custom command is active.

Deprecated: `PI_CAFFEINATE_ICON` still works for now.
If you use `@narumitw/pi-statusline`, move the icon to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json`:

```json
{
  "extensionStatusIcons": {
    "caffeinate": "☕️"
  }
}
```

Without `@narumitw/pi-statusline`, keep using `PI_CAFFEINATE_ICON` during the compatibility window.
In `pi-statusline.json`, use an empty string to show the caffeinate status without an icon.

## 🧠 Why use pi-caffeinate?

AI coding agents often run tool-heavy tasks that take several minutes.
`pi-caffeinate` keeps your machine awake during active Pi work, helping browser automation, local builds, test runs, code generation, and long prompts finish reliably.

The default display-awake mode prioritizes uninterrupted long-running Pi work across platforms, including Linux desktops that require idle inhibition to prevent automatic suspend.
Use `/caffeinate sleep` (shown as `system-awake` in status output) when you prefer normal screen power saving and your system does not need idle inhibition to keep Pi running.

## 📦 Dependencies

On Linux, `display` mode uses the `dbus-native` package (pure JavaScript, no native build step) to call `org.freedesktop.ScreenSaver` on the session bus.

## 🗂️ Package layout

```txt
packages/pi-caffeinate/
├── src/
│   ├── index.ts       # Pi package entrypoint
│   ├── caffeinate.ts  # Extension registration and lifecycle orchestration
│   └── *.ts           # Package-local inhibitor and settings modules
├── dist/              # Generated source-mapped Jiti runtime
├── scripts/
│   └── build-runtime.mjs
├── test/
│   ├── build-runtime.test.ts
│   └── caffeinate.test.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`src/index.ts` remains the thin authoritative forwarder, while Pi loads the generated `dist/index.ts` runtime.
The other source modules are internal.

## 🔎 Keywords

Pi extension, Pi coding agent, caffeinate, prevent sleep, keep awake, sleep inhibitor, AI agent automation, long-running coding task, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
