import { useEffect, type ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'

import Balatro from '@/components/Balatro/Balatro'
import { useTheme } from '@/lib/theme'

/**
 * The console shell for every page: phosphor backdrop, `.cx` token scope and
 * the paper/ink switch. Pages only supply their own header and content.
 */
export function ConsolePage({ children }: { children: ReactNode }) {
  const { theme } = useTheme()
  const reduceMotion = useReducedMotion()

  // The console pages sit on their own screen instead of the app's paper.
  useEffect(() => {
    document.documentElement.classList.add('cx-page')
    return () => document.documentElement.classList.remove('cx-page')
  }, [])

  return (
    <div className="cx">
      <div className="cx-field" aria-hidden="true">
        <Balatro
          color1={theme === 'dark' ? '#04100c' : '#e9efea'}
          color2={theme === 'dark' ? '#0a3d2c' : '#a8c4b6'}
          color3={theme === 'dark' ? '#2fae7d' : '#0f7a55'}
          swirl={0.7}
          speed={reduceMotion ? 0 : 0.35}
          rotationSpeed={0.12}
          scale={1.1}
          detail={3}
          pixelSize={2}
          contrast={1.1}
          lighting={0.4}
          mouseInteraction
          mouseStrength={0.7}
          clickSwirl
          lightMode={theme === 'light'}
          opacity={theme === 'dark' ? 0.5 : 0.7}
          maxDevicePixelRatio={1.5}
        />
      </div>
      {children}
    </div>
  )
}
