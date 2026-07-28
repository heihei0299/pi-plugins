#!/usr/bin/env bash
# ============================================================================
# backup-plugins.sh
# 将当前 pi 中安装的所有插件源码备份到 pi-plugins/extensions/
# 从本地的 node_modules / git 仓库复制完整源码
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSIONS_DIR="$ROOT_DIR/extensions"
MANIFEST_FILE="$ROOT_DIR/plugins-manifest.json"

# ---------- 路径配置 ----------
PI_NPM_DIR="$HOME/.pi/agent/npm"
PI_NODE_MODULES="$PI_NPM_DIR/node_modules"
PI_GIT_DIR="$HOME/.pi/agent/git"
PI_SETTINGS="$HOME/.pi/agent/settings.json"

# local 插件相对路径解析（相对于 settings.json 所在目录）
LOCAL_PLUGIN_RELATIVE="../../Project/Pi/guard/pi-guard-extension"
LOCAL_PLUGIN_ABSOLUTE="$HOME/Project/Pi/guard/pi-guard-extension"

# ---------- 彩色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ---------- 辅助函数 ----------

# 安全复制目录，排除 node_modules 和 .git
copy_pkg() {
    local src="$1"
    local dest="$2"
    local pkg_name="$3"

    if [ ! -d "$src" ]; then
        error "源目录不存在: $src"
        return 1
    fi

    mkdir -p "$(dirname "$dest")"

    # 使用 rsync 或 cp 复制，排除不需要的文件
    if command -v rsync &>/dev/null; then
        rsync -a --delete \
            --exclude='node_modules/' \
            --exclude='.git/' \
            --exclude='__pycache__/' \
            --exclude='*.tsbuildinfo' \
            "$src/" "$dest/"
    else
        # 如果没有 rsync，用 cp + find 清理
        if [ -d "$dest" ]; then
            rm -rf "$dest"
        fi
        mkdir -p "$dest"
        # 用 find 和 cpio 或 tar 来排除目录
        cd "$src"
        # 排除 node_modules 和 .git
        find . -not -path './node_modules/*' -not -path './.git/*' -not -name 'node_modules' -not -name '.git' -type f -print0 | cpio -pdm0 "$dest/" 2>/dev/null || true
        # 也创建空目录（除排除的）
        find . -not -path './node_modules/*' -not -path './.git/*' -not -name 'node_modules' -not -name '.git' -type d -print0 | cpio -pdm0 "$dest/" 2>/dev/null || true
        cd "$ROOT_DIR"
    fi

    if [ -d "$dest" ]; then
        ok "已复制: $pkg_name"
        return 0
    else
        error "复制失败: $pkg_name"
        return 1
    fi
}

# 从 npm registry 获取包的 resolved URL
get_npm_resolved() {
    local pkg="$1"
    local version="$2"
    # 规范化包名（作用域包需要转义 / 为 %2f）
    local pkg_escaped="${pkg/\//%2f}"
    echo "https://registry.npmjs.org/$pkg/-/${pkg_escaped}-${version}.tgz"
}

# 获取已安装包的版本号
get_installed_version() {
    local pkg="$1"
    local pkg_json="$PI_NODE_MODULES/$pkg/package.json"
    if [ -f "$pkg_json" ]; then
        python3 -c "import json; print(json.load(open('$pkg_json'))['version'])" 2>/dev/null || echo "unknown"
    else
        echo "unknown"
    fi
}

# ---------- 主逻辑 ----------

