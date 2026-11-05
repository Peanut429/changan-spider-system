# @changan/web

TanStack Start 全栈 Web。

- 页面、server functions / server routes 都在这个 app；
- 通过 `@changan/db` 直接访问数据库；
- 不再需要单独的 API 服务或 `VITE_API_BASE_URL`；
- crawler worker 只轮询数据库，不暴露端口。

## 启动

```bash
cd ../..
DATABASE_URL='postgres://.../changan_rpa_test' pnpm dev:web
```

默认地址：`http://localhost:3000`。
