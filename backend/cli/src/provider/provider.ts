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
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { OpenScience } from "../openscience"

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

  function isAtlasApiKey(key: unknown): key is string {
    return typeof key === "string" && key.startsWith("thk_")
  }

  function isAtlasProxyBaseURL(baseURL: unknown): baseURL is string {
    return typeof baseURL === "string" && baseURL.includes("/api/llm/proxy/")
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
    // Managed wallet routes through OpenRouter ONLY: never attach the wallet's
    // thk_ token to a first-party proxy (anthropic / openai / google). Those
    // providers are also dropped from availability (see isProviderAllowed), so
    // this is belt-and-suspenders — a managed token can only ever reach the
    // sanctioned OpenRouter (or hosted synsci) route.
    if (!managedProviderAllowed(providerID)) return {}
    const session = await OpenScience.getSession().catch(() => null)
    return session?.api_key ? { apiKey: session.api_key } : {}
  }

  function requireAtlasProxyForManagedKey(provider: Info, options: Record<string, any>) {
    // Key off the EFFECTIVE credential, not raw env. A managed thk_ value can
    // sit unused in env while an auth.json key wins resolution; demanding
    // proxy routing for it hard-failed every call with advice (`connect
    // sync`) that re-delivers the same env and can never fix it.
    const effective =
      (typeof options["apiKey"] === "string" ? (options["apiKey"] as string) : undefined) ??
      provider.key ??
      provider.env.map((key) => Env.get(key)).find((value): value is string => !!value)
    if (!isAtlasApiKey(effective)) return
    if (isAtlasProxyBaseURL(options["baseURL"])) return
    throw new Error(
      `${provider.id} is using a managed Atlas key without an Atlas proxy URL. ` +
        "Run `openscience sync` and try again.",
    )
  }

  /** A user-owned (BYOK) key: a real, non-managed credential. Excludes the
   *  "public" sentinel used for the zero-cost openscience demo models. */
  function isByokKey(key: unknown): key is string {
    return typeof key === "string" && key.length > 0 && key !== "public" && !isAtlasApiKey(key)
  }

  /** Managed wallet ⇒ OpenRouter-only routing.
   *
   *  When the LLM spend toggle is explicitly "managed", every wallet inference
   *  call flows through OpenRouter — the one gateway whose stream exposes a
   *  single, unified reasoning format (`reasoning` / `reasoning_details`). The
   *  first-party managed proxies (anthropic / openai / google), each with a
   *  different reasoning shape, are taken out of the managed path entirely; the
   *  hosted zero-cost `synsci` demo provider is kept. BYOK and the legacy
   *  auto-detect path (`billing.llm` unset / null / "byok") are UNTOUCHED —
   *  this only fires on an explicit managed-wallet opt-in. Pure + sync. */
  export function managedRoutesOpenRouterOnly(config: Config.Info): boolean {
    return config.billing?.llm === "managed"
  }

  /** Providers a managed (OpenRouter-only) wallet session may load: OpenRouter
   *  for all real inference, plus the hosted `synsci` demo. Pure + sync. */
  export function managedProviderAllowed(providerID: string): boolean {
    return providerID === "openrouter" || providerID.startsWith("synsci")
  }

  /** True when a base URL points at the local machine (localhost / loopback).
   *  A provider with a local baseURL runs on the user's own hardware, is free,
   *  and is BYOK-class — so it's kept available even in managed-wallet mode
   *  (where the wallet itself still routes only through OpenRouter). Pure. */
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
  function pinByokToPublicEndpoint(provider: Info, options: Record<string, any>, publicURL: string) {
    const effectiveKey =
      (typeof options["apiKey"] === "string" ? (options["apiKey"] as string) : undefined) ??
      provider.key ??
      provider.env.map((key) => Env.get(key)).find((value): value is string => !!value)
    // Managed (thk_*) keys must keep their Atlas proxy routing.
    if (isAtlasApiKey(effectiveKey)) return
    if (!isByokKey(effectiveKey)) return
    if (isAtlasProxyBaseURL(options["baseURL"])) {
      log.warn("refusing to route BYOK key through Atlas proxy — pinning to public endpoint", {
        provider: provider.id,
      })
      options["baseURL"] = publicURL
    }
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
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
      // @openrouter/ai-sdk-provider auto-loads OPENROUTER_API_KEY from
      // env but NOT OPENROUTER_BASE_URL (unlike @ai-sdk/openai +
      // @ai-sdk/anthropic which both auto-load their *_BASE_URL).
      // Forward OPENROUTER_BASE_URL explicitly so the SDK targets the
      // Atlas managed proxy when sync sets it. Without this, the SDK
      // falls back to https://openrouter.ai/api/v1 and tries to use
      // our thk_* token as a direct OR key (OR rejects with
      // "Missing Authentication header").
      const baseURL = Env.get("OPENROUTER_BASE_URL")
      return {
        autoload: false,
        options: {
          ...(baseURL ? { baseURL, ...(await managedProxyKey("openrouter", baseURL)) } : {}),
          headers: {
            "HTTP-Referer": "https://syntheticsciences.ai/",
            "X-Title": "synsci",
          },
        },
      }
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
      return {
        autoload: false,
        options: baseURL ? { baseURL, ...(await managedProxyKey("google", baseURL)) } : {},
      }
    },
  }

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
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
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

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
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
    }
    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)
    return m
  }

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
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
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
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
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
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
      release_date: model.release_date,
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
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
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

  async function _loadState() {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null
    // Managed wallet ⇒ OpenRouter-only. Drop every other provider (the
    // first-party managed proxies included) from a managed session so wallet
    // inference can only flow through OpenRouter's unified reasoning stream,
    // plus the hosted zero-cost demo. Gated on the explicit toggle, so BYOK and
    // legacy auto-detect sessions see every provider exactly as before. This is
    // the single seam that makes defaultModel()/getSmallModel() managed-safe:
    // both read the filtered state, so they can only resolve openrouter/synsci.
    const managedOpenRouterOnly = managedRoutesOpenRouterOnly(config)
    // Config-registered providers pointing at the local machine (Ollama, LM
    // Studio, any OpenAI-compatible localhost endpoint). They're free and run on
    // the user's own hardware, so they stay available even in managed-wallet
    // mode — the wallet still only routes real inference through OpenRouter.
    const localProviderIds = new Set(
      Object.entries(config.provider ?? {})
        .filter(([, p]) => isLocalBaseURL(p?.options?.baseURL ?? p?.api))
        .map(([id]) => id),
    )

    function isProviderAllowed(providerID: string): boolean {
      if (managedOpenRouterOnly && !managedProviderAllowed(providerID) && !localProviderIds.has(providerID))
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
        const existingModel = parsed.models[model.id ?? modelID]
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
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
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
          variants: {},
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
      const codexModelIds = new Set<string>([
        "gpt-5.5",
        "gpt-5-5",
        "gpt-5.4",
        "gpt-5-4",
        "gpt-5.4-mini",
        "gpt-5-4-mini",
        "gpt-5.3-codex",
        "gpt-5-3-codex",
        "gpt-5.2",
        "gpt-5-2",
      ])
      const baseOpenai = database["openai"]
      const codexModels: Record<string, (typeof baseOpenai.models)[string]> = {}
      for (const [id, model] of Object.entries(baseOpenai.models)) {
        if (codexModelIds.has(id)) {
          codexModels[id] = {
            ...model,
            providerID: "openai-codex",
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          }
        }
      }
      database["openai-codex"] = {
        ...baseOpenai,
        id: "openai-codex",
        name: "OpenAI Codex (ChatGPT subscription)",
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
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
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

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.OPENSCIENCE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
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

      // OpenRouter aggregates models from many upstreams; the
      // models.dev catalog only registers a small subset (deepseek-r1
      // + 3 grok variants as of 2026-05). Any whitelisted OR model
      // missing from the registry gets synthesized so the picker
      // accepts it. Safe because OR is OpenAI-compat for every
      // upstream + managed billing uses usage.cost from the response,
      // not a local price table.
      if (providerID === "openrouter" && configProvider?.whitelist) {
        for (const wlid of configProvider.whitelist) {
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
  function state() {
    const directory = Instance.directory
    if (_stateCacheDirectory !== directory) {
      _stateCache = null
      _stateCacheDirectory = directory
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
  }

  export async function list() {
    return state().then((state) => state.providers)
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

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
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
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
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
      if (available[parsed.providerID]?.models[parsed.modelID]) return parsed
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
