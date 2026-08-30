/** Classify user-owned provider access for local trace labels. */

import { Auth } from "@/auth"
import { OpenScience } from "@/openscience"
import { Provider } from "@/provider/provider"

export type CredentialSource = "byok" | "managed" | "oauth"
export type AccessRoute = "managed" | "byok" | "chatgpt" | "subscription" | "local" | "custom"

const OAUTH_PROVIDERS = new Set(["anthropic", "openai", "openai-codex", "github-copilot", "github-copilot-enterprise"])

export function isCodexOAuthProvider(providerID: string): boolean {
  return providerID === "openai-codex"
}

export async function resolveCredentialSource(providerID: string, _modelID: string): Promise<CredentialSource> {
  const auth = await Auth.get(providerID).catch(() => undefined)
  const provider = await Provider.getProvider(providerID).catch(() => undefined)
  const effective = provider ? Provider.effectiveKey(provider) : undefined
  if (providerID === "openrouter" && provider?.source === "managed" && OpenScience.isManagedKeyValue(effective)) {
    return "managed"
  }
  if (auth?.type === "oauth") return "oauth"
  if (OAUTH_PROVIDERS.has(providerID) && !auth) return "oauth"
  return "byok"
}

export function accessRoute(source: CredentialSource, model: Provider.Model): AccessRoute {
  if (
    model.providerID === "ollama" ||
    model.providerID === "lmstudio" ||
    Provider.isLocalBaseURL(model.options?.baseURL ?? model.api.url)
  ) {
    return "local"
  }
  if (source === "oauth" && model.providerID === "openai-codex") return "chatgpt"
  if (source === "oauth") return "subscription"
  if (source === "managed") return "managed"
  return "byok"
}

export function requiresWalletBalance(source: CredentialSource): boolean {
  return source === "managed"
}

export async function resolveAccessRoute(providerID: string, modelID: string): Promise<AccessRoute> {
  const model = await Provider.getModel(providerID, modelID).catch(() => undefined)
  if (!model) return "custom"
  return accessRoute(await resolveCredentialSource(providerID, modelID), model)
}
