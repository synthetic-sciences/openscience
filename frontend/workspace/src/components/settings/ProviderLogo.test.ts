import { describe, expect, test } from "bun:test"
import { MODEL_PROVIDERS } from "./model-providers"
import { providerLogoSource } from "./ProviderLogo"

const CREDENTIALS = [
  "aws",
  "gcp",
  "azure",
  "nvidia",
  "modal",
  "github",
  "literature",
  "openalex",
  "huggingface",
  "tinker",
  "wandb",
  "pinecone",
  "langsmith",
] as const

describe("provider logos", () => {
  test("covers every model provider", () => {
    for (const provider of MODEL_PROVIDERS) expect(providerLogoSource(provider.id).kind).not.toBe("fallback")
  })

  test("covers every built-in compute and integration credential", () => {
    for (const id of CREDENTIALS) expect(providerLogoSource(id).kind).not.toBe("fallback")
  })

  test("uses a monogram only for user-defined services", () => {
    expect(providerLogoSource("custom:lab-service").kind).toBe("fallback")
  })
})
