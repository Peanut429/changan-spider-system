import { createFileRoute, redirect } from '@tanstack/react-router'
import { todayKey } from '@/lib/format'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/tasks', search: { date: todayKey() } })
  },
})
