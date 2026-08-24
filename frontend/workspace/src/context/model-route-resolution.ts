import type { ModelKey } from "./model-catalog"

export type ModelBillingMode = "managed" | "byok" | null | undefined
export type ModelRouteAccess = "managed" | "byok" | "chatgpt"
export type ModelAccessRoute = ModelKey & { access: ModelRouteAccess }

const exactRoute = (left: ModelKey, right: ModelKey) =>
  left.providerID === right.providerID && left.modelID === right.modelID

/**
 * Pick one connected route for a logical model without folding provider
 * identities together. Automatic prefers an attached ChatGPT subscription;
 * Credits stays on managed inference; Accounts prefers a direct user route.
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

  const priority: readonly ModelRouteAccess[] =
    input.billing === "managed"
      ? ["managed"]
      : input.billing === "byok"
        ? ["byok", "chatgpt"]
        : ["chatgpt", "byok", "managed"]

  for (const access of priority) {
    const route = input.routes.find((candidate) => candidate.access === access)
    if (route) return route
  }
}
