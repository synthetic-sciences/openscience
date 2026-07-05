/**
 * Billing gate predicates for LLM calls.
 *
 * The openscience CLI wallet only pays for *managed-proxy* calls. Everything else —
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
import { Env } from "@/env"
import { Provider } from "@/provider/provider"
import { OpenScience } from "@/openscience"

export type CredentialSource = "byok" | "managed" | "oauth-free"
export type BillingMode = "managed" | "byok"

/** The user-facing LLM spend toggle (Settings → Spend). `undefined` = auto-detect
 *  from the resolved credential (legacy behaviour; `null` in the config file —
 *  the toggle set back to auto — normalizes to the same thing). */
export async function llmBillingMode(): Promise<BillingMode | undefined> {
  return (await Config.get()).billing?.llm ?? undefined
}

/** The user-facing compute spend toggle. Defaults to "byok" (own GPU providers). */
export async function computeBillingMode(): Promise<BillingMode> {
  return (await Config.get()).billing?.compute ?? "byok"
}

/** First-party providers whose OAuth path runs on the user's own subscription
 *  and never debits the CLI wallet. */
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

  const provider = await Provider.getProvider(providerID).catch(() => undefined)

  // 1) Managed: a thk_* proxy token. Classified by VALUE, not by how the
  //    credential arrived: the dashboard sync also delivers the user's own
  //    keys (OPENROUTER_API_KEY etc.), and treating "arrived via sync" as
  //    "managed" wallet-gated and billed BYOK keys — exactly what this
  //    module's contract forbids. It was also boot-order dependent (the
  //    synced-secret set is empty until an in-process sync runs).
  const optionKey = provider?.options?.["apiKey"]
  const resolvedKey = typeof provider?.key === "string" ? provider.key : undefined
  const explicitKey = typeof optionKey === "string" ? optionKey : undefined
  if (OpenScience.isManagedKeyValue(resolvedKey) || OpenScience.isManagedKeyValue(explicitKey)) {
    return "managed"
  }
  const envKeys = provider?.env ?? []
  for (const key of envKeys) {
    if (OpenScience.isManagedKeyValue(Env.get(key))) return "managed"
  }

  // 2) OAuth-free: a first-party OAuth subscription (user's own account).
  const auth = await Auth.get(providerID).catch(() => undefined)
  if (auth?.type === "oauth") return "oauth-free"
  if (OAUTH_FREE_PROVIDERS.has(providerID) && !resolvedKey && !explicitKey && !auth) return "oauth-free"

  // 3) BYOK: the user's own key (or the zero-cost public demo). Never billable.
  return "byok"
}

/**
 * Whether the pre-flight CLI-wallet balance check should run for this call.
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
