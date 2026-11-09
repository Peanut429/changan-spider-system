#!/usr/bin/env bash
# 服务器端激活脚本：由 deploy/pack.sh 通过 ssh 调用，不要手工在本地执行。
#   REMOTE_DIR=/srv/changan RELEASE=20261109-113000 KEEP=5 bash activate.sh
#
# 流程：切换 current 软链 → pm2 重载 → 健康检查 → 失败则自动回滚到上一个版本

set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/srv/changan}"
RELEASE="${RELEASE:?缺少 RELEASE 变量}"
KEEP="${KEEP:-5}"
PM2_APP="${PM2_APP:-changan-web}"
PORT="${PORT:-3000}"
BASE_PATH="${BASE_PATH:-}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$PORT$BASE_PATH/api/health}"

log()  { printf '\033[1;34m[activate]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[activate]\033[0m %s\n' "$*" >&2; exit 1; }

# 解析软链真实路径（不依赖 GNU readlink -f）
resolve() { [ -e "$1" ] && ( cd "$1" && pwd -P ) || true; }

# 切换 current 软链。必须用 ln -sfn 直接作用在链接本身：
# 用 `mv 临时链接 current` 的话，current 指向目录时 mv 会把临时链接搬进那个目录里。
switch_current() {
  ln -sfn "$1" current
}

cd "$REMOTE_DIR"
[ -d "releases/$RELEASE/apps/web/.output/server" ] || fail "版本目录不完整：releases/$RELEASE/apps/web/.output/server"
[ -f ecosystem.config.cjs ] || fail "缺少 $REMOTE_DIR/ecosystem.config.cjs（用 deploy/pack.sh --push-config 上传一次）"
[ -f apps/web/.env ] || fail "缺少 $REMOTE_DIR/apps/web/.env，pm2 注入不了 DATABASE_URL"

PREV_TARGET="$(readlink current 2>/dev/null || true)"

log "切换 current -> releases/$RELEASE"
switch_current "releases/$RELEASE"

log "pm2 重载 $PM2_APP"
if ! pm2 startOrReload ecosystem.config.cjs --only "$PM2_APP" --update-env; then
  log "startOrReload 失败，尝试全新 start"
  pm2 delete "$PM2_APP" >/dev/null 2>&1 || true
  pm2 start ecosystem.config.cjs --only "$PM2_APP" || fail "pm2 启动失败"
fi

log "健康检查 $HEALTH_URL"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ -z "$ok" ]; then
  pm2 logs "$PM2_APP" --lines 60 --nostream 2>/dev/null || true
  if [ -n "$PREV_TARGET" ] && [ -e "$PREV_TARGET" ]; then
    log "健康检查失败，回滚到 $PREV_TARGET"
    switch_current "$PREV_TARGET"
    pm2 startOrReload ecosystem.config.cjs --only "$PM2_APP" --update-env >/dev/null 2>&1 || true
  fi
  fail "健康检查失败（已尝试回滚）"
fi

log "清理旧版本，保留最近 $KEEP 个"
case "$KEEP" in
  ''|*[!0-9]*|0) log "KEEP=${KEEP}，跳过清理" ;;
  *)
    CUR="$(resolve current)"
    for dir in $(ls -1dt releases/*/ 2>/dev/null | tail -n +"$((KEEP + 1))"); do
      abs="$(resolve "$dir")"
      [ "$abs" = "$CUR" ] && continue
      log "  删除 ${abs#"$REMOTE_DIR"/}"
      rm -rf "$abs"
    done
    ;;
esac

log "完成：current -> $(readlink current)"
