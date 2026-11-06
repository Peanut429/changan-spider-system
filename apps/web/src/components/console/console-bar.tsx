import type { ReactNode } from 'react'

export function ConsoleBar({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <header className="cx-bar">
      <div>
        <h1 className="cx-title">{title}</h1>
        {description ? <p className="cx-sub">{description}</p> : null}
      </div>
      {children ? <div className="cx-actions">{children}</div> : null}
    </header>
  )
}
