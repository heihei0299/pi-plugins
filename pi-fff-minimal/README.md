# pi-fff-minimal

Low-context fork of `@ff-labs/pi-fff`, based on upstream `v0.10.6`.

## Goal

Keep FFF's indexed/frecency-aware `find` and `grep` implementation while minimizing what the main Pi model sees.

Changes from upstream:

- defaults to `override` mode, keeping the familiar `find` / `grep` names
- removes verbose `promptGuidelines`
- shortens `promptSnippet`, tool descriptions, and parameter descriptions
- keeps the FFF engine, pagination, git/frecency ranking, fuzzy fallback, watcher, DB handling, health/rescan commands, and @-mention integration
- keeps multi-grep disabled by default, matching upstream behavior; opt in with `PI_FFF_MULTIGREP=1`

No extra system prompt or hidden context is added by this fork.

## Install

```bash
cd pi-fff-minimal
npm install
pi -e ./src/index.ts
```

For persistent loading, point Pi at:

```text
/path/to/pi-plugins/pi-fff-minimal/src/index.ts
```

## Model-visible surface

The always-visible surface is intentionally limited to compact `find` and `grep` schemas plus short tool snippets. The upstream multi-line usage guidelines are removed.

## Upstream

Based on `dmtrKovalenko/fff` / `@ff-labs/pi-fff` at `v0.10.6`.

FFF and the upstream Pi extension are MIT licensed. See `LICENSE`.
