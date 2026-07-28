# 💬 pi-btw — Side Questions for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-btw)](https://www.npmjs.com/package/@narumitw/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-btw` is a native [Pi coding agent](https://pi.dev) extension that adds `/btw`, a side-question command for quick clarifications that should not interrupt or pollute the main agent conversation.

Use it when you want to ask a temporary question, inspect context, or get a short explanation while keeping the primary coding task focused.

## ✨ Features

- Adds a `/btw` side-thread command to Pi, with an optional initial question.
- Answers side questions in a temporary, scrollable UI.
- Supports follow-up questions in the same ephemeral side thread.
- Optionally brings the latest answer, a question-to-end suffix, an exact line range, or the entire side thread into the main editor.
- Uses the current session branch as context.
- Uses Pi's current model or an independent model selected in `pi-btw.json`.
- Inherits Pi's current thinking level or uses a fixed level from `pi-btw.json`.
- Does not append the side question or answer to the main conversation.
- Works as an independently installable npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-btw
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-btw
```

## 🚀 Usage

Start an empty side thread or provide its first question immediately:

```text
/btw
/btw <your side question>
```

Examples:

```text
/btw
/btw what does this TypeScript error mean?
/btw summarize the current implementation before we continue
/btw is this API name idiomatic?
```

Running `/btw` alone opens an empty ephemeral side thread with its editor ready. When an
initial question is provided, its answer opens above the same editor. A compact
`btw · side thread` header stays fixed above the content so the ephemeral workspace remains
recognizable while scrolling. Messages use Pi's normal user and assistant presentation without
numbered turns or role labels. Type each question and press `Enter`; no follow-up shortcut is
required.
Previous side questions and answers remain available to the model and visible for that
invocation. While a response is running, the transcript stays visible above a compact
`Answering…` status. The footer shows `PgUp`/`PgDn` only when history can scroll; press
`Ctrl+C` to cancel an in-progress answer or leave the side thread.

After at least one successful answer, press `Ctrl+R` to bring selected context to the main
editor. The scope menu shows the size of the latest question and answer and the entire side
thread before you choose. Bring the latest question and answer, everything from a chosen
question onward, an exact text range, or the entire side thread. Question-suffix, exact-range,
and entire-thread choices preview the exact editable context block before the side thread closes;
`Escape` returns and `Ctrl+C` closes without bringing anything to main.

The text-range selector supports both fast line selection and editor-style character selection.
It reports whether anything is selected plus the selected line, message, and approximate token
counts. Press `Space` to select the current raw source line, then use `Up`/`Down` to extend by
whole lines; press `Space` again to clear it. Alternatively, use the arrow keys to move the cursor
and `Shift`+arrow keys to extend a character-level selection. Starting a Shift selection replaces
any active line selection. Selected lines include a visible `●` marker in addition to highlighting.
Pi's configured keys control vertical navigation, bringing, and going back (`Up`/`Down`, `Enter`,
and `Escape` by default), and the selector displays the active keys. Selection follows raw source
text rather than terminal-wrapped visual rows.

Bringing context to main closes the side thread and loads a deterministic, editable context block
into Pi's main editor. It never sends the draft automatically. If the main editor already has a
draft, append is the recommended default. Replace is labeled as destructive and requires a second
confirmation; Cancel returns to the side thread without changing either draft. Concurrent editor
updates made while these menus are open are preserved. A success message reports whether context
was loaded, appended, or replaced and its approximate size. Without an explicit bring-to-main
action, closing `/btw`, reloading Pi, or switching sessions still discards the side thread without
adding it to the main conversation.

## ⚙️ Model and thinking level

By default, `/btw` uses the current session model. To use an independent model for side
questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`. `PI_CODING_AGENT_DIR` is an existing Pi
setting; pi-btw does not add any environment variables.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low"
}
```

The `model` value uses `provider/model-id` format. Only the first `/` is the separator, so
model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet`.
The configured model must exist in Pi's model registry and have usable credentials. If it
cannot be found or authenticated, pi-btw warns and falls back to the current session model.
If neither model is available, `/btw` reports an error and stops. This selection affects only
`/btw`; it does not change the main session model.

Pi calls its reasoning setting the **thinking level**. By default, `/btw` inherits the
current runtime level, including changes made through `/settings` or `Shift+Tab`. It does
not read or change `defaultThinkingLevel` directly. Supported fixed values are `off`,
`minimal`, `low`, `medium`, `high`, and `xhigh`. The selected value applies to the model
actually used by `/btw` and does not change the main session. Pi's provider layer may clamp
a requested level when that model does not support it.

The settings file is optional and is never created automatically. A missing file, `{}`, or
omitted fields silently inherit the current Pi model and thinking level. The file is read for
each `/btw` invocation, so edits apply to the next side question without `/reload`. Invalid
or unreadable settings produce a warning and fall back to the current Pi defaults.

## 🧠 Why use pi-btw?

Normal assistant messages become part of the main Pi conversation and can distract the coding agent from the task. `pi-btw` creates a lightweight side channel for context-aware questions, making it useful for pair programming, debugging, code review, and repository exploration.

## 🗂️ Package layout

```txt
extensions/pi-btw/
├── src/
│   ├── index.ts
│   ├── btw.ts
│   ├── bring-to-main.ts
│   ├── side-thread.ts
│   └── transcript-pager.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, side question command, agent chat workflow, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
