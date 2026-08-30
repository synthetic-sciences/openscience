import { Auth } from "@/auth"
import { Config } from "@/config/config"
import z from "zod"

export namespace Inference {
  export const Source = z.enum(["managed", "byok", "chatgpt", "local", "oauth", "unknown"])
  export type Source = z.infer<typeof Source>

  export const Info = z.object({
    source: Source,
    effort: z.string(),
  })
  export type Info = z.infer<typeof Info>

  function local(value: unknown) {
    if (typeof value !== "string" || !value) return false
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "")
      return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1"
    } catch {
      return false
    }
  }

  export function classify(input: {
    providerID: string
    providerSource?: "env" | "config" | "custom" | "api" | "managed"
    baseURL?: string
    auth?: Auth.Info["type"]
  }): Source {
    if (input.providerID === "openai-codex") return "chatgpt"
    if (local(input.baseURL)) return "local"
    if (input.providerID === "openrouter" && input.providerSource === "managed") return "managed"
    if (input.auth === "oauth") return "oauth"
    if (input.auth === "api" || input.auth === "wellknown") return "byok"
    // The resolved provider source is the route authority. A billing preference
    // alone cannot turn a surviving user-owned OpenRouter key into managed spend.
    if (input.providerSource === "env" || input.providerSource === "config" || input.providerSource === "api") {
      return "byok"
    }
    return "unknown"
  }

  export async function resolve(providerID: string, effort?: string): Promise<Info> {
    const { Provider } = await import("./provider")
    const [config, auth, providers] = await Promise.all([
      Config.get(),
      Auth.get(providerID).catch(() => undefined),
      Provider.list(),
    ])
    const provider = providers[providerID]
    const configured = config.provider?.[providerID]
    const baseURL =
      typeof configured?.options?.baseURL === "string"
        ? configured.options.baseURL
        : typeof configured?.api === "string"
          ? configured.api
          : typeof provider?.options?.baseURL === "string"
            ? provider.options.baseURL
            : provider?.models
              ? Object.values(provider.models)[0]?.api.url
              : undefined
    return {
      source: classify({
        providerID,
        providerSource: provider?.source,
        baseURL,
        auth: auth?.type,
      }),
      effort: effort ?? "default",
    }
  }
}
