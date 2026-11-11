#!/usr/bin/env bash
# 评论任务 cron 包装脚本（只走 TikHub 接口，不需要 Chrome / Xvfb）。
#
# 用法：
#   COMMENT_ACCOUNT_TYPE=总部 ./deploy/comment-run.sh
#   COMMENT_ACCOUNT_TYPE=总部 ./deploy/comment-run.sh --platform instagram --account byd.uk --since 2026-09-01 --until 2026-09-30
#
# 环境变量：
#   COMMENT_ACCOUNT_TYPE  必填，账号类型（account_categories 的 code/name）
#   COMMENT_PLATFORMS     可选，默认 instagram,tiktok,youtube,x
#   NODE_BIN              可选，cron 下建议写绝对路径（见 DEPLOY.md 9.1）
#
# 默认跑上个月；显式传 --since/--until/--last-month/--run-id 时不再追加 --last-month。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/crawler"

: "${COMMENT_ACCOUNT_TYPE:?请设置 COMMENT_ACCOUNT_TYPE（账号类型）}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

has_window=0
for arg in "$@"; do
  case "$arg" in
    --since|--until|--last-month|--run-id) has_window=1 ;;
  esac
done

extra=()
[ "$has_window" -eq 1 ] || extra+=(--last-month)

exec "$NODE_BIN" --experimental-strip-types src/main/comment-run.ts \
  --trigger scheduled \
  --account-type "$COMMENT_ACCOUNT_TYPE" \
  --platforms "${COMMENT_PLATFORMS:-instagram,tiktok,youtube,x}" \
  ${extra[@]+"${extra[@]}"} \
  "$@"
