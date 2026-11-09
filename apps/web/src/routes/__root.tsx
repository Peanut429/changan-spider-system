import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/app-shell'
import { RouteNotFound } from '@/components/route-not-found'

import appCss from '../styles.css?url'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Changan RPA · 运营数据台' },
      { name: 'description', content: '按天查看抓取任务、账号数据与帖子数据' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: `${import.meta.env.BASE_URL}favicon.svg`, type: 'image/svg+xml' },
    ],
  }),
  shellComponent: RootDocument,
  // Unmatched URLs surface as a notFoundError on `__root__`; without this the
  // router falls back to its bare `<p>Not Found</p>` and logs a dev warning.
  notFoundComponent: RouteNotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // `data-theme` is written to <html> by lib/theme.ts before React hydrates, so
  // the first frame is already in the saved skin. The server cannot know that
  // attribute, hence the one expected difference — not a hydration bug.
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={250}>
              <AppShell>{children}</AppShell>
              <Toaster position="top-right" richColors closeButton />
            </TooltipProvider>
          </MotionConfig>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
