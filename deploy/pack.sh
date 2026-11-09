#!/usr/bin/env bash
# 本地构建 + 推送产物到服务器，服务器上不拉代码、不装构建工具链。
#
# 用法（在仓库任意位置执行）：
#   SERVER=deploy@1.2.3.4 ./deploy/pack.sh
#   SERVER=deploy@1.2.3.4 ./deploy/pack.sh --skip-build      # 复用已有 .output
#   SERVER=deploy@1.2.3.4 ./deploy/pack.sh --push-config     # 顺便覆盖服务器上的 ecosystem.config.cjs
#   SERVER=deploy@1.2.3.4 ./deploy/pack.sh --list            # 看服务器上有哪些版本
#   SERVER=deploy@1.2.3.4 ./deploy/pack.sh --rollback 20261108-201000
#
# 环境变量：
#   SERVER       ssh 目标，必填，例如 deploy@1.2.3.4
#   REMOTE_DIR   服务器目录，默认 /srv/changan
#   KEEP         保留多少个历史版本，默认 5
#   PORT         本地健康检查端口，默认 3000（和 apps/web/.env 里的 PORT 一致）
#   BASE_PATH    子路径前缀，默认空；nginx 转发 /changan-data/ 时填 /changan-data
#
# 服务器目录结构（首次运行会自动建）：
#   /srv/changan/
#   ├── ecosystem.config.cjs
#   ├── apps/web/.env              # 常驻配置，不会被发布覆盖
#   ├── current -> releases/<版本>
#   └── releases/<版本>/apps/web/.output/...
#
# 注意：worker 是直接跑 TypeScript 源码的，没有构建产物。
# 如果爬虫也要跑在服务器上，那台机器仍然需要仓库源码（git clone 或 rsync 整个目录）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVER="${SERVER:-}"
REMOTE_DIR="${REMOTE_DIR:-/srv/changan}"
KEEP="${KEEP:-5}"
PORT="${PORT:-3000}"
BASE_PATH="${BASE_PATH:-}"   # 部署在子路径时填 /changan-data，健康检查要带上

SKIP_BUILD=0
PUSH_CONFIG=0
ACTION="deploy"
ROLLBACK_TO=""

log()  { printf '\033[1;34m[pack]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[pack]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=1; shift ;;
    --push-config)  PUSH_CONFIG=1; shift ;;
    --list)         ACTION="list"; shift ;;
    --rollback)     ACTION="rollback"; ROLLBACK_TO="${2:-}"; [ -n "$ROLLBACK_TO" ] || fail "--rollback 需要版本名"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              fail "未知参数：$1（--help 查看用法）" ;;
  esac
done

[ -n "$SERVER" ] || fail "请先设置 SERVER，例如 SERVER=deploy@1.2.3.4 $0"

# 远程命令统一用单引号包裹变量；路径里不要出现单引号
rsh() { ssh -o BatchMode=yes "$SERVER" "$@"; }

rsh "test -d '$REMOTE_DIR'" 2>/dev/null || fail "服务器上没有 ${REMOTE_DIR}，请先创建：ssh $SERVER 'mkdir -p $REMOTE_DIR'"

if [ "$ACTION" = "list" ]; then
  log "服务器 $REMOTE_DIR/releases："
  rsh "cd '$REMOTE_DIR' && ls -1dt releases/*/ 2>/dev/null | sed 's#releases/##;s#/\$##' | while read -r r; do printf '  %s%s\n' \"\$r\" \"\$( [ \"\$(readlink current)\" = \"releases/\$r\" ] && echo '  <- current' )\"; done"
  exit 0
fi

activate() {
  rsh "REMOTE_DIR='$REMOTE_DIR' RELEASE='$1' KEEP='$KEEP' PORT='$PORT' BASE_PATH='$BASE_PATH' bash -s" < "$SCRIPT_DIR/activate.sh"
}

if [ "$ACTION" = "rollback" ]; then
  log "回滚到 $ROLLBACK_TO"
  activate "$ROLLBACK_TO"
  exit 0
fi

# ---------- 部署 ----------

cd "$REPO_ROOT"

if [ "$SKIP_BUILD" = "0" ]; then
  [ -d node_modules ] || { log "安装依赖"; pnpm install --frozen-lockfile; }
  log "构建 web（pnpm build:web）"
  pnpm build:web
fi

[ -f apps/web/.output/server/index.mjs ] || fail "构建产物缺失：apps/web/.output/server/index.mjs"

RELEASE="$(date +%Y%m%d-%H%M%S)"

log "预检服务器"
rsh "test -f '$REMOTE_DIR/apps/web/.env' || exit 3" || {
  status=$?
  [ "$status" = "3" ] && fail "服务器缺少 $REMOTE_DIR/apps/web/.env（至少要有 DATABASE_URL），先创建一次：ssh $SERVER 'mkdir -p $REMOTE_DIR/apps/web && \$EDITOR $REMOTE_DIR/apps/web/.env'"
  fail "ssh 预检失败（检查 ssh $SERVER 是否免密可用）"
}

if [ "$PUSH_CONFIG" = "1" ] || ! rsh "test -f '$REMOTE_DIR/ecosystem.config.cjs'"; then
  log "上传 ecosystem.config.cjs"
  rsh "cat > '$REMOTE_DIR/ecosystem.config.cjs'" < ecosystem.config.cjs
fi

log "上传产物 -> releases/${RELEASE}（$(du -sh apps/web/.output | cut -f1)）"
rsh "mkdir -p '$REMOTE_DIR/releases/$RELEASE/apps/web'"
COPYFILE_DISABLE=1 tar czf - -C apps/web .output \
  | rsh "tar xzf - -C '$REMOTE_DIR/releases/$RELEASE/apps/web'"

log "激活并健康检查"
activate "$RELEASE"

log "完成：https://你的域名（本地验证：ssh $SERVER 'curl -s http://127.0.0.1:$PORT/api/health'）"
