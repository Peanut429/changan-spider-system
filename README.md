# Changan RPA Monorepo

## 结构

```text
apps/
  crawler/   # 爬虫 worker，轮询数据库任务；不暴露 API
  web/       # TanStack Start 全栈 Web，直接访问数据库
packages/
  db/        # 共用数据库连接/schema
  shared/    # 共用时间、ID、DTO
```

## 开发

```bash
pnpm install

# Web：页面 + 同源 /api server routes，直接连 DB
DATABASE_URL='postgres://.../changan_rpa_test' pnpm dev:web

# Crawler：只轮询数据库
DATABASE_URL='postgres://.../changan_rpa_test' pnpm worker
```

Web 和 crawler 只通过数据库交互，不通过 HTTP 互相调用。

## 检查

```bash
pnpm typecheck
pnpm test
pnpm build:web
```
