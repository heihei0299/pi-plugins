#!/usr/bin/env bash
# ============================================================
# update-readme.sh — 从 plugins-manifest.json 重新生成 README.md
# 中的扩展插件表格。
#
# 找到 "## 已备份的扩展插件" 行，然后删除直到下一个 "## " 行
# 或 --- 或文件末尾的内容，再插入最新的表格数据。
# ============================================================
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/plugins-manifest.json"
README="$ROOT_DIR/README.md"

[ -f "$MANIFEST" ] || { echo "Missing $MANIFEST"; exit 1; }
[ -f "$README" ]   || { echo "Missing $README";   exit 1; }

# Pass paths via env vars to avoid escaping issues
export PY_MANIFEST="$MANIFEST"
export PY_README="$README"

python3 << 'PYEOF'
import json, os, re, sys

manifest_path = os.environ['PY_MANIFEST']
readme_path   = os.environ['PY_README']

with open(manifest_path) as f:
    manifest = json.load(f)

plugins = manifest.get('plugins', {})

# ==================================================================
# 生成表格 markdown
# ==================================================================
lines = []
lines.append('## 已备份的扩展插件')
lines.append('')
lines.append('> 以下内容由脚本自动生成，基于 `plugins-manifest.json`。')
lines.append('')

# --- npm ---
lines.append('### npm 包')
lines.append('')
lines.append('所有通过 npm 安装的扩展插件的源码保存在 `extensions/npm/` 下。')
lines.append('')
lines.append('| 包名 | 版本 | 链接 |')
lines.append('|------|------|------|')

for name in sorted(plugins.get('npm', {}).keys()):
    info = plugins['npm'][name]
    ver = info.get('version', '?')
    lines.append(f'| {name} | {ver} | [npm](https://www.npmjs.com/package/{name}) |')

lines.append('')

# --- git ---
lines.append('### Git 包')
lines.append('')
lines.append('通过 Git 安装的扩展插件源码保存在 `extensions/git/` 下。')
lines.append('')
lines.append('| 包名 | 远程仓库 |')
lines.append('|------|----------|')

for name in sorted(plugins.get('git', {}).keys()):
    info = plugins['git'][name]
    url = info.get('url', '?')
    lines.append(f'| {name} | [GitHub]({url}) |')

lines.append('')

# --- local ---
lines.append('### 本地包')
lines.append('')
lines.append('通过本地路径挂载的扩展插件保存在 `extensions/local/` 下。')
lines.append('')
lines.append('| 包名 | 源路径 |')
lines.append('|------|--------|')

for name in sorted(plugins.get('local', {}).keys()):
    info = plugins['local'][name]
    src = info.get('sourcePath', '?')
    lines.append(f'| {name} | `{src}` |')

lines.append('')
table_content = '\n'.join(lines)

# ==================================================================
# 替换 README 中的表格区域
# ==================================================================
with open(readme_path) as f:
    content = f.read()

# 查找 "## 已备份的扩展插件" 行
m = re.search(r'^## 已备份的扩展插件.*$', content, re.MULTILINE)
if not m:
    print('ERROR: cannot find "## 已备份的扩展插件" heading in README.md')
    sys.exit(1)

start_pos = m.start()

# 从 start_pos 之后查找下一个 "## " 行 或 "---" 行
tail = content[m.end():]

end_pos = len(content)
# Look for next heading
m2 = re.search(r'^## ', tail, re.MULTILINE)
if m2:
    end_pos = m.start() + len(m.group()) + m2.start()
else:
    # Look for horizontal rule
    m2 = re.search(r'^---\s*$', tail, re.MULTILINE)
    if m2:
        end_pos = m.start() + len(m.group()) + m2.start()
        # Keep the --- line in the output by advancing past it
        end_pos += len(m2.group()) + 1  # +1 for newline after ---

new_content = content[:start_pos] + table_content.rstrip() + '\n' + content[end_pos:]

with open(readme_path, 'w') as f:
    f.write(new_content)

print('README.md extension table updated')
PYEOF
