import { describe, expect, test } from "bun:test"
import { MODEL_PROVIDERS } from "./model-providers"
import { providerLogoSource } from "./ProviderLogo"

const CREDENTIALS = [
  "aws",
  "gcp",
  "azure",
  "nvidia",
  "modal",
  "tensorpool",
  "lambda",
  "prime_intellect",
  "vast",
  "runpod",
  "github",
  "literature",
  "openalex",
  "huggingface",
  "tinker",
  "wandb",
  "pinecone",
  "langsmith",
  "givemeanode",
  "benchling",
  "box",
  "dropbox",
] as const

describe("provider logos", () => {
  test("covers every model provider", () => {
    for (const provider of MODEL_PROVIDERS) expect(providerLogoSource(provider.id).kind).not.toBe("fallback")
  })

  test("normalizes catalog aliases to real provider marks", () => {
    expect(providerLogoSource("DeepSeek")).toEqual({ kind: "provider", id: "deepseek" })
    for (const id of ["DeepSeek", "deep-seek", "deepseek-ai", "moonshot", "kimi", "z-ai", "zhipuai"])
      expect(providerLogoSource(id).kind).not.toBe("fallback")
  })

  test("uses the Ollama mark instead of a fallback initial", () => {
    expect(providerLogoSource("ollama")).toEqual({ kind: "vector", id: "ollama" })
  })

  test("uses the first-party OpenScience mark for Ace", () => {
    expect(providerLogoSource("openscience")).toEqual({ kind: "vector", id: "openscience" })
    expect(providerLogoSource("synsci")).toEqual({ kind: "vector", id: "openscience" })
    expect(providerLogoSource("ace")).toEqual({ kind: "vector", id: "openscience" })
  })

  test("covers every built-in compute and integration credential", () => {
    for (const id of CREDENTIALS) expect(providerLogoSource(id).kind).not.toBe("fallback")
  })

  test("uses local canonical marks for every CLI compute bridge", () => {
    expect(providerLogoSource("tensorpool").kind).toBe("image")
    expect(providerLogoSource("lambda-labs")).toEqual({ kind: "vector", id: "lambda" })
    expect(providerLogoSource("prime").kind).toBe("image")
    expect(providerLogoSource("vast-ai")).toEqual({ kind: "vector", id: "vast" })
    expect(providerLogoSource("runpod").kind).toBe("image")
  })

  test("uses local canonical marks for every MCP catalog brand", () => {
    for (const id of ["givemeanode", "github", "benchling", "box", "dropbox", "aws"]) {
      expect(providerLogoSource(id).kind).not.toBe("fallback")
    }
  })

  test("uses a monogram only for user-defined services", () => {
    expect(providerLogoSource("custom:lab-service").kind).toBe("fallback")
  })
})
