export const SIDEBAR_WIDTH = { min: 208, max: 320, initial: 232, collapsed: 56 } as const

export function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(value)))
}
