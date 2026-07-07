import { describe, expect, test } from "bun:test"
import { LocalProvider } from "../../src/provider/local"

describe("LocalProvider.normalizeBaseURL", () => {
  test("adds http:// and /v1 when missing", () => {
    expect(LocalProvider.normalizeBaseURL("localhost:11434")).toBe("http://localhost:11434/v1")
    expect(LocalProvider.normalizeBaseURL("127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1")
  })
  test("keeps an existing scheme and version segment", () => {
    expect(LocalProvider.normalizeBaseURL("http://localhost:11434/v1")).toBe("http://localhost:11434/v1")
    expect(LocalProvider.normalizeBaseURL("https://host/openai/v1")).toBe("https://host/openai/v1")
    expect(LocalProvider.normalizeBaseURL("http://host/v1beta")).toBe("http://host/v1beta")
  })
  test("trims whitespace and trailing slashes", () => {
    expect(LocalProvider.normalizeBaseURL("  http://localhost:1234/  ")).toBe("http://localhost:1234/v1")
  })
  test("appends /v1 to a bare host with a path but no version", () => {
    expect(LocalProvider.normalizeBaseURL("http://localhost:8080")).toBe("http://localhost:8080/v1")
  })
})

describe("LocalProvider.modelsEndpoint", () => {
  test("joins /models without doubling slashes", () => {
    expect(LocalProvider.modelsEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/models")
    expect(LocalProvider.modelsEndpoint("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1/models")
  })
})

describe("LocalProvider.parseModelsResponse", () => {
  test("parses the OpenAI {object:list,data:[{id}]} shape, sorted + deduped", () => {
    const body = { object: "list", data: [{ id: "qwen2.5" }, { id: "llama3.1" }, { id: "llama3.1" }] }
    expect(LocalProvider.parseModelsResponse(body)).toEqual(["llama3.1", "qwen2.5"])
  })
  test("tolerates a bare array of strings or {name}", () => {
    expect(LocalProvider.parseModelsResponse(["b", "a"])).toEqual(["a", "b"])
    expect(LocalProvider.parseModelsResponse([{ name: "b" }, { name: "a" }])).toEqual(["a", "b"])
  })
  test("tolerates Ollama's native {models:[{name}]} shape", () => {
    expect(LocalProvider.parseModelsResponse({ models: [{ name: "phi3" }] })).toEqual(["phi3"])
  })
  test("returns [] for junk", () => {
    expect(LocalProvider.parseModelsResponse(null)).toEqual([])
    expect(LocalProvider.parseModelsResponse({ nope: 1 })).toEqual([])
    expect(LocalProvider.parseModelsResponse({ data: [{}, { id: "" }] })).toEqual([])
  })
})

describe("LocalProvider.buildProviderConfig", () => {
  test("emits an openai-compatible provider block with zero-cost models", () => {
    const block = LocalProvider.buildProviderConfig({
      name: "Ollama (local)",
      baseURL: "http://localhost:11434/v1",
      models: ["llama3.1", "qwen2.5"],
    }) as any
    expect(block.npm).toBe("@ai-sdk/openai-compatible")
    expect(block.api).toBe("http://localhost:11434/v1")
    expect(block.options.baseURL).toBe("http://localhost:11434/v1")
    expect(block.options.apiKey).toBe("local")
    expect(Object.keys(block.models)).toEqual(["llama3.1", "qwen2.5"])
    expect(block.models["llama3.1"]).toMatchObject({
      name: "llama3.1",
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 32768, output: 8192 },
    })
  })
  test("uses a supplied apiKey when given", () => {
    const block = LocalProvider.buildProviderConfig({
      name: "x",
      baseURL: "http://h/v1",
      apiKey: "sk-local",
      models: ["m"],
    }) as any
    expect(block.options.apiKey).toBe("sk-local")
  })
})

describe("LocalProvider.listModels (injected fetch — no global mutation)", () => {
  test("hits <baseURL>/models and parses the response", async () => {
    let calledUrl = ""
    const fetchImpl = (async (url: any) => {
      calledUrl = String(url)
      return Response.json({ data: [{ id: "llama3.1" }] })
    }) as unknown as typeof fetch
    const models = await LocalProvider.listModels("http://localhost:11434/v1", undefined, { fetchImpl })
    expect(calledUrl).toBe("http://localhost:11434/v1/models")
    expect(models).toEqual(["llama3.1"])
  })

  test("probe() returns null when the endpoint is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await LocalProvider.probe("http://localhost:11434/v1", undefined, 50, fetchImpl)).toBeNull()
  })

  test("probe() returns null on a non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    expect(await LocalProvider.probe("http://localhost:1234/v1", undefined, 50, fetchImpl)).toBeNull()
  })
})
