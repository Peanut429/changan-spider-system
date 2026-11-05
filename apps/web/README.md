# Changan RPA Console

运营数据台前端，独立于 `refactor-project`，基于：

- TanStack Start / TanStack Router
- React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui
- TanStack Query
- Motion（克制的页面/卡片过渡）

## 页面

- `/tasks`：按执行日期查看当天任务；同页分「待执行」和「执行记录」两块。
- `/tasks/$taskId`：任务概览、账号数据、帖子数据、运行信息。
- `/accounts`：账号列表、筛选、新增、编辑、启用/停用、账号类型。

## 本地启动

前端只负责界面，数据来自 `refactor-project` 的本地 API。

### 1. 启动 API

```bash
cd ../refactor-project
DATABASE_URL='postgres://admin:admin123@localhost:5432/changan_rpa_test' \
  DB_POOL_MAX=5 API_PORT=8787 \
  pnpm api:dev
```

API 默认监听 `http://127.0.0.1:8787`。

### 2. 启动前端

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。

`.env.development` 默认配置：

```text
VITE_API_BASE_URL=http://127.0.0.1:8787
```

部署时把 `VITE_API_BASE_URL` 指向同源反向代理或 API 地址即可。

## 检查

```bash
pnpm typecheck
pnpm build
```
