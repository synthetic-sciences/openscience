/**
 * How long ago something happened, coarsened to one unit. A group header wants
 * the bare span ("3h") and a card wants it as a phrase ("3h ago"), which is the
 * only difference between the two and not a reason to write it twice.
 */
export const age = (created: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - created) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export const ago = (created: number) => `${age(created)} ago`
