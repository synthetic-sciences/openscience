import { managedOpenRouterBaseURL } from "../openscience/synced-env-policy"

/** Shared-wallet inference has one auditable transport. Upstream metadata may
 * describe pricing and capabilities, but it never selects a direct SDK route. */
export function managedModelRoute(model: string) {
  return { npm: "@openrouter/ai-sdk-provider", id: model, url: managedOpenRouterBaseURL() }
}
