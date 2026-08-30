import { managedOpenRouterBaseURL } from "../openscience/synced-env-policy"

/** Fixed native SDKs and first-party endpoints, never remote executable config. */
export function managedModelRoute(model: string, upstream = "openrouter") {
  const base = managedOpenRouterBaseURL().replace(/\/openrouter\/v1$/, "")
  if (upstream === "anthropic" && model.startsWith("anthropic/")) return {
    npm: "@ai-sdk/anthropic", id: model.slice(10).replace("haiku-4.5", "haiku-4-5"), url: `${base}/anthropic/v1`,
  }
  if (upstream === "gemini" && model.startsWith("google/")) return {
    npm: "@ai-sdk/google", id: model.slice(7), url: `${base}/gemini/v1beta`,
  }
  if (upstream === "xai" && model.startsWith("x-ai/")) return {
    npm: "@ai-sdk/xai", id: model.slice(5), url: `${base}/xai/v1`,
  }
  if (upstream === "meta" && model.startsWith("meta/")) return {
    npm: "@ai-sdk/openai-compatible", id: model.slice(5), url: `${base}/meta/v1`,
  }
  return { npm: "@openrouter/ai-sdk-provider", id: model, url: `${base}/openrouter/v1` }
}
