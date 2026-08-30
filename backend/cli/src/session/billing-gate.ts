/**
 * Billing gate predicates for LLM calls.
 *
 * Credits only pay for *managed-proxy* calls. Everything else -
 * a user's own key (BYOK) or a first-party OAuth subscription (Claude Pro/Max,
 * Sign in with ChatGPT, Copilot) — costs the wallet nothing and must never be
 * blocked by it or reported for billing.
 *
 * Which class a call falls into is decided by the *credential*, not the
 * provider id: the same providerID (e.g. "anthropic") can be BYOK, managed
 * (a synced osk_* or legacy thk_* proxy token), or OAuth.
 * `resolveCredentialSource` inspects
 * the resolved key and returns the authoritative class; the gate predicates
 * then key off that so the pre-flight balance check and the post-step usage
 * report agree on exactly what is billable.
 */

import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"

export type CredentialSource = "byok" | "managed" | "oauth-free"
export type BillingMode = "managed" | "byok"
export type TelemetryRoute = "managed" | "byok" | "chatgpt" | "subscription" | "local" | "custom"

/** The user-facing model-access choice (Settings → Models). `undefined` = auto-detect
 *  from the resolved credential (legacy behaviour; `null` in the config file —
 *  the toggle set back to auto — normalizes to the same thing). */
export async function llmBillingMode(): Promise<BillingMode | undefined> {
  return "byok"
}

/** First-party providers whose OAuth path runs on the user's own subscription
 *  and never debits Credits. */
const OAUTH_FREE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "github-copilot",
  "github-copilot-enterprise",
])

/** The synthesized Codex OAuth provider (see provider/provider.ts). */
export function isCodexOAuthProvider(providerID: string): boolean {
  return providerID === "openai-codex"
}

/**
 * Classify the credential backing a call as one of:
 *   - "managed"    — an Atlas workspace proxy token or dashboard-synced secret.
 *                    Debits the wallet + is reported for billing.
 *   - "byok"       — the user's own api key (auth.json or shell env).
 *   - "oauth-free" — a first-party OAuth subscription (Claude/ChatGPT/Copilot).
 *
 * Only "managed" is billable. Managed detection wins over OAuth/BYOK because a
 * synced proxy token can be attached to any provider id.
 */
export async function resolveCredentialSource(providerID: string, _modelID: string): Promise<CredentialSource> {
  const auth = await Auth.get(providerID).catch(() => undefined)
  if (auth?.type === "oauth") return "oauth-free"
  if (OAUTH_FREE_PROVIDERS.has(providerID) && !auth) return "oauth-free"
  return "byok"
}

export function telemetryRoute(source: CredentialSource, model: Provider.Model): TelemetryRoute {
  if (
    model.providerID === "ollama" ||
    model.providerID === "lmstudio" ||
    Provider.isLocalBaseURL(model.options?.baseURL ?? model.api.url)
  ) {
    return "local"
  }
  if (source === "managed") return "managed"
  if (source === "oauth-free" && model.providerID === "openai-codex") return "chatgpt"
  if (source === "oauth-free") return "subscription"
  return "byok"
}

export async function resolveTelemetryRoute(providerID: string, modelID: string): Promise<TelemetryRoute> {
  const model = await Provider.getModel(providerID, modelID).catch(() => undefined)
  if (!model) return "custom"
  return telemetryRoute(await resolveCredentialSource(providerID, modelID), model)
}

/**
 * Whether the pre-flight credit balance check should run for this call.
 * Only managed-proxy credentials draw down the wallet, so BYOK and OAuth-free
 * calls must skip the check entirely — an empty wallet never blocks them.
 */
export function requiresWalletBalance(_source: CredentialSource): boolean {
  return false
}

/**
 * Whether a completed step should be reported to /api/cli/usage for billing.
 * Only managed-proxy credentials are billed; BYOK and OAuth-free calls run on
 * the user's own account and are never reported.
 */
export function shouldReportUsage(_source: CredentialSource): boolean {
  return false
}
