const navigationKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"])

export function moveStoredArtifactMenuFocus(scope: HTMLElement, target: EventTarget | null, key: string) {
  if (!navigationKeys.has(key)) return false

  const items = Array.from(scope.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
  if (items.length === 0) return false

  const current = target instanceof HTMLElement ? target.closest<HTMLElement>('[role="menuitem"]') : undefined
  const index = current ? items.indexOf(current) : -1
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : key === "ArrowDown"
          ? (Math.max(index, -1) + 1) % items.length
          : (index <= 0 ? items.length : index) - 1
  const item = items[next]
  if (!item) return false

  for (const candidate of items) candidate.tabIndex = candidate === item ? 0 : -1
  item.focus()
  return true
}
