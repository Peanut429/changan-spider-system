import { defineConfig, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

/**
 * 部署到子路径时（例如 nginx 转发 /changan-data/），在 apps/web/.env 里配置：
 *   BASE_PATH=/changan-data
 * 不配就是根路径，本地开发不受影响。
 *
 * base 会同时作用于三处，缺一不可：
 *   - vite base        → HTML 里的 /changan-data/assets/xxx.js
 *   - nitro baseURL    → 服务端在 /changan-data/ 下提供静态资源和路由
 *   - import.meta.env.BASE_URL → 路由 basepath、fetch 前缀、favicon
 */
const config = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const raw = (env.BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '')
  const base = raw ? `/${raw}/` : '/'

  return {
    base,
    resolve: { tsconfigPaths: true },
    server: { port: 3000 },
    plugins: [
      devtools(),
      nitro({ baseURL: base, rollupConfig: { external: [/^@sentry\//] } }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  }
})

export default config
