import { useEffect, useRef } from 'react'
import { animate, useReducedMotion } from 'motion/react'

import { EASE_OUT } from './motion'

const formatter = new Intl.NumberFormat('zh-CN')

/**
 * A number that travels to its new value instead of swapping. It animates from
 * whatever is on screen right now, so a second value arriving mid-flight
 * continues from there instead of restarting. Reduced motion just prints it.
 */
export function AnimatedNumber({ value }: { value: number }) {
  const reduceMotion = useReducedMotion()
  const nodeRef = useRef<HTMLSpanElement>(null)
  const shown = useRef(0)

  useEffect(() => {
    const node = nodeRef.current
    if (!node) return

    if (reduceMotion) {
      shown.current = value
      node.textContent = formatter.format(value)
      return
    }

    const controls = animate(shown.current, value, {
      duration: 0.62,
      ease: EASE_OUT,
      onUpdate: (current) => {
        shown.current = current
        node.textContent = formatter.format(Math.round(current))
      },
    })

    return () => controls.stop()
  }, [value, reduceMotion])

  return <span ref={nodeRef}>{formatter.format(reduceMotion ? value : Math.round(shown.current))}</span>
}
