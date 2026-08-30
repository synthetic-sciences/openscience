import type { ModelKey } from "./model-catalog"

export type ModelBillingMode = "managed" | "byok" | null | undefined
export type ModelRouteAccess = "byok" | "chatgpt"
export type ModelAccessRoute = ModelKey & { access: ModelRouteAccess }

const exactRoute = (left: ModelKey, right: ModelKey) =>
  left.providerID === right.providerID && left.modelID === right.modelID

/**
 * Pick one connected route for a logical model without folding provider
 * identities together. An attached ChatGPT subscription is preferred, then a
 * user API key.
 * An already selected exact route always wins so changing effort or speed can
 * never move a request onto another credential.
 */
export function resolveModelAccessRoute<T extends ModelAccessRoute>(input: {
  routes: readonly T[]
  billing: ModelBillingMode
  current?: ModelKey
}): T | undefined {
  if (input.current) {
    const current = input.routes.find((route) => exactRoute(route, input.current!))
    if (current) return current
  }

  const priority: readonly ModelRouteAccess[] = input.billing === "byok" ? ["byok", "chatgpt"] : ["chatgpt", "byok"]

  for (const access of priority) {
    const route = input.routes.find((candidate) => candidate.access === access)
    if (route) return route
  }
}
