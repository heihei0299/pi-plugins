# Pi Plugins

> pi 扩展插件备份与同步仓库

本仓库备份了 pi 编码助手中安装的所有扩展插件（extensions）的完整源码，并通过 GitHub Actions 定期（每 3 天）检查更新。同时提供了一个 pi skill 用于管理备份流程。

---

## 目录

- [已备份的扩展插件](#已备份的扩展插件)
  - [npm 包](#npm-包)
  - [Git 包](#git-包)
  - [本地包](#本地包)
- [Skill：管理备份流程](#skill管理备份流程)
  - [Snapshot — 备份当前插件](#snapshot--备份当前插件)
  - [Sync — 更新到最新版本](#sync--更新到最新版本)
- [目录结构](#目录结构)
- [GitHub Actions 自动化](#github-actions-自动化)

---

## 已备份的扩展插件

> 以下内容由脚本自动生成，基于 `plugins-manifest.json`。

### npm 包

所有通过 npm 安装的扩展插件的源码保存在 `extensions/npm/` 下。

| 包名 | 版本 | 链接 |
|------|------|------|
| @cortexkit/pi-magic-context | 0.35.0 | [npm](https://www.npmjs.com/package/@cortexkit/pi-magic-context) |
| @ff-labs/pi-fff | 0.10.3 | [npm](https://www.npmjs.com/package/@ff-labs/pi-fff) |
| @gotgenes/pi-permission-system | 24.0.0 | [npm](https://www.npmjs.com/package/@gotgenes/pi-permission-system) |
| @juanibiapina/pi-extension-settings | 0.9.1 | [npm](https://www.npmjs.com/package/@juanibiapina/pi-extension-settings) |
| @juanibiapina/pi-powerbar | 0.14.0 | [npm](https://www.npmjs.com/package/@juanibiapina/pi-powerbar) |
| @juicesharp/rpiv-ask-user-question | 2.4.0 | [npm](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) |
| @juicesharp/rpiv-todo | 2.4.0 | [npm](https://www.npmjs.com/package/@juicesharp/rpiv-todo) |
| @narumitw/pi-btw | 0.49.6 | [npm](https://www.npmjs.com/package/@narumitw/pi-btw) |
| @narumitw/pi-caffeinate | 0.49.3 | [npm](https://www.npmjs.com/package/@narumitw/pi-caffeinate) |
| @narumitw/pi-goal | 0.49.7 | [npm](https://www.npmjs.com/package/@narumitw/pi-goal) |
| @narumitw/pi-lsp | 0.49.4 | [npm](https://www.npmjs.com/package/@narumitw/pi-lsp) |
| @narumitw/pi-plan-mode | 0.49.3 | [npm](https://www.npmjs.com/package/@narumitw/pi-plan-mode) |
| @narumitw/pi-subagents | 0.49.3 | [npm](https://www.npmjs.com/package/@narumitw/pi-subagents) |
| @tmustier/pi-raw-paste | 0.1.3 | [npm](https://www.npmjs.com/package/@tmustier/pi-raw-paste) |
| @victor-software-house/pi-curated-themes | 0.2.1 | [npm](https://www.npmjs.com/package/@victor-software-house/pi-curated-themes) |
| pi-add-dir | 1.3.1 | [npm](https://www.npmjs.com/package/pi-add-dir) |
| pi-agent-browser-native | 0.3.0 | [npm](https://www.npmjs.com/package/pi-agent-browser-native) |
| pi-autoresearch | 1.6.2 | [npm](https://www.npmjs.com/package/pi-autoresearch) |
| pi-cache-optimizer | 2.8.2 | [npm](https://www.npmjs.com/package/pi-cache-optimizer) |
| pi-hashline-edit-pro | 2.3.1 | [npm](https://www.npmjs.com/package/pi-hashline-edit-pro) |
| pi-mcp-adapter | 2.21.2 | [npm](https://www.npmjs.com/package/pi-mcp-adapter) |
| pi-rtk-optimizer | 0.9.0 | [npm](https://www.npmjs.com/package/pi-rtk-optimizer) |
| pi-slopchop | 0.10.1 | [npm](https://www.npmjs.com/package/pi-slopchop) |
| pi-web-access | 0.19.0 | [npm](https://www.npmjs.com/package/pi-web-access) |
| pi-workspace-history | 0.2.2 | [npm](https://www.npmjs.com/package/pi-workspace-history) |

### Git 包

通过 Git 安装的扩展插件源码保存在 `extensions/git/` 下。

| 包名 | 远程仓库 |
|------|----------|
| github.com/justhil/pi-ace-tool | [GitHub](https://github.com/justhil/pi-ace-tool) |

### 本地包

通过本地路径挂载的扩展插件保存在 `extensions/local/` 下。

| 包名 | 源路径 |
|------|--------|
| pi-guard-extension | `../../Project/Pi/guard/pi-guard-extension` |
## Skill：管理备份流程

本仓库提供了一个 pi skill `plugin-backup`，用于管理扩展插件的备份与更新。skill 定义在 `.agents/skills/plugin-backup/SKILL.md`，pi 自动发现后可通过命令调用。

### 触发方式

#### 方式一：用户手动调用

在 pi 对话中输入：

```
/plugin-backup snapshot    # 备份当前插件快照
/plugin-backup sync        # 更新到最新版本
```

#### 方式二：模型自动调用

当你说出与插件备份、同步相关的话题时，pi 会自动加载该 skill 并询问是否需要执行。

### Snapshot — 备份当前插件

将当前 pi 中安装的所有插件的完整源码复制到 `extensions/` 目录，并更新 `plugins-manifest.json`。

适用场景：
- 初次搭建备份后首次运行
- 批量安装/更新了多个插件后想记录当前状态
- 在修改插件源码前保留一份副本

执行流程：

```bash
# 1. 运行备份脚本
bash scripts/backup-plugins.sh

# 2. 检查 plugins-manifest.json 确保版本正确
cat plugins-manifest.json

# 3. 提交变更
git add extensions/ plugins-manifest.json
git commit -m "chore(plugins): snapshot plugins to current versions"
```

### Sync — 更新到最新版本

检查每个插件在 npm registry / git remote 上的最新版本，如有更新则下载最新源码并更新 manifest。

适用场景：
- 定期检查插件更新
- 手动触发 GitHub Actions 前本地预览更新范围
- CI 自动化（由 GitHub Actions 每 3 天自动运行）

执行流程：

```bash
# 1. 运行同步脚本
bash scripts/sync-plugins.sh

# 2. 审查变更
git diff --stat

# 3. 提交变更
git add -A
git commit -m "chore(plugins): sync plugins to latest versions"
```

### Snapshot vs Sync 对比

| | Snapshot | Sync |
|---|---|---|
| **数据源** | 本地 `node_modules` / git clone | npm registry / git remote |
| **用途** | 记录当前状态 | 更新到最新 |
| **运行环境** | 本地开发机 | 本地 / CI |
| **网络要求** | 不需要 | 需要 |
| **更新 manifest** | ✅ | ✅ |

---

## 目录结构

```
pi-plugins/
├── extensions/                          # 插件源码
│   ├── npm/                             # npm 源插件
│   │   ├── @narumitw/pi-goal/
│   │   ├── @narumitw/pi-btw/
│   │   └── ...
│   ├── git/                             # git 源插件
│   │   └── github.com/justhil/pi-ace-tool/
│   └── local/                           # 本地路径插件
│       └── pi-guard-extension/
├── .agents/
│   ├── skills/
│   │   ├── plugin-backup/               # 本仓库的 skill
│   │   │   └── SKILL.md
│   │   └── ... (mattpocock 技能)
│   └── skills-lock.json
├── .github/
│   └── workflows/
│       └── update-plugins.yml           # GitHub Actions 自动更新
├── scripts/
│   ├── backup-plugins.sh                # 本地快照脚本
│   └── sync-plugins.sh                  # 更新同步脚本
├── plugins-manifest.json                # 插件版本清单
├── skills-lock.json                     # skill 锁定文件
└── README.md
```

---

## GitHub Actions 自动化

工作流 `.github/workflows/update-plugins.yml` 在以下条件下触发：

| 触发器 | 说明 |
|--------|------|
| `schedule` | cron `0 0 */3 * *` — 每 3 天 UTC 00:00 自动运行 |
| `push` | 推送代码到 `main`/`master` 分支时 |
| `workflow_dispatch` | 可在 GitHub Actions 页面手动触发 |

工作流会在有更新时自动提交并推送变更到仓库。

---

> 更多详情请参阅 [skill 文档](.agents/skills/plugin-backup/SKILL.md) 或直接运行 `/plugin-backup`。
