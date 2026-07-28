#!/usr/bin/env bash
# ============================================================================
# sync-plugins.sh
# 在 GitHub Action CI 中运行，检查并更新所有插件到最新版本。
# 读取 plugins-manifest.json，对每个插件检查更新。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_FILE="$ROOT_DIR/plugins-manifest.json"
EXTENSIONS_DIR="$ROOT_DIR/extensions"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 manifest 是否存在
if [ ! -f "$MANIFEST_FILE" ]; then
    error "plugins-manifest.json 不存在！请先运行 backup-plugins.sh。"
    exit 1
fi

# 检查是否在 CI 中
if [ -n "${GITHUB_ACTIONS:-}" ]; then
    info "运行在 GitHub Action 环境中"
else
    info "本地运行模式"
fi

# 临时目录
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# 解析 manifest
NPM_PLUGINS=$(python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
for name, info in m['plugins'].get('npm', {}).items():
    print(f\"{name}|{info.get('version', 'unknown')}|{info.get('dir', '')}\")
")

GIT_PLUGINS=$(python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
for name, info in m['plugins'].get('git', {}).items():
    print(f\"{name}|{info.get('url', '')}|{info.get('ref', 'HEAD')}|{info.get('dir', '')}\")
")

echo ""
echo "============================================"
echo " Pi Plugins Sync Script"
echo "============================================"
echo ""

ANY_UPDATED=false

# ====== 更新 npm 插件 ======
echo "=== npm 插件 ==="
echo ""

while IFS='|' read -r pkg_name current_version dir_path; do
    [ -z "$pkg_name" ] && continue
    echo "----------------------------------------"
    info "检查: $pkg_name (当前: $current_version)"

    # 获取 npm registry 最新版本
    LATEST_VERSION=$(npm view "$pkg_name" version 2>/dev/null || echo "")

    if [ -z "$LATEST_VERSION" ]; then
        warn "无法获取最新版本，跳过"
        continue
    fi

    info "  最新: $LATEST_VERSION"

    if [ "$LATEST_VERSION" = "$current_version" ]; then
        ok "  已是最新"
        continue
    fi

    info "  需要更新: $current_version → $LATEST_VERSION"

    # 下载新版本 tarball
    TARBALL="$TMP_DIR/$(echo "$pkg_name" | tr '/' '_').tgz"
    info "  下载 tarball..."

    if npm pack "$pkg_name@$LATEST_VERSION" --pack-destination "$TMP_DIR" &>/dev/null; then
        # npm pack 创建的文件名可能包含作用域符号
        # 查找实际下载的文件
        actual_tarball=$(ls "$TMP_DIR"/*.tgz 2>/dev/null | head -1 || echo "")
        if [ -z "$actual_tarball" ]; then
            warn "  tarball 下载但找不到文件"
            continue
        fi

        # 解压到临时目录
        PKG_TMP="$TMP_DIR/extract_$(echo "$pkg_name" | tr '/' '_')"
        mkdir -p "$PKG_TMP"
        tar -xzf "$actual_tarball" -C "$PKG_TMP"
        rm -f "$actual_tarball"

        # tarball 内容在 package/ 子目录下
        TAR_SRC="$PKG_TMP/package"
        if [ ! -d "$TAR_SRC" ]; then
            # 可能是直接解压到根目录
            TAR_SRC="$PKG_TMP"
        fi

        # 目标目录
        DEST_DIR="$ROOT_DIR/$dir_path"
        mkdir -p "$(dirname "$DEST_DIR")"

        # 移除旧目录
        if [ -d "$DEST_DIR" ]; then
            rm -rf "$DEST_DIR"
        fi

        # 复制新文件
        cp -r "$TAR_SRC" "$DEST_DIR"

        # 删除可能包含的 node_modules
        rm -rf "$DEST_DIR/node_modules" 2>/dev/null || true

        # 更新 manifest 中的版本
        RESOLVED_URL="https://registry.npmjs.org/$(echo "$pkg_name" | sed 's|/|%2f|')/-/$(echo "$pkg_name" | sed 's|/|%2f|')-$LATEST_VERSION.tgz"

        python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
m['plugins']['npm']['$pkg_name']['version'] = '$LATEST_VERSION'
m['plugins']['npm']['$pkg_name']['resolved'] = '$RESOLVED_URL'
m['updatedAt'] = '$(date -u +"%Y-%m-%dT%H:%M:%SZ")'
with open('$MANIFEST_FILE', 'w') as f:
    json.dump(m, f, indent=2)
"

        ok "  已更新到 $LATEST_VERSION"
        ANY_UPDATED=true
    else
        warn "  下载失败: $pkg_name@$LATEST_VERSION"
    fi

done <<< "$NPM_PLUGINS"

# ====== 更新 git 插件 ======
echo ""
echo "=== git 插件 ==="
echo ""

while IFS='|' read -r name url ref dir_path; do
    [ -z "$name" ] && continue
    echo "----------------------------------------"
    info "检查 git 包: $name"

    DEST_DIR="$ROOT_DIR/$dir_path"

    # 在 CI 中确保使用 HTTPS URL
    CI_URL="$url"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        # 将 SSH URL 转换为 HTTPS
        CI_URL=$(echo "$url" | sed 's|git@github.com:|https://github.com/|; s|ssh://git@github.com/|https://github.com/|')
    fi

    if [ ! -d "$DEST_DIR" ] || [ ! -d "$DEST_DIR/.git" ]; then
        if [ -d "$DEST_DIR" ] && [ ! -d "$DEST_DIR/.git" ]; then
            info "  目录存在但无 .git，重新克隆..."
            rm -rf "$DEST_DIR"
        else
            info "  本地无目录，克隆..."
        fi
        mkdir -p "$(dirname "$DEST_DIR")"
        if git clone --depth 1 "$CI_URL" "$DEST_DIR" 2>/dev/null; then
            ok "  已克隆: $name"
            ANY_UPDATED=true
        else
            warn "  克隆失败: $CI_URL"
        fi
        continue
    fi

    # 拉取最新
    info "  本地目录存在，拉取更新..."
    cd "$DEST_DIR"

    # 更新 remote URL（防止 SSH URL 在 CI 中不工作）
    CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
    if [ "$CURRENT_REMOTE" != "$CI_URL" ] && [ -n "${GITHUB_ACTIONS:-}" ]; then
        git remote set-url origin "$CI_URL"
        info "  已更新 remote URL 为 HTTPS"
    fi

    if git fetch --depth 1 origin 2>/dev/null; then
        LOCAL=$(git rev-parse HEAD)
        REMOTE=$(git rev-parse origin/HEAD 2>/dev/null || git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null || echo "")
        if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
            git reset --hard "$REMOTE" 2>/dev/null || true
            ok "  已更新 $name"
            ANY_UPDATED=true
        else
            ok "  已是最新"
        fi
    else
        warn "  拉取失败: $name"
        # 尝试 HTTPS 重新克隆
        info "  尝试重新克隆（HTTPS）..."
        cd "$ROOT_DIR"
        rm -rf "$DEST_DIR"
        mkdir -p "$(dirname "$DEST_DIR")"
        if git clone --depth 1 "$CI_URL" "$DEST_DIR" 2>/dev/null; then
            ok "  已重新克隆: $name"
            ANY_UPDATED=true
        else
            warn "  重新克隆也失败: $CI_URL"
        fi
    fi
    cd "$ROOT_DIR"

done <<< "$GIT_PLUGINS"

# ====== 本地插件跳过 ======
echo ""
echo "=== 本地插件（CI 中跳过）==="
echo ""
LOCAL_COUNT=$(python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
print(len(m['plugins'].get('local', {})))
" 2>/dev/null || echo "0")
info "本地插件 $LOCAL_COUNT 个 — CI 中跳过更新（无对应路径）"

# ====== 更新 updatedAt ======
if [ "$ANY_UPDATED" = true ]; then
    python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
m['updatedAt'] = '$(date -u +"%Y-%m-%dT%H:%M:%SZ")'
with open('$MANIFEST_FILE', 'w') as f:
    json.dump(m, f, indent=2)
"
fi

# ====== 更新 README 扩展表格 ======
SCRIPT_DIR="$(dirname "$0")"
if [ -f "$SCRIPT_DIR/update-readme.sh" ]; then
    bash "$SCRIPT_DIR/update-readme.sh"
fi

# ====== 摘要 ======
echo "============================================"
if [ "$ANY_UPDATED" = true ]; then
    echo " 结果: 有更新已同步"
else
    echo " 结果: 所有插件已是最新"
fi
echo "============================================"
echo ""
