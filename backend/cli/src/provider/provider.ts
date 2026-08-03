import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import { ModelsDev } from "./models"
import { NamedError } from "@synsci/util/error"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { ProjectTrust } from "../project/trust"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { OpenScience } from "../openscience"
import { isAtlasProxyURL, managedOpenRouterBaseURL } from "../openscience/synced-env-policy"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/openai-compatible/src"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createGitLab } from "@gitlab/gitlab-ai-provider"
import { ProviderTransform } from "./transform"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  // Models exposed by the ChatGPT / Codex OAuth transport. Keep the dot and
  // dash spellings because older models.dev snapshots normalized version dots
  // while current snapshots preserve the upstream ids.
  const CODEX_MODEL_IDS = new Set([
    "gpt-5.6-sol",
    "gpt-5-6-sol",
    "gpt-5.6-terra",
    "gpt-5-6-terra",
    "gpt-5.6-luna",
    "gpt-5-6-luna",
    "gpt-5.5",
    "gpt-5-5",
    "gpt-5.4",
    "gpt-5-4",
    "gpt-5.4-mini",
    "gpt-5-4-mini",
  ])

  export function isCodexOAuthModel(modelID: string): boolean {
    return CODEX_MODEL_IDS.has(modelID)
  }

  function codexOAuthModes(modelID: string) {
    if (!/^gpt-5[.-](?:4(?:-mini)?|5|6(?:-(?:sol|terra|luna))?)$/.test(modelID)) return undefined
    return {
      fast: {
        provider: {
          body: {
            service_tier: "priority",
          },
          headers: {},
        },
      },
    }
  }

  function isGpt5OrLater(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) {
      return false
    }
    return Number(match[1]) >= 5
  }

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
  }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "@gitlab/gitlab-ai-provider": createGitLab,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  const REMOVED_MODEL_IDS = new Set(["mistralai/mistral-small-3.2-24b-instruct"])

  function isRemovedModel(modelID: string) {
    const normalized = modelID.toLowerCase()
    if (normalized.includes("fable")) return true
    return REMOVED_MODEL_IDS.has(normalized)
  }

  export function isAtlasProxyBaseURL(baseURL: unknown): baseURL is string {
    return isAtlasProxyURL(baseURL)
  }

  const PUBLIC_PROVIDER_BASE_URLS: Record<string, string> = {
    anthropic: "https://api.anthropic.com/v1",
    openai: "https://api.openai.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    xai: "https://api.x.ai/v1",
  }

  /** Detect a stale managed-proxy path without trusting its origin. This is
   * used only to keep a user's BYOK secret away from any old proxy URL. Managed
   * Atlas tokens still require isAtlasProxyBaseURL's exact configured origin. */
  function hasManagedProxyPath(baseURL: unknown): baseURL is string {
    if (typeof baseURL !== "string") return false
    try {
      // Atlas may be hosted below a path prefix (for example
      // https://host/control/api/llm/proxy/...). Match the exact proxy path
      // segments anywhere in the normalized pathname so a stale prefixed URL
      // can never receive a user-owned key. Collapsing repeated slashes and
      // decoding escaped separators is deliberately conservative: custom
      // gateways with an Atlas-proxy-shaped path are pinned to the provider's
      // public endpoint instead of risking credential disclosure.
      let path = new URL(baseURL).pathname
      for (let pass = 0; pass < 3 && path.includes("%"); pass++) {
        let decoded: string
        try {
          decoded = decodeURIComponent(path)
        } catch {
          // Keep checking the undecoded path. A malformed escape before a
          // plain /api/llm/proxy suffix must not disable the leak guard.
          break
        }
        if (decoded === path) break
        path = decoded
      }
      path = path.replace(/\/+/g, "/").replace(/\/+$/, "")
      return /\/api\/llm\/proxy(?:\/|$)/.test(path)
    } catch {
      return false
    }
  }

  /** Strict compatibility probe for a well-formed managed-proxy path on any
   * origin. BYOK leak prevention uses hasManagedProxyPath directly. */
  export function isManagedProxyBaseURL(baseURL: unknown): baseURL is string {
    if (!hasManagedProxyPath(baseURL)) return false
    try {
      const url = new URL(baseURL)
      return !url.search && !url.hash
    } catch {
      return false
    }
  }

  // Explicit apiKey for a provider routed through the Atlas managed proxy: force
  // the session thk_ token. These SDKs read `<PROVIDER>_API_KEY` straight from
  // env, so a shell `export OPENAI_API_KEY=sk-...` would otherwise shadow the
  // managed token and 401 the proxy ("thk_* token not found"). Returns {} unless
  // both managed spend is on AND the baseURL is the Atlas proxy — genuine BYOK
  // (no proxy URL) is untouched and hits the provider directly.
  async function managedProxyKey(providerID: string, baseURL: unknown): Promise<{ apiKey?: string }> {
    const managed =
      isAtlasProxyBaseURL(baseURL) && (await Config.get().catch(() => undefined))?.billing?.llm === "managed"
    if (!managed) return {}
    // Managed wallet routes are deliberately narrow: OpenRouter for the
    // aggregated catalog. Never attach the wallet's thk_ token to any other
    // first-party proxy (anthropic / openai / google / xAI / Meta). Those
    // providers are also dropped from availability below, so this is
    // belt-and-suspenders.
    if (!managedProviderAllowed(providerID)) return {}
    const session = await OpenScience.getSession().catch(() => null)
    return session?.api_key ? { apiKey: session.api_key } : {}
  }

  function requireAtlasProxyForManagedKey(provider: Info, options: Record<string, any>) {
    // Key off the EFFECTIVE credential, not raw env. A managed thk_ value can
    // sit unused in env while an auth.json key wins resolution; demanding
    // proxy routing for it hard-failed every call with advice (`connect
    // sync`) that re-delivers the same env and can never fix it.
    const effective = effectiveKey(provider, options)
    if (!Auth.isAtlasApiKey(effective)) return
    if (isAtlasProxyBaseURL(options["baseURL"])) return
    throw new Error(
      `${provider.id} is using a managed Atlas key without an Atlas proxy URL. ` +
        "Run `openscience sync` and try again.",
    )
  }

  /** A user-owned (BYOK) key: a real, non-managed credential. Excludes the
   *  "public" sentinel used for the zero-cost openscience demo models. */
  function isByokKey(key: unknown): key is string {
    return typeof key === "string" && key.length > 0 && key !== "public" && !Auth.isAtlasApiKey(key)
  }

  /** The credential that actually authenticates a provider: an explicit apiKey
   *  (from a loader / config / getSDK options), the resolved provider key, or
   *  the first of its env vars that is set — undefined when it has none. Shared
   *  by the routing-label display and the managed/BYOK proxy guards so all read
   *  the credential the same way. `options` defaults to the provider's own; the
   *  proxy guards pass the mutable getSDK options instead. */
  export function effectiveKey(
    provider: Info,
    options: Record<string, unknown> = provider.options ?? {},
  ): string | undefined {
    const optionKey = typeof options["apiKey"] === "string" ? (options["apiKey"] as string) : undefined
    return (
      optionKey ??
      provider.key ??
      (provider.env ?? []).map((name) => Env.get(name)).find((value): value is string => !!value)
    )
  }

  /** Managed wallet ⇒ curated managed-provider routing.
   *
   *  When the LLM spend toggle is explicitly "managed", every wallet inference
   *  call flows through OpenRouter. The other first-party managed proxies
   *  (anthropic / openai / google / xAI / Meta) are taken out of the managed
   *  path entirely; the hosted
   *  zero-cost `synsci` demo provider is kept. BYOK and the legacy
   *  auto-detect path (`billing.llm` unset / null / "byok") are UNTOUCHED —
   *  this only fires on an explicit managed-wallet opt-in. Pure + sync. */
  export function managedRoutesCuratedProvidersOnly(config: Config.Info): boolean {
    return config.billing?.llm === "managed"
  }

  /** Providers a managed wallet session may load: OpenRouter for aggregated
   *  inference, plus the hosted `synsci` demo. Pure. */
  export function managedProviderAllowed(providerID: string): boolean {
    return providerID === "openrouter" || providerID.startsWith("synsci")
  }

  const OPENROUTER_VENDOR_PREFIX: Record<string, string> = {
    gemini: "google",
    google: "google",
    xai: "x-ai",
    meta: "meta",
    zai: "z-ai",
    zhipuai: "z-ai",
  }

  const ANTHROPIC_DASHED_VERSION = /^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)(?:-\d{8})?$/

  function openrouterAliasCandidates(providerID: string, modelID: string) {
    if (providerID === "openrouter") return []
    const vendor = OPENROUTER_VENDOR_PREFIX[providerID] ?? providerID
    const base = modelID.replace(/^~/, "")
    if (!vendor || !base) return []
    const direct = `${vendor}/${base}`
    const normalized = vendor === "anthropic" ? `${vendor}/${base.replace(ANTHROPIC_DASHED_VERSION, "$1.$2")}` : direct
    const aliased = providerID === "openai" && base === "gpt-5.6" ? ["openai/gpt-5.6-sol"] : []
    return Array.from(new Set([direct, normalized, ...aliased]))
  }

  /** True when a base URL points at the local machine (localhost / loopback).
   *  A provider with a local baseURL runs on the user's own hardware, is free,
   *  and is BYOK-class — so it's kept available even in managed-wallet mode
   *  (where the wallet itself still routes only through curated proxies). Pure. */
  export function isLocalBaseURL(url: unknown): boolean {
    if (typeof url !== "string" || !url) return false
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
      return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1"
    } catch {
      return false
    }
  }

  /**
   * Blocker (c) — the inverse of requireAtlasProxyForManagedKey.
   *
   * A prior managed sync may have injected an Atlas proxy `*_BASE_URL` (e.g.
   * ANTHROPIC_BASE_URL → app.syntheticsciences.ai). If the resolved key is the
   * user's OWN key (BYOK), that key must NEVER be sent to the Atlas proxy — it
   * would leak the credential and mis-bill. Pin the base URL back to the
   * provider's public endpoint and drop the managed routing.
   */
  function pinByokToPublicEndpoint(provider: Info, options: Record<string, any>, publicURL?: string) {
    const effective = effectiveKey(provider, options)
    // Managed (thk_*) keys must keep their Atlas proxy routing.
    if (Auth.isAtlasApiKey(effective)) return
    if (!isByokKey(effective)) return
    if (hasManagedProxyPath(options["baseURL"])) {
      log.warn("refusing to route BYOK key through Atlas proxy — pinning to public endpoint", {
        provider: provider.id,
      })
      const modelURL = typeof publicURL === "string" && !hasManagedProxyPath(publicURL) ? publicURL : undefined
      const safeURL = modelURL ?? PUBLIC_PROVIDER_BASE_URLS[provider.id]
      if (!safeURL) {
        throw new Error(
          `${provider.id} is using a user-owned key with an Atlas proxy URL, but no safe public endpoint is known. ` +
            "Remove the managed proxy base URL and try again.",
        )
      }
      // Set an explicit value even when the catalog omitted model.api.url.
      // Leaving this undefined lets several provider SDKs re-read the stale
      // *_BASE_URL directly from process.env and defeats the guard.
      options["baseURL"] = safeURL
    }
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
    // Overrides the reported `source` regardless of whether the provider was
    // already registered by an earlier stage (env/api/plugin). Only the
    // openrouter loader's managed-proxy branch sets this today — every other
    // loader leaves it undefined and keeps the call site's default behavior.
    source?: Info["source"]
  }>

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      const baseURL = Env.get("ANTHROPIC_BASE_URL")
      return {
        autoload: false,
        options: {
          ...(baseURL ? { baseURL, ...(await managedProxyKey("anthropic", baseURL)) } : {}),
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    // Keyed on the catalog provider id `synsci` (the Atlas wire-contract id) — a
    // stale `openscience` key here never matched database["openscience"], so the
    // loop logged "Provider does not exist in model list openscience" and this
    // loader never ran: the zero-cost demo's `apiKey: "public"` sentinel was
    // never set (new keyless users couldn't use the demo at all) and the
    // "drop paid models when no key" gating was skipped.
    async synsci(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.[input.id]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    openai: async () => {
      const baseURL = Env.get("OPENAI_BASE_URL")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: baseURL ? { baseURL, ...(await managedProxyKey("openai", baseURL)) } : {},
      }
    },
    xai: async () => {
      return {
        autoload: false,
        // Grok 4.5's low/medium/high effort ladder is implemented by xAI's
        // Responses API. The pinned chat adapter accepts only low/high and
        // rejects medium before sending a request, so route just this family
        // through responses while preserving chat behavior for older models.
        //
        // This responses path only works because of
        // tooling/patches/@ai-sdk%2Fxai@2.0.51.patch. xAI opens every stream
        // with `response.created` carrying `"usage": null`, which the pinned
        // 2.0.51 schema rejects (it marks usage optional, not nullable), so
        // Grok 4.5 died on its first SSE event. @ai-sdk/xai@4.0.25 ships the
        // same fix upstream; drop the patch when the @ai-sdk major bump lands.
        async getModel(sdk: any, modelID: string) {
          return /grok-4[.-]5\b/i.test(modelID) ? sdk.responses(modelID) : sdk.languageModel(modelID)
        },
      }
    },
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      const awsBearerToken = iife(() => {
        const envToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
        if (envToken) return envToken
        if (auth?.type === "api") {
          Env.set("AWS_BEARER_TOKEN_BEDROCK", auth.key)
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile) return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken) {
        const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))

        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          if (modelID.startsWith("global.") || modelID.startsWith("jp.")) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from openscience.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-6", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      const headers = {
        "HTTP-Referer": "https://syntheticsciences.ai/",
        "X-Title": "synsci",
      }
      // OpenRouter is the ONE provider with both a managed and a BYOK route.
      // Resolution is gated on the explicit `billing.llm` spend toggle: an
      // explicit "managed" opt-in refuses to route on a stored own key, so it
      // resolves the Atlas managed proxy (thk_* token → wallet-billed) even
      // when an own key exists. The key is retained in auth (never
      // deleted/rewritten) and simply loses this branch. When managed spend is
      // on but NO managed credential can be found — a lapsed Atlas session,
      // say — this returns no credential at all, and the availability guard in
      // init() then drops the provider outright; it must, because the earlier
      // "load apikeys" stage has already stamped provider.key from auth.json
      // and getSDK would otherwise fall back to it against public OpenRouter,
      // billing the user's own key under a toggle that reads "Managed".
      // `byok` and auto-detect (unset / null) are unchanged from the old
      // key-presence rule: the user's OWN OpenRouter key wins and hits public
      // OpenRouter directly; with no own key, a logged-in session falls back
      // to the Atlas managed proxy. Switching billing.llm back to
      // byok/auto-detect (or deleting the own key under those modes) restores
      // the previous resolution automatically — nothing is latched.
      const auth = await Auth.get("openrouter").catch(() => undefined)
      const authKey = auth?.type === "api" ? auth.key : undefined
      const envKey = Env.get("OPENROUTER_API_KEY")
      const managed = (await Config.get().catch(() => undefined))?.billing?.llm === "managed"
      const ownKey = managed ? undefined : isByokKey(authKey) ? authKey : isByokKey(envKey) ? envKey : undefined
      if (ownKey) {
        // Honour a user's own OpenRouter-compatible gateway (custom
        // OPENROUTER_BASE_URL); only the Atlas proxy is swapped for the public
        // endpoint, since a BYOK key must never be sent to the managed proxy.
        const envBase = Env.get("OPENROUTER_BASE_URL")
        const baseURL = envBase && !hasManagedProxyPath(envBase) ? envBase : "https://openrouter.ai/api/v1"
        return { autoload: false, options: { apiKey: ownKey, baseURL, headers } }
      }

      // No own key: fall back to the Atlas managed proxy when it's configured.
      // The @openrouter SDK auto-loads OPENROUTER_API_KEY but NOT
      // OPENROUTER_BASE_URL, so forward the proxy URL explicitly and attach the
      // managed token — the live session, or the synced thk_* already in env if
      // the session file is momentarily unreadable.
      const proxyBase = Env.get("OPENROUTER_BASE_URL")
      const session = await OpenScience.getSession().catch(() => null)
      const managedKey = session?.api_key ?? (Auth.isAtlasApiKey(envKey) ? envKey : undefined)
      if (managedKey) {
        const baseURL = isAtlasProxyBaseURL(proxyBase) ? proxyBase : managedOpenRouterBaseURL()
        return { autoload: false, options: { apiKey: managedKey, baseURL, headers }, source: "managed" }
      }

      // Neither an own key nor a managed route — nothing to route with.
      return { autoload: false, options: { headers } }
    },
    meta: async () => {
      // Meta is BYOK-only in the client. Managed Muse Spark now routes through
      // OpenRouter's `meta/muse-spark-1.1` slug, so stale Atlas Meta proxy env
      // from older syncs must not create a managed Meta provider.
      const auth = await Auth.get("meta").catch(() => undefined)
      const authKey = auth?.type === "api" ? auth.key : undefined
      const envKey = Env.get("META_MODEL_API_KEY")
      const ownKey = isByokKey(authKey) ? authKey : isByokKey(envKey) ? envKey : undefined
      if (ownKey) {
        const envBase = Env.get("META_MODEL_BASE_URL")
        const baseURL = envBase && !hasManagedProxyPath(envBase) ? envBase : "https://api.meta.ai/v1"
        return {
          autoload: false,
          options: { apiKey: ownKey, baseURL },
          getModel: async (sdk, modelID) => sdk.responses(modelID),
        }
      }

      return { autoload: false, getModel: async (sdk, modelID) => sdk.responses(modelID) }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://syntheticsciences.ai/",
            "x-title": "synsci",
          },
        },
      }
    },
    "google-vertex": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = Env.get("AICORE_SERVICE_KEY")
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          Env.set("AICORE_SERVICE_KEY", auth.key)
          return auth.key
        }
        return undefined
      })
      const deploymentId = Env.get("AICORE_DEPLOYMENT_ID")
      const resourceGroup = Env.get("AICORE_RESOURCE_GROUP")

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://syntheticsciences.ai/",
            "X-Title": "synsci",
          },
        },
      }
    },
    gitlab: async (input) => {
      const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

      const auth = await Auth.get(input.id)
      const apiKey = await (async () => {
        if (auth?.type === "oauth") return auth.access
        if (auth?.type === "api") return auth.key
        return Env.get("GITLAB_TOKEN")
      })()

      const config = await Config.get()
      const providerConfig = config.provider?.["gitlab"]

      return {
        autoload: !!apiKey,
        options: {
          instanceUrl,
          apiKey,
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...(providerConfig?.options?.featureFlags || {}),
          },
        },
        async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
          return sdk.agenticChat(modelID, {
            featureFlags: {
              duo_agent_platform_agentic_chat: true,
              duo_agent_platform: true,
              ...(providerConfig?.options?.featureFlags || {}),
            },
          })
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth prompt
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      return {
        autoload: true,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.languageModel(modelID)
        },
        options: {
          baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
          headers: {
            // Cloudflare AI Gateway uses cf-aig-authorization for authenticated gateways
            // This enables Unified Billing where Cloudflare handles upstream provider auth
            ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
            "HTTP-Referer": "https://syntheticsciences.ai/",
            "X-Title": "synsci",
          },
          // Custom fetch to handle parameter transformation and auth
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            // Strip Authorization header - AI Gateway uses cf-aig-authorization instead
            headers.delete("Authorization")

            // Transform max_tokens to max_completion_tokens for newer models
            if (init?.body && init.method === "POST") {
              try {
                const body = JSON.parse(init.body as string)
                if (body.max_tokens !== undefined && !body.max_completion_tokens) {
                  body.max_completion_tokens = body.max_tokens
                  delete body.max_tokens
                  init = { ...init, body: JSON.stringify(body) }
                }
              } catch (e) {
                // If body parsing fails, continue with original request
              }
            }

            return fetch(input, { ...init, headers })
          },
        },
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "synsci",
          },
        },
      }
    },
    // Spec §3.2 / Task 14: @ai-sdk/google does not honour *_BASE_URL env vars
    // natively (unlike @ai-sdk/anthropic and @ai-sdk/openai). Inject baseURL
    // from env so Atlas proxy can redirect non-BYOK Gemini calls without
    // requiring any user config. The proxy URL is written by /api/cli/sync.
    google: async () => {
      const baseURL = Env.get("GOOGLE_GENERATIVE_AI_BASE_URL") ?? Env.get("GEMINI_BASE_URL")
      // @ai-sdk/google auto-loads ONLY GOOGLE_GENERATIVE_AI_API_KEY, but the
      // provider is detected from any of its aliases (GOOGLE_API_KEY /
      // GEMINI_API_KEY). Resolve the key from whichever alias is set and pass it
      // explicitly, otherwise a user who exported GOOGLE_API_KEY lists fine but
      // hits "API key is missing" at call time. A managed proxy key (below), when
      // present, overrides it.
      const apiKey = Env.get("GOOGLE_GENERATIVE_AI_API_KEY") ?? Env.get("GOOGLE_API_KEY") ?? Env.get("GEMINI_API_KEY")
      return {
        autoload: false,
        options: {
          ...(apiKey ? { apiKey } : {}),
          ...(baseURL ? { baseURL, ...(await managedProxyKey("google", baseURL)) } : {}),
        },
      }
    },
  }

  const Mode = z.object({
    model: z.string().optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
      })
      .optional(),
    provider: z
      .object({
        body: z.record(z.string(), z.any()).optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
  })

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string().optional(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      reasoningOptions: z.array(z.record(z.string(), z.any())).optional(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
      modes: z.record(z.string(), Mode).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api", "managed"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  export function redact(info: Info): Info {
    return {
      ...info,
      key: undefined,
      options: {},
      models: mapValues(info.models, (model) => ({
        ...model,
        api: {
          ...model.api,
          url: undefined,
        },
        options: {},
        headers: {},
        variants: model.variants ? mapValues(model.variants, () => ({})) : undefined,
        modes: model.modes
          ? mapValues(model.modes, (mode) => ({
              model: mode.model,
              cost: mode.cost,
            }))
          : undefined,
      })),
    }
  }

  /** Synthesize a minimal Model entry for an OpenRouter model that
   *  isn't in the models.dev catalog. OR is OpenAI-compat for every
   *  upstream it aggregates, so any id is dispatchable through the
   *  same /chat/completions shape. Cost stays at 0 client-side —
   *  managed billing uses `usage.cost` from the upstream response
   *  (the adapter's compute_cost_cents prefers it), so accuracy is
   *  preserved without a per-model price entry.
   *
   *  Used after the whitelist filter: when sync ships an OR model id
   *  the local registry doesn't know about, this synthesizer fills
   *  the gap instead of having the picker reject the model. */
  function _syntheticOpenRouterModel(modelID: string): Model {
    const m: Model = {
      id: modelID,
      providerID: "openrouter",
      name: modelID,
      api: {
        id: modelID,
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      status: "active",
      headers: {},
      options: {},
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      // Conservative defaults — OR aggregates many models with very
      // different real limits. Anything that needs more context will
      // hit the upstream's actual cap and the API surfaces the error.
      limit: { context: 128_000, output: 8_192 },
      capabilities: {
        temperature: true,
        reasoning: true,
        // #192: this is a placeholder for a whitelisted model NOT in the
        // local catalog — guessing `false` here silently drops images/PDFs
        // for what may well be a vision-capable model. Guess permissive
        // instead: a genuinely-unsupported attachment surfaces a real
        // provider error rather than a fabricated "unsupported" one.
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
    }
    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)
    return m
  }

  function directModes(
    providerID: string,
    modelID: string,
    experimental: ModelsDev.Model["experimental"],
  ): Model["modes"] | undefined {
    const modes = experimental && typeof experimental === "object" ? experimental.modes : undefined
    const result = Object.fromEntries(
      Object.entries(modes ?? {})
        .filter(([key, mode]) => {
          if (!mode) return false
          if (key === "pro" && /(^|\/)gpt-/.test(modelID)) return false
          if (providerID !== "anthropic" || key !== "fast") return true
          const id = modelID.toLowerCase().replaceAll(".", "-")
          return id.startsWith("claude-opus-5") || id.startsWith("claude-opus-4-8")
        })
        .map(([key, mode]) => [
          key,
          {
            model: mode?.model,
            cost: mode?.cost
              ? {
                  input: mode.cost.input,
                  output: mode.cost.output,
                  cache: {
                    read: mode.cost.cache_read ?? 0,
                    write: mode.cost.cache_write ?? 0,
                  },
                }
              : undefined,
            provider: mode?.provider
              ? {
                  body: mode.provider.body ?? {},
                  headers: mode.provider.headers ?? {},
                }
              : undefined,
          },
        ]),
    )
    if (Object.keys(result).length === 0) return undefined
    return result
  }

  function modelModes(provider: ModelsDev.Provider, model: ModelsDev.Model): Model["modes"] | undefined {
    const direct = directModes(provider.id, model.id, model.experimental) ?? {}
    const sibling =
      provider.id === "openrouter" && !/-fast$/.test(model.id)
        ? Object.fromEntries(
            ["fast"]
              .map((key) => [key, provider.models[`${model.id}-${key}`]] as const)
              .filter((entry) => !!entry[1])
              .map(([key, route]) => [
                key,
                {
                  model: route!.id,
                  cost: route!.cost
                    ? {
                        input: route!.cost.input,
                        output: route!.cost.output,
                        cache: {
                          read: route!.cost.cache_read ?? 0,
                          write: route!.cost.cache_write ?? 0,
                        },
                      }
                    : undefined,
                },
              ]),
          )
        : {}
    const result = { ...direct, ...sibling }
    if (Object.keys(result).length === 0) return undefined
    return result
  }

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    // models.dev can lag a just-launched model's authoritative provider
    // contract. Normalize Muse at the ingestion seam so cached, bundled, and
    // freshly fetched catalogs all drive the same token budgeting.
    const isMetaMuse11 = provider.id === "meta" && /muse-spark-1[.-]1\b/.test(model.id.toLowerCase())
    // xAI and OpenRouter publish different cached-input rates for Grok 4.5.
    // Keep the route-specific contract even when models.dev flattens both
    // entries to the same value.
    const isGrok45 = /grok-4[.-]5\b/.test(model.id.toLowerCase())
    const cacheRead =
      isGrok45 && provider.id === "xai"
        ? 0.3
        : isGrok45 && provider.id === "openrouter"
          ? 0.5
          : (model.cost?.cache_read ?? 0)
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      modes: modelModes(provider, model),
      reasoningOptions: model.reasoning_options,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: cacheRead,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: isMetaMuse11 ? 1_048_576 : model.limit.context,
        input: model.limit.input,
        output: isMetaMuse11 ? 131_072 : model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: isMetaMuse11 ? "2026-07-09" : model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: Object.fromEntries(
        Object.entries(provider.models)
          .filter(([modelID]) => !isRemovedModel(modelID))
          .map(([modelID, model]) => [modelID, fromModelsDevModel(provider, model)]),
      ),
    }
  }

  // Manual memoization for provider state. Stores the in-flight/resolved
  // Promise so concurrent callers share the same build.
  // `invalidate()` clears the cache so the next `state()` call rebuilds
  // from the current process.env (picks up env vars written by a
  // background BYOK sync). We bypass Instance.state here so we can
  // control the lifecycle independently.
  let _stateCache: Promise<{
    models: Map<string, LanguageModelV2>
    providers: { [providerID: string]: Info }
    sdk: Map<number, SDK>
    modelLoaders: { [providerID: string]: CustomModelLoader }
  }> | null = null
  let _stateCacheDirectory: string | undefined
  let _stateCacheTrust: boolean | undefined

  async function _loadState() {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null
    // Managed wallet ⇒ curated routes only. OpenRouter handles the aggregated
    // catalog. Every other first-party managed proxy is dropped. Gated on the
    // explicit toggle, so
    // BYOK and legacy auto-detect sessions see every provider as before. This is
    // the single seam that makes defaultModel()/getSmallModel() managed-safe.
    const managedCuratedProvidersOnly = managedRoutesCuratedProvidersOnly(config)
    // Config-registered providers pointing at the local machine (Ollama, LM
    // Studio, any OpenAI-compatible localhost endpoint). They're free and run on
    // the user's own hardware, so they stay available even in managed-wallet
    // mode — the wallet still only routes real inference through curated
    // managed proxies.
    const localProviderIds = new Set(
      Object.entries(config.provider ?? {})
        .filter(([, p]) => isLocalBaseURL(p?.options?.baseURL ?? p?.api))
        .map(([id]) => id),
    )

    function isProviderAllowed(providerID: string): boolean {
      // Codex OAuth (openai-codex) is the user's own ChatGPT subscription: it
      // routes straight to chatgpt.com and never debits the managed wallet, so a
      // completed sign-in must surface regardless of managed-mode routing or the
      // synced managed catalog whitelist. Treat it as BYOK-class (like a local
      // provider) — only an explicit `disabled` entry hides it. Without this,
      // managed users finish the ChatGPT login (the credential persists) but the
      // provider is filtered out and the UI never flips to Connected.
      if (providerID === "openai-codex") return !disabled.has(providerID)
      if (managedCuratedProvidersOnly && !managedProviderAllowed(providerID) && !localProviderIds.has(providerID))
        return false
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    // Add GitHub Copilot Enterprise provider that inherits from GitHub Copilot
    if (database["github-copilot"]) {
      const githubCopilot = database["github-copilot"]
      database["github-copilot-enterprise"] = {
        ...githubCopilot,
        id: "github-copilot-enterprise",
        name: "GitHub Copilot Enterprise",
        models: mapValues(githubCopilot.models, (model) => ({
          ...model,
          providerID: "github-copilot-enterprise",
        })),
      }
    }

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        if (isRemovedModel(modelID)) continue
        const existingModel = parsed.models[model.id ?? modelID]
        const baseURL = typeof provider.options?.baseURL === "string" ? provider.options.baseURL : undefined
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: baseURL ?? provider.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            // Fall back to the catalog model's interleaved shape like every other
            // capability above — otherwise overriding any single field (e.g. cost)
            // on an interleaved-reasoning model dropped its {field} object, so
            // normalizeMessages stopped relocating prior-turn reasoning.
            interleaved: model.interleaved ?? existingModel?.capabilities.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          reasoningOptions: existingModel?.reasoningOptions,
          variants: {},
          modes: directModes(providerID, modelID, model.experimental) ?? existingModel?.modes,
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // Synthesize a virtual ``openai-codex`` provider for users who have
    // attached Codex OAuth (Auth.set under id "openai-codex"). The
    // models are a Codex-routable subset copied from openai's snapshot;
    // routing is handled by CodexAuthPlugin. This keeps the real
    // ``openai`` provider (BYOK api key) and the Codex OAuth provider
    // coexisting as separate registry entries. Matches backend's
    // ``openai-codex`` provider slug.
    if (database["openai"] && (await Auth.get("openai-codex"))) {
      // Include both dot- and dash-normalized variants — models.dev's
      // snapshot normalizes dots to dashes (e.g. `gpt-5-5`) while the
      // OpenAI API expects dots (`gpt-5.5`). We pick up whichever the
      // snapshot ships and route it through the codex provider.
      const baseOpenai = database["openai"]
      const codexModels: Record<string, (typeof baseOpenai.models)[string]> = {}
      for (const [id, model] of Object.entries(baseOpenai.models)) {
        if (isCodexOAuthModel(id)) {
          const codexModel = {
            ...model,
            providerID: "openai-codex",
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            // Codex OAuth advertises a separate 272k window even when the
            // copied public-API entry has a million-token context.
            limit: { ...model.limit, context: 272_000 },
            // Codex advertises its own fast tier independently of the public
            // API catalog, so synthesize only the modes in the OAuth contract.
            modes: codexOAuthModes(model.id),
          }
          // The public API and ChatGPT/Codex expose different GPT-5.6 effort
          // ladders. Recompute after changing providerID instead of copying the
          // API model's pre-built variants (`none` is not a Codex picker option).
          codexModel.variants = ProviderTransform.variants(codexModel)
          codexModels[id] = codexModel
        }
      }
      database["openai-codex"] = {
        ...baseOpenai,
        id: "openai-codex",
        name: "OpenAI (Codex subscription)",
        env: [],
        options: {},
        models: codexModels,
      }
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const providerID = plugin.auth.provider
      if (disabled.has(providerID)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasAuth = false
      const auth = await Auth.get(providerID)
      if (auth) hasAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (providerID === "github-copilot" && !hasAuth) {
        const enterpriseAuth = await Auth.get("github-copilot-enterprise")
        if (enterpriseAuth) hasAuth = true
      }

      if (!hasAuth) continue
      if (!plugin.auth.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        const options = await plugin.auth.loader(() => Auth.get(providerID) as any, database[plugin.auth.provider])
        const opts = options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }

      // If this is github-copilot plugin, also register for github-copilot-enterprise if auth exists
      if (providerID === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (!disabled.has(enterpriseProviderID)) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => Auth.get(enterpriseProviderID) as any,
              database[enterpriseProviderID],
            )
            const opts = enterpriseOptions ?? {}
            const patch: Partial<Info> = providers[enterpriseProviderID]
              ? { options: opts }
              : { source: "custom", options: opts }
            mergeProvider(enterpriseProviderID, patch)
          }
        }
      }
    }

    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerID)) continue
      const data = database[providerID]
      if (!data) {
        log.error("Provider does not exist in model list " + providerID)
        continue
      }
      const result = await fn(data)
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        const opts = result.options ?? {}
        // A loader-reported source (e.g. openrouter's managed-proxy branch)
        // always wins, even when an earlier stage (env/api) already
        // registered the provider under a different source — that earlier
        // credential is exactly what the managed route is overriding.
        // Absent an explicit source, keep the existing rule: "custom" only
        // when this is the provider's first registration.
        const patch: Partial<Info> = providers[providerID]
          ? { options: opts, ...(result.source ? { source: result.source } : {}) }
          : { source: result.source ?? "custom", options: opts }
        mergeProvider(providerID, patch)
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      // A provider already registered by an earlier stage under a genuinely
      // credential-derived source (env/api/managed) must not be relabeled —
      // a `config.provider` entry that only supplies a `whitelist`, `name`,
      // etc. is not where the credential came from. "custom" is excluded from
      // this protection: it's loader-assigned (not credential-derived) and an
      // autoloaded provider (AWS-profile Bedrock, google-vertex, synsci,
      // cloudflare-ai-gateway, gitlab, sap-ai-core, ...) that also appears in
      // config.provider for its whitelist has always been, and must stay,
      // "config" here.
      const credentialSource = providers[providerID]?.source
      const claimed = credentialSource === "env" || credentialSource === "api" || credentialSource === "managed"
      const partial: Partial<Info> = claimed ? {} : { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      // Under an EXPLICIT byok toggle, drop any provider whose effective
      // credential is a managed Atlas (thk_) key. The managed sync writes
      // OPENROUTER_BASE_URL + a thk_ OPENROUTER_API_KEY into the environment and
      // those survive a managed→byok switch — so without this, byok silently
      // keeps routing through the wallet proxy (and billing managed spend) on a
      // credential the user never brought. BYOK must use the user's OWN keys
      // only; auto-detect (billing unset) is left alone so a thk_ key can still
      // resolve to managed there.
      if (config.billing?.llm === "byok" && Auth.isAtlasApiKey(effectiveKey(provider))) {
        delete providers[providerID]
        continue
      }

      // The managed mirror of the guard above. Under an EXPLICIT managed
      // toggle the OpenRouter loader declines to route on a stored own key,
      // but declining is not enough on its own: "load apikeys" already stamped
      // provider.key from auth.json, and getSDK picks that up with baseURL
      // falling back to public OpenRouter. A user whose Atlas session lapsed
      // would keep chatting on their OWN key while the toggle still reads
      // "Managed" and the wallet is never touched. Drop the provider instead —
      // seeing no OpenRouter models is honest, silently spending a BYOK key is
      // not. Exempt the two provider classes this file already treats as
      // BYOK-by-design, since neither can debit the wallet and both are
      // deliberately kept in managed mode: the user's own ChatGPT subscription
      // (see isProviderAllowed) and anything served from their own machine
      // (see isLocalBaseURL). Auto-detect (billing unset / null) and byok never
      // reach this branch.
      const exempt =
        providerID === "openai-codex" ||
        localProviderIds.has(providerID) ||
        isLocalBaseURL(provider.options?.["baseURL"])
      if (managedCuratedProvidersOnly && !exempt && isByokKey(effectiveKey(provider))) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      // Synced whitelists curate MANAGED catalogs only. When a dual-route
      // provider resolves to the user's OWN key, it is their account: show the
      // full local models.dev catalog instead of the managed subset.
      const bypassManagedWhitelist =
        (providerID === "openrouter" || providerID === "meta") && isByokKey(provider.options?.["apiKey"])

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (isRemovedModel(modelID)) delete provider.models[modelID]
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.OPENSCIENCE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (!bypassManagedWhitelist && configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      // OpenRouter aggregates models from many upstreams; a whitelisted managed
      // model id occasionally missing from the models.dev registry gets
      // synthesized so the picker still accepts it. Safe because OR is
      // OpenAI-compat for every upstream + managed billing uses usage.cost from
      // the response, not a local price table. Skipped on a BYOK key — that path
      // shows the full local catalog and isn't bound to the managed whitelist.
      if (!bypassManagedWhitelist && providerID === "openrouter" && configProvider?.whitelist) {
        for (const wlid of configProvider.whitelist) {
          if (isRemovedModel(wlid)) continue
          if (!(wlid in provider.models)) {
            provider.models[wlid] = _syntheticOpenRouterModel(wlid)
          }
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models: languages,
      providers,
      sdk,
      modelLoaders,
    }
  }

  // Returns the memoised state, creating it on first call or after invalidate().
  async function state() {
    const directory = Instance.directory
    const trusted = await ProjectTrust.allowed(Instance.project)
    if (_stateCacheDirectory !== directory || _stateCacheTrust !== trusted) {
      _stateCache = null
      _stateCacheDirectory = directory
      _stateCacheTrust = trusted
    }
    if (_stateCache === null) {
      _stateCache = _loadState()
    }
    return _stateCache
  }

  /**
   * Drop the cached provider state so the next `state()` call rebuilds
   * from the current process.env (which a background BYOK sync may have
   * just updated). Safe to call concurrently — the next caller races to
   * build a fresh Promise and wins.
   */
  export function invalidate(): void {
    _stateCache = null
    _stateCacheDirectory = undefined
    _stateCacheTrust = undefined
  }

  function resolveOpenRouterAlias(s: Awaited<ReturnType<typeof state>>, providerID: string, modelID: string) {
    const openrouter = s.providers["openrouter"]
    if (!openrouter) return undefined
    for (const alias of openrouterAliasCandidates(providerID, modelID)) {
      const model = openrouter.models[alias]
      if (model) return model
    }
  }

  function resolveAvailableModel(s: Awaited<ReturnType<typeof state>>, providerID: string, modelID: string) {
    const exact = s.providers[providerID]?.models[modelID]
    return exact ?? resolveOpenRouterAlias(s, providerID, modelID)
  }

  export async function list() {
    return state().then((state) => state.providers)
  }

  // === tokenCommand: refreshing shell-command auth (#146) ===
  // Some providers sit behind a rotating/SSO-minted bearer token that a local
  // command prints on demand. `options.tokenCommand` runs that command and injects
  // its stdout as `Authorization: Bearer <token>`, re-minting shortly before the
  // token's JWT exp. Module-level so the cache + single-flight are shared across the
  // (memoized) SDK instances rather than re-run per request.
  const tokenCache = new Map<string, { token: string; expires: number }>()
  const tokenInflight = new Map<string, Promise<string>>()

  async function projectToken(model: Model, command: string) {
    const config = await Config.get()
    const declared = config.provider?.[model.providerID]?.options?.tokenCommand
    if (declared !== command) return false
    const executable = await Config.getExecution()
    return executable.provider?.[model.providerID]?.options?.tokenCommand !== command
  }

  async function projectModule(model: Model) {
    const configured = (config: Config.Info) => {
      const provider = config.provider?.[model.providerID]
      return provider?.models?.[model.id]?.provider?.npm ?? provider?.npm
    }
    const declared = configured(await Config.get())
    if (declared !== model.api.npm) return false
    return configured(await Config.getExecution()) !== model.api.npm
  }

  async function mintToken(command: string): Promise<string> {
    const cached = tokenCache.get(command)
    // Re-mint a minute early so an in-flight request never ships an expired token.
    if (cached && cached.expires > Date.now() + 60_000) return cached.token
    const pending = tokenInflight.get(command)
    if (pending) return pending
    const run = (async () => {
      const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const token = out.trim()
      if (code !== 0) throw new Error(`tokenCommand exited ${code}: ${err.trim() || "no stderr"}`)
      if (!token) throw new Error("tokenCommand produced no output")
      // Decode a JWT exp (seconds) so we can re-mint just before it lapses; a
      // non-JWT token has no exp, so expire it immediately (re-mint every request).
      const claims = token.split(".")
      let exp = 0
      if (claims.length === 3) {
        try {
          exp = JSON.parse(Buffer.from(claims[1], "base64url").toString()).exp ?? 0
        } catch {
          /* not a JWT — leave exp 0 */
        }
      }
      tokenCache.set(command, { token, expires: exp ? exp * 1000 : 0 })
      return token
    })().finally(() => tokenInflight.delete(command))
    tokenInflight.set(command, run)
    return run
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"] && model.api.url) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      // tokenCommand supplies the credential per-request via the fetch hook below;
      // give the SDK a non-empty placeholder so @ai-sdk/openai's loadApiKey doesn't
      // throw at construction (the real Bearer header is overwritten on each call).
      if (options["tokenCommand"] && options["apiKey"] === undefined) options["apiKey"] = "token-command"
      pinByokToPublicEndpoint(provider, options, model.api.url)
      requireAtlasProxyForManagedKey(provider, options)
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Bun.hash.xxHash32(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]
      const tokenCommand = options["tokenCommand"] as string | undefined

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}

        if (options["timeout"] !== undefined && options["timeout"] !== null) {
          const signals: AbortSignal[] = []
          if (opts.signal) signals.push(opts.signal)
          if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

          opts.signal = combined
        }

        // Strip openai itemId metadata following what codex does
        // Codex uses #[serde(skip_serializing)] on id fields for all item types:
        // Message, Reasoning, FunctionCall, LocalShellCall, CustomToolCall, WebSearchCall
        // IDs are only re-attached for Azure with store=true
        if (model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST") {
          const body = JSON.parse(opts.body as string)
          const isAzure = model.providerID.includes("azure")
          const keepIds = isAzure && body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) {
                delete item.id
              }
            }
            opts.body = JSON.stringify(body)
          }
        }

        // Mint (or reuse) the shell-command token and overwrite Authorization.
        // Headers.set is case-insensitive, so it replaces the placeholder key the
        // SDK attached at construction.
        if (tokenCommand) {
          if (await projectToken(model, tokenCommand)) {
            await ProjectTrust.require(Instance.project, "provider_token_command")
          }
          const token = await mintToken(tokenCommand)
          const headers = new Headers(opts.headers as HeadersInit | undefined)
          headers.set("authorization", `Bearer ${token}`)
          opts.headers = headers
        }

        return fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      if (await projectModule(model)) {
        await ProjectTrust.require(Instance.project, "provider_module")
      }
      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const resolved = resolveAvailableModel(s, providerID, modelID)
    if (resolved) return resolved

    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const availableModels = Object.keys(provider.models)
    const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
    const suggestions = matches.map((m) => m.target)
    throw new ModelNotFoundError({ providerID, modelID, suggestions })
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  /** Whether a managed (Atlas) session is active. Only then should the hosted
   *  `openscience` provider participate in DEFAULT model selection — a fresh
   *  BYOK/OAuth clone must default to the user's own provider. */
  async function hasManagedSession(): Promise<boolean> {
    try {
      const session = await OpenScience.getSession()
      return !!session?.api_key
    } catch {
      return false
    }
  }

  export async function getSmallModel(providerID: string) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("synsci")) {
        priority = ["gpt-5-nano"]
      }
      if (providerID.startsWith("github-copilot")) {
        // prioritize free models for github copilot
        priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
      }
      for (const item of priority) {
        for (const model of Object.keys(provider.models)) {
          if (model.includes(item)) return getModel(providerID, model)
        }
      }
    }

    // Only fall back to the hosted openscience demo small-model when a managed
    // session is active — a BYOK/OAuth clone shouldn't silently route summaries
    // through the hosted endpoint.
    if (await hasManagedSession()) {
      const openscienceProvider = await state().then((state) => state.providers["synsci"])
      if (openscienceProvider && openscienceProvider.models["gpt-5-nano"]) {
        return getModel("synsci", "gpt-5-nano")
      }
    }

    return undefined
  }

  export const NO_PROVIDER_HINT =
    "No model providers are available. Add your own API key (`openscience keys add`) or connect a managed account (`openscience login`), then choose a model."

  const priority = ["claude-sonnet-4", "claude-opus-4", "gpt-5", "gemini-3-pro"]
  export function sort(models: Model[]) {
    return sortBy(
      models,
      // Higher score = sorted first. Matched models get (priority.length - index), unmatched get -1.
      [
        (model) => {
          const idx = priority.findIndex((filter) => model.id.includes(filter))
          return idx >= 0 ? priority.length - idx : -1
        },
        "desc",
      ],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    const available = await list()
    if (cfg.model) {
      // Only honor the configured model when its provider is actually available
      // (e.g. a saved `anthropic/...` model with no API key must not be returned)
      // — otherwise fall through to the priority-based selection below.
      const parsed = parseModel(cfg.model)
      const resolved = resolveAvailableModel(await state(), parsed.providerID, parsed.modelID)
      if (resolved) return { providerID: resolved.providerID, modelID: resolved.id }
      log.warn("configured model is not available, falling back to default selection", parsed)
    }

    const managed = await hasManagedSession()
    const providers = Object.values(available)
    const configured = (p: Info) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)
    // Drop the hosted `openscience` provider from DEFAULT priority unless a managed
    // session is active, then pick the first provider that actually has models.
    // Fall back to the raw configured list so a openscience-only, unmanaged clone
    // still resolves a default rather than throwing.
    const candidates = providers.filter((p) => configured(p) && (managed || !p.id.startsWith("synsci")))
    const provider =
      candidates.find((p) => Object.keys(p.models).length > 0) ?? candidates[0] ?? providers.find(configured)
    if (!provider) throw new Error(NO_PROVIDER_HINT)
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error(NO_PROVIDER_HINT)
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
