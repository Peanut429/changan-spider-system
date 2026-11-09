import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// BASE_URL 形如 "/changan-data/"（根路径时为 "/"）
const basepath = import.meta.env.BASE_URL.replace(/\/$/, '')

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    basepath: basepath || undefined,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
