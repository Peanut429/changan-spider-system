import type { ReactNode } from 'react'

export function ConsoleBar({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children?: ReactNode
}) {
  const trailing = actions ?? children
  return (
    <header className="cx-bar">
      <div>
        <h1 className="cx-title">{title}</h1>
        {description ? <p className="cx-sub">{description}</p> : null}
      </div>
      {trailing ? <div className="cx-actions">{trailing}</div> : null}
    </header>
  )
}
