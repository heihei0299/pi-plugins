---
name: plugin-backup
description: >
  Backup and sync pi extensions in this project. Two branches: **snapshot**
  (freeze current local state to extensions/) and **sync** (update every
  plugin to the latest npm registry or git remote version). Use when the
  user asks to backup plugins, sync extensions, update plugin versions, or
  regenerate the manifest.
---

# Plugin Backup & Sync

Manage the pi extension backup system in this project. Two branches,
selected by invocation:

```
/plugin-backup snapshot   # 1. Freeze current state
/plugin-backup sync       # 2. Update to latest
```

---

## Branch: snapshot — Freeze Current State

Copy every installed pi extension from the live locations
(`~/.pi/agent/npm/node_modules/`, `~/.pi/agent/git/`, and local source
paths) into `extensions/` with a fresh `plugins-manifest.json`.

### Completion Criterion

Every plugin recorded in `plugins-manifest.json` has its source files
landed under the correct `extensions/npm/<pkg>/`, `extensions/git/<pkg>/`,
or `extensions/local/<pkg>/` directory, and the manifest versions match
the source `package.json` files.

### Steps

1. **Run the snapshot script**

   ```bash
   bash scripts/backup-plugins.sh
   ```

   This copies npm packages from `~/.pi/agent/npm/node_modules/`, git
   packages from `~/.pi/agent/git/`, and local packages from their
   source path, each into the matching `extensions/` subdirectory,
   then regenerates `plugins-manifest.json`.

2. **Audit the result**

   ```bash
   # Spot-check a few packages
   cat extensions/npm/@narumitw/pi-goal/package.json | grep version
   cat plugins-manifest.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['plugins']['npm']), 'npm packages')"
   ```

3. **Commit**

   ```bash
   git add extensions/ plugins-manifest.json
   git commit -m "chore(plugins): snapshot plugins to current versions"
   ```

---

## Branch: sync — Update to Latest

Check every plugin against its upstream source (npm registry, git remote)
and pull down newer versions. Updates `plugins-manifest.json` with the
new versions. Safe to run any time — unchanged packages are skipped.

### Completion Criterion

For every npm package, the version in `plugins-manifest.json` matches the
`latest` tag on the npm registry. Git packages match the remote `HEAD`.
The `updatedAt` field reflects this run.

### Steps

1. **Run the sync script**

   ```bash
   bash scripts/sync-plugins.sh
   ```

   The script queries the npm registry for each package's latest version
   and git remote `HEAD` for git packages. When a newer version exists,
   it downloads and extracts the tarball (npm) or pulls (git) and
   updates the manifest.

2. **Review what changed**

   ```bash
   git diff --stat
   # Check individual version bumps:
   git diff plugins-manifest.json
   ```

3. **Commit**

   ```bash
   git add -A
   git commit -m "chore(plugins): sync plugins to latest versions"
   ```

   If nothing changed, no commit is needed.

---

## Reference

### File Layout

```
pi-plugins/
├── extensions/
│   ├── npm/<pkg>/        # npm-installed package source
│   ├── git/<host>/<pkg>/  # git-cloned package source
│   └── local/<pkg>/       # local-path package source
├── plugins-manifest.json   # version manifest + directory mapping
├── scripts/
│   ├── backup-plugins.sh   # snapshot entry point
│   └── sync-plugins.sh     # sync entry point
└── .github/workflows/
    └── update-plugins.yml  # automated sync on push + cron
```

### What Gets Snapped

The snapshot copies **source files only** — it strips `node_modules/`,
`.git/`, test fixtures, and build artifacts to keep the backup lean.
The sync script uses npm registry tarballs (for npm packages) and shallow
git clones (for git packages), so the CI workflow has no dependency on
the local development environment.

### Automation

The GitHub Actions workflow at `.github/workflows/update-plugins.yml`:

- Runs **on push** to `main`/`master`
- Runs **every 3 days** via cron (`0 0 */3 * *`)
- Can be **triggered manually** from the Actions tab

It executes `scripts/sync-plugins.sh` and auto-commits any updates with
`chore: sync plugins to latest versions`.

### When to Snapshot vs Sync

| Situation | Branch |
|---|---|
| Just installed a new extension locally | `snapshot` |
| Want the latest versions from registry | `sync` |
| Before pushing to GitHub for the first time | `snapshot` |
| CI detected newer versions | `sync` (auto via Actions) |
