import z from "zod"

/**
 * Ask a provider whether an API key works before it is stored.
 *
 * Free of Provider, Config and Auth on purpose: the onboarding route imports
 * this module, and Provider imports the server that mounts that route.
 */
export namespace KeyCheck {
  /**
   * `unreachable` covers every answer that says nothing about the key (no
   * network, a timeout, a 5xx, a rate limit), so an offline machine still saves.
   */
  export type Outcome = "accepted" | "rejected" | "unreachable" | "skipped"

  export type Fetch = (url: string, init: RequestInit) => Promise<Response>

  type Probe = {
    name: string
    /** The cheapest authenticated read the provider offers. */
    url: string
    /** The key travels in a header only; URLs end up in proxy and server logs. */
    headers(key: string): Record<string, string>
    /** Environment variables that point this provider at another host. */
    base: string[]
    /** A refusal the provider does not report as 401. */
    refused?(response: Response): Promise<boolean>
  }

  const GoogleError = z.object({
    error: z.object({ details: z.array(z.object({ reason: z.string().optional() })) }),
  })

  const PROBES: Record<string, Probe> = {
    anthropic: {
      name: "Anthropic",
      url: "https://api.anthropic.com/v1/models",
      headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
      base: ["ANTHROPIC_BASE_URL"],
    },
    openai: {
      name: "OpenAI",
      url: "https://api.openai.com/v1/models",
      headers: (key) => ({ authorization: `Bearer ${key}` }),
      base: ["OPENAI_BASE_URL"],
    },
    openrouter: {
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/key",
      headers: (key) => ({ authorization: `Bearer ${key}` }),
      base: ["OPENROUTER_BASE_URL"],
    },
    google: {
      name: "Google",
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      headers: (key) => ({ "x-goog-api-key": key }),
      base: ["GOOGLE_GENERATIVE_AI_BASE_URL", "GOOGLE_BASE_URL", "GEMINI_BASE_URL"],
      // The Gemini API answers a wrong key with 400 INVALID_ARGUMENT, the same
      // status as a malformed request, so only its stated reason counts.
      refused: async (response) => {
        if (response.status !== 400) return false
        const body = GoogleError.safeParse(await response.json().catch(() => undefined))
        return body.success && body.data.error.details.some((detail) => detail.reason === "API_KEY_INVALID")
      },
    },
  }

  const DEADLINE_MS = 6_000

  export function rejection(providerID: string): string {
    return `${PROBES[providerID]?.name ?? providerID} did not accept that key.`
  }

  /** The part of the configuration that can route a provider to another host. */
  export type Routing = {
    provider?: Record<string, { api?: string; options?: Record<string, unknown> } | undefined>
  }

  function repointed(probe: Probe, providerID: string, config: Routing, env: Record<string, string | undefined>) {
    const entry = config.provider?.[providerID]
    if (entry?.api || entry?.options?.["baseURL"]) return true
    return probe.base.some((name) => !!env[name])
  }

  export async function verify(input: {
    providerID: string
    key: string
    /** Read lazily: a provider without a probe never needs it. */
    config(): Promise<Routing>
    env?: Record<string, string | undefined>
    fetch?: Fetch
    deadlineMs?: number
  }): Promise<Outcome> {
    const probe = PROBES[input.providerID]
    if (!probe) return "skipped"
    // A key meant for the person's own endpoint must not be sent to the public
    // API, which would also refuse it and block a working setup. A config that
    // cannot be read cannot rule that out, so the key stays home.
    const custom = await input
      .config()
      .then((config) => repointed(probe, input.providerID, config, input.env ?? process.env))
      .catch(() => true)
    if (custom) return "skipped"
    const response = await (input.fetch ?? fetch)(probe.url, {
      headers: probe.headers(input.key),
      // A redirect would carry the key header to a host this table does not name.
      redirect: "error",
      signal: AbortSignal.timeout(input.deadlineMs ?? DEADLINE_MS),
    }).catch(() => undefined)
    if (!response) return "unreachable"
    // 403 is not a refusal of the key: a restricted key that may run models
    // but not list them, or a region the listing is closed to, answers 403
    // while the key works. Only "who are you" counts.
    const refused = response.status === 401 || (await probe.refused?.(response).catch(() => false)) === true
    // Only the status matters; a model list left unread would hold the socket.
    await response.body?.cancel().catch(() => undefined)
    if (refused) return "rejected"
    return response.ok ? "accepted" : "unreachable"
  }
}
