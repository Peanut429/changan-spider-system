#!/usr/bin/env bash
# 服务器上的发布脚本：拉代码 → 装依赖 → 构建 → pm2 reload → 健康检查
#
# 用法：
#   ./deploy/deploy.sh
#   APP_DIR=/srv/changan BRANCH=main ./deploy/deploy.sh
#
# 失败时脚本非 0 退出，pm2 保持旧版本继续跑（构建失败不会影响线上）。

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/changan}"
BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-changan-web}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$APP_DIR"
[ -d .git ] || fail "$APP_DIR 不是 git 仓库"

log "1/5 拉取 $BRANCH"
git fetch --prune origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

log "2/5 安装依赖"
pnpm install --frozen-lockfile

log "3/5 构建 web"
pnpm build:web
[ -f apps/web/.output/server/index.mjs ] || fail "构建产物缺失：apps/web/.output/server/index.mjs"

log "4/5 重载 pm2 ($PM2_APP)"
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env
else
  pm2 start ecosystem.config.cjs --only "$PM2_APP"
fi

log "5/5 健康检查 $HEALTH_URL"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null; then
    log "发布完成：$HEALTH_URL 正常"
    exit 0
  fi
  sleep 1
done

pm2 logs "$PM2_APP" --lines 80 --nostream || true
fail "健康检查失败，线上仍是旧进程，请检查上面的日志"
