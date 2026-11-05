import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/tasks')({
  component: TasksLayout,
})

function TasksLayout() {
  return <Outlet />
}
