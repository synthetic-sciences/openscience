import { describe, expect, test } from "bun:test"
import { SettingsApiError } from "./api"
import { prepareOllamaModels } from "./local-model-selection"

describe("local model selection", () => {
  test("prepares selected Ollama models without changing their order", async () => {
    const seen: string[] = []
    const result = await prepareOllamaModels(["qwen", "deepseek", "llama"], async (model) => {
      seen.push(model)
      return `openscience/${model}`
    })

    expect(result).toEqual({
      models: ["openscience/qwen", "openscience/deepseek", "openscience/llama"],
      tuned: true,
    })
    expect(seen).toEqual(["qwen", "deepseek", "llama"])
  })

  test("falls back to the selected models when an older server lacks context tuning", async () => {
    const result = await prepareOllamaModels(["qwen", "deepseek"], async () => {
      throw new SettingsApiError("Route not found: /settings/local/context", 404, "not_found")
    })

    expect(result).toEqual({ models: ["qwen", "deepseek"], tuned: false })
  })

  test("does not hide a genuine Ollama failure", async () => {
    await expect(
      prepareOllamaModels(["qwen"], async () => {
        throw new SettingsApiError("Ollama ran out of memory", 400)
      }),
    ).rejects.toThrow("Ollama ran out of memory")
  })
})
