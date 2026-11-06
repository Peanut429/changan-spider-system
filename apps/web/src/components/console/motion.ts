/**
 * Motion tokens for the console. One curve, one spring, two speeds — so
 * everything on the page moves like it belongs to the same object.
 */

export const EASE_OUT = [0.22, 1, 0.36, 1] as const

/** Rows arriving after a load or a date change. */
export const ROW_IN = { duration: 0.26, ease: EASE_OUT } as const

/** 34ms between rows: enough to read as a sequence, short enough to stay one gesture. */
export const ROW_STAGGER = 0.034

/** Numbers settling on a new value. Critically damped, no overshoot. */
export const NUMBER_SPRING = { bounce: 0, duration: 0.62 } as const