main() {
    echo ""
    echo "============================================"
    echo " Pi Plugins Backup Script"
    echo "============================================"
    echo ""

    # 初始化 manifest 数据结构
    MANIFEST='{
  "version": 1,
  "updatedAt": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'",
  "plugins": {
    "npm": {},
    "git": {},
    "local": {}
  }
}'

    # ====== 1. 备份 npm 插件 ======
    info "=== Step 1/3: 备份 npm 插件 ==="
    echo ""

    NPM_PKG_DIR="$EXTENSIONS_DIR/npm"
    mkdir -p "$NPM_PKG_DIR"

    # 从 pi 的 package.json 读取依赖列表
    PI_PACKAGE_JSON="$PI_NPM_DIR/package.json"
    if [ ! -f "$PI_PACKAGE_JSON" ]; then
        error "pi npm package.json 不存在: $PI_PACKAGE_JSON"
        exit 1
    fi

    # 提取 dependencies 中的包名（排除普通依赖，只选 pi 相关包）
    # 从 settings.json 的 packages 列表获取更准确
    info "读取安装的插件列表..."

    # 读取 settings.json 中的 packages 数组，过滤出 npm 包
    NPM_PACKAGES=$(python3 -c "
import json
with open('$PI_SETTINGS') as f:
    s = json.load(f)
pkgs = [p for p in s.get('packages', []) if isinstance(p, str) and not p.startswith('../../')]
for p in sorted(pkgs):
    # 去掉 npm: 前缀
    if p.startswith('npm:'):
        p = p[4:]
    print(p)
" 2>/dev/null || true)

    if [ -z "$NPM_PACKAGES" ]; then
        warn "从 settings.json 未读取到 npm 包列表，尝试从 package.json 读取..."
        NPM_PACKAGES=$(python3 -c "
import json
with open('$PI_PACKAGE_JSON') as f:
    pkg = json.load(f)
for name in sorted(pkg.get('dependencies', {}).keys()):
    print(name)
" 2>/dev/null || true)
    fi

    NPM_COUNT=0
    while IFS= read -r pkg_name; do
        [ -z "$pkg_name" ] && continue
        echo ""
        info "处理 npm 包: $pkg_name"

        SRC_DIR="$PI_NODE_MODULES/$pkg_name"
        DEST_DIR="$NPM_PKG_DIR/$pkg_name"

        if [ ! -d "$SRC_DIR" ]; then
            warn "包目录不存在，跳过: $SRC_DIR"
            continue
        fi

        # 获取版本号
        VERSION=$(get_installed_version "$pkg_name")
        RESOLVED=$(get_npm_resolved "$pkg_name" "$VERSION")

        info "  版本: $VERSION"

        # 复制源码
        if copy_pkg "$SRC_DIR" "$DEST_DIR" "$pkg_name"; then
            # 更新 manifest
            # 转义 JSON 中的特殊字符
            PKG_JSON=$(python3 -c "
import json
entry = {
    'version': '$VERSION',
    'resolved': '$RESOLVED',
    'dir': 'extensions/npm/$pkg_name'
}
print(json.dumps(entry))
" 2>/dev/null)
            # 注入到 manifest
            MANIFEST=$(python3 -c "
import json
m = json.loads('''$MANIFEST''')
m['plugins']['npm']['$pkg_name'] = json.loads('''$PKG_JSON''')
print(json.dumps(m, indent=2))
" 2>/dev/null)
            NPM_COUNT=$((NPM_COUNT + 1))
        fi
    done <<< "$NPM_PACKAGES"

    echo ""
    ok "npm 插件备份完成: $NPM_COUNT 个"

    # ====== 2. 备份 git 插件 ======
    echo ""
    info "=== Step 2/3: 备份 git 插件 ==="
    echo ""

    GIT_PKG_DIR="$EXTENSIONS_DIR/git"
    mkdir -p "$GIT_PKG_DIR"

    GIT_COUNT=0
    # 从 settings.json 读取 git 包
    GIT_PACKAGES=$(python3 -c "
import json
with open('$PI_SETTINGS') as f:
    s = json.load(f)
pkgs = [p for p in s.get('packages', []) if isinstance(p, str) and p.startswith('git:')]
for p in sorted(pkgs):
    print(p[4:])  # 去掉 git: 前缀
" 2>/dev/null || true)

    while IFS= read -r git_ref; do
        [ -z "$git_ref" ] && continue
        echo ""
        info "处理 git 包: $git_ref"

        # 解析 git ref: github.com/user/repo@ref
        # 或者 git@github.com:user/repo@ref
        # 简化处理：直接映射到本地路径
        GIT_SRC=""
        GIT_URL=""
        GIT_REF="HEAD"

        if [[ "$git_ref" == github.com/* ]]; then
            # github.com/user/repo@ref
            GIT_URL="https://$git_ref"
            # 去掉 @ref 部分来构建本地路径
            LOCAL_PATH="$PI_GIT_DIR/$git_ref"
            # 如果包含 @，提取 ref
            if [[ "$git_ref" == *@* ]]; then
                GIT_REF="${git_ref##*@}"
                LOCAL_PATH="${PI_GIT_DIR}/${git_ref%@*}"
            fi
            GIT_SRC="$LOCAL_PATH"
        elif [[ "$git_ref" == git@* ]]; then
            # git@github.com:user/repo@ref
            GIT_URL="ssh://$git_ref"
            # 转换为本地路径
            LOCAL_PATH="$PI_GIT_DIR/$(echo "$git_ref" | sed 's|git@||; s|:||; s|@.*||')"
            GIT_SRC="$LOCAL_PATH"
        fi

        # 检查本地是否有 git 仓库
        if [ -d "$PI_GIT_DIR/github.com" ]; then
            # 直接扫描已知的 git 仓库
            for git_repo in "$PI_GIT_DIR/github.com"/*/*/; do
                [ -d "$git_repo" ] || continue
                # 获取相对路径
                rel="${git_repo#$PI_GIT_DIR/}"
                rel="${rel%/}"
                info "  发现 git 仓库: $rel"
                GIT_SRC="$git_repo"
                # 读取实际 remote URL
                GIT_URL=$(cd "$git_repo" && git remote get-url origin 2>/dev/null || echo "https://github.com/$rel")
                break
            done
        fi
            done
        fi

        if [ -n "$GIT_SRC" ] && [ -d "$GIT_SRC" ]; then
            # 确定目标路径
            if [[ "$git_ref" == */* ]]; then
                DEST_DIR="$GIT_PKG_DIR/${git_ref%@*}"
            else
                # 从 URL 推断
                DEST_DIR="$GIT_PKG_DIR/$(basename "$GIT_SRC")"
            fi

            # 取最后一个找到的仓库
            for git_repo in "$PI_GIT_DIR/github.com"/*/*/; do
                [ -d "$git_repo" ] || continue
                rel="${git_repo#$PI_GIT_DIR/}"
                rel="${rel%/}"
                DEST_DIR="$GIT_PKG_DIR/$rel"
                break
            done

            if copy_pkg "$GIT_SRC" "$DEST_DIR" "$(basename "$GIT_SRC")"; then
                PKG_JSON=$(python3 -c "
import json
entry = {
    'url': '$GIT_URL',
    'ref': '$GIT_REF',
    'dir': 'extensions/git/${rel}'
}
print(json.dumps(entry))
" 2>/dev/null)
                MANIFEST=$(python3 -c "
import json
m = json.loads('''$MANIFEST''')
m['plugins']['git']['${rel}'] = json.loads('''$PKG_JSON''')
print(json.dumps(m, indent=2))
" 2>/dev/null)
                GIT_COUNT=$((GIT_COUNT + 1))
            fi
        else
            warn "git 仓库本地路径不存在，跳过: $git_ref"
        fi
    done <<< "$GIT_PACKAGES"

    # 如果 settings.json 没有 git 包，直接扫描 git 目录
    if [ -z "$GIT_PACKAGES" ]; then
        info "直接扫描 git 目录..."
        for git_repo in "$PI_GIT_DIR/github.com"/*/*/; do
            [ -d "$git_repo" ] || continue
            rel="${git_repo#$PI_GIT_DIR/}"
            rel="${rel%/}"
            info "  发现 git 仓库: $rel"
            DEST_DIR="$GIT_PKG_DIR/$rel"
            if copy_pkg "$git_repo" "$DEST_DIR" "$rel"; then
                GIT_URL=$(cd "$git_repo" && git remote get-url origin 2>/dev/null || echo "https://github.com/${rel#github.com/}")
                PKG_JSON=$(python3 -c "
import json
entry = {
    'url': '$GIT_URL',
    'ref': 'HEAD',
    'dir': 'extensions/git/$rel'
}
print(json.dumps(entry))
" 2>/dev/null)
                MANIFEST=$(python3 -c "
import json
m = json.loads('''$MANIFEST''')
m['plugins']['git']['$rel'] = json.loads('''$PKG_JSON''')
print(json.dumps(m, indent=2))
" 2>/dev/null)
                GIT_COUNT=$((GIT_COUNT + 1))
            fi
        done
    fi

    echo ""
    ok "git 插件备份完成: $GIT_COUNT 个"

    # ====== 3. 备份本地插件 ======
    echo ""
    info "=== Step 3/3: 备份本地插件 ==="
    echo ""

    LOCAL_PKG_DIR="$EXTENSIONS_DIR/local"
    mkdir -p "$LOCAL_PKG_DIR"

    LOCAL_COUNT=0

    if [ -d "$LOCAL_PLUGIN_ABSOLUTE" ]; then
        DEST_DIR="$LOCAL_PKG_DIR/pi-guard-extension"
        info "处理本地插件: pi-guard-extension"
        info "  源路径: $LOCAL_PLUGIN_ABSOLUTE"

        if copy_pkg "$LOCAL_PLUGIN_ABSOLUTE" "$DEST_DIR" "pi-guard-extension"; then
            PKG_JSON=$(python3 -c "
import json
entry = {
    'sourcePath': '$LOCAL_PLUGIN_RELATIVE',
    'dir': 'extensions/local/pi-guard-extension'
}
print(json.dumps(entry))
" 2>/dev/null)
            MANIFEST=$(python3 -c "
import json
m = json.loads('''$MANIFEST''')
m['plugins']['local']['pi-guard-extension'] = json.loads('''$PKG_JSON''')
print(json.dumps(m, indent=2))
" 2>/dev/null)
            LOCAL_COUNT=$((LOCAL_COUNT + 1))
        fi
    else
        warn "本地插件路径不存在: $LOCAL_PLUGIN_ABSOLUTE"
    fi

    echo ""
    ok "本地插件备份完成: $LOCAL_COUNT 个"

    # ====== 写入 manifest ======
    echo ""
    info "写入 plugins-manifest.json..."
    echo "$MANIFEST" > "$MANIFEST_FILE"
    ok "manifest 已写入: $MANIFEST_FILE"

    # ====== 摘要 ======
    echo ""
    echo "============================================"
    echo " 备份完成摘要"
    echo "============================================"
    echo "  npm 插件:  $NPM_COUNT 个"
    echo "  git 插件:   $GIT_COUNT 个"
    echo "  local 插件: $LOCAL_COUNT 个"
    echo "  总计:       $((NPM_COUNT + GIT_COUNT + LOCAL_COUNT)) 个"
    echo "============================================"
    echo ""
    info "插件源码保存在: $EXTENSIONS_DIR"
    info "插件清单: $MANIFEST_FILE"
    echo ""
}

main "$@"
