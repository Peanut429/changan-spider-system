# Changan RPA Monorepo

## 结构

```text
apps/
  crawler/   # 爬虫 worker，轮询数据库任务；不暴露 API
  web/       # TanStack Start 全栈 Web，直接访问数据库
packages/
  db/        # 共用的数据库连接/schema/repository
  shared/    # 共用的 DTO 和类型
```

## 开发

```bash
pnpm install
pnpm dev:web
pnpm dev:api
pnpm worker
```

`dev:api` 目前是迁移期间的过渡入口，最终会并入 `apps/web` 的 server 层，不再单独占用 API 端口。

## 检查

```bash
pnpm typecheck
pnpm test
pnpm build:web
```
