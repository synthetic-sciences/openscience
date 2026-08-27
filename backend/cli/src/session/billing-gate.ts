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
 * (a synced thk_* proxy token), or OAuth. `resolveCredentialSource` inspects
 * the resolved key and returns the authoritative class; the gate predicates
 * then key off that so the pre-flight balance check and the post-step usage
 * report agree on exactly what is billable.
 */

import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { OpenScience } from "@/openscience"

export type CredentialSource = "byok" | "managed" | "oauth-free"
export type BillingMode = "managed" | "byok"
export type TelemetryRoute = "managed" | "byok" | "chatgpt" | "subscription" | "local" | "custom"

/** The user-facing model-access choice (Settings → Models). `undefined` = auto-detect
 *  from the resolved credential (legacy behaviour; `null` in the config file —
 *  the toggle set back to auto — normalizes to the same thing). */
export async function llmBillingMode(): Promise<BillingMode | undefined> {
  return (await Config.get()).billing?.llm ?? undefined
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
 *   - "managed"    — a thk_* Atlas proxy token or a dashboard-synced secret.
 *                    Debits the wallet + is reported for billing.
 *   - "byok"       — the user's own api key (auth.json or shell env).
 *   - "oauth-free" — a first-party OAuth subscription (Claude/ChatGPT/Copilot).
 *
 * Only "managed" is billable. Managed detection wins over OAuth/BYOK because a
 * synced proxy token can be attached to any provider id.
 */
export async function resolveCredentialSource(providerID: string, _modelID: string): Promise<CredentialSource> {
  // Explicit BYOK toggle: the user opted out of managed billing for LLM calls, so
  // classify as the user's own account (byok / oauth-free) and never fire the wallet
  // gate. The Atlas proxy still meters any managed key server-side, so this cannot
  // create a free-managed-inference loophole — it only governs the client pre-flight.
  if ((await llmBillingMode()) === "byok") {
    const auth = await Auth.get(providerID).catch(() => undefined)
    return auth?.type === "oauth" ? "oauth-free" : "byok"
  }

  const auth = await Auth.get(providerID).catch(() => undefined)
  // The synthesized Codex provider exists only for Sign in with ChatGPT. Its
  // OAuth record is the billing authority even if stale managed-shaped config
  // happens to coexist with it; ChatGPT-plan calls must never touch Credits.
  if (isCodexOAuthProvider(providerID) && auth?.type === "oauth") return "oauth-free"

  const provider = await Provider.getProvider(providerID).catch(() => undefined)

  // 1) Managed: a thk_* proxy token. Classified by VALUE, not by how the
  //    credential arrived: the dashboard sync also delivers the user's own
  //    keys (OPENROUTER_API_KEY etc.), and treating "arrived via sync" as
  //    "managed" wallet-gated and billed BYOK keys — exactly what this
  //    module's contract forbids. It was also boot-order dependent (the
  //    synced-secret set is empty until an in-process sync runs).
  // Classify the one credential the provider will actually send. Raw losing
  // env values must not influence billing: auth.json intentionally overrides
  // environment credentials, and a stale thk_* next to a winning BYOK key is
  // not a managed request.
  const effective = provider ? Provider.effectiveKey(provider) : undefined
  if (OpenScience.isManagedKeyValue(effective)) return "managed"

  // 2) OAuth-free: a first-party OAuth subscription (user's own account).
  if (auth?.type === "oauth") return "oauth-free"
  if (OAUTH_FREE_PROVIDERS.has(providerID) && !effective && !auth) return "oauth-free"

  // 3) BYOK: the user's own key (or the zero-cost public demo). Never billable.
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
export function requiresWalletBalance(source: CredentialSource): boolean {
  return source === "managed"
}

/**
 * Whether a completed step should be reported to /api/cli/usage for billing.
 * Only managed-proxy credentials are billed; BYOK and OAuth-free calls run on
 * the user's own account and are never reported.
 */
export function shouldReportUsage(source: CredentialSource): boolean {
  return source === "managed"
}
