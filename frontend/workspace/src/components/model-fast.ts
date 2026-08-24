export type FastCapableRoute = {
  modes?: Record<string, unknown>
}

export function exactRouteFastMode(route: FastCapableRoute | undefined, tier: string) {
  if (!route || !Object.prototype.hasOwnProperty.call(route.modes ?? {}, "fast")) return
  return { active: tier === "fast" }
}
