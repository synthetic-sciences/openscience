import { describe, expect, test } from "bun:test"
import { SettingsApiError } from "./api"
import { prepareOllamaModels, selectableLocalModels } from "./local-model-selection"

describe("local model selection", () => {
  test("prepares selected Ollama models without changing their order", async () => {
    const seen: string[] = []
    const result = await prepareOllamaModels(["qwen", "deepseek", "llama"], async (model) => {
      seen.push(model)
      return `openscience/${model}`
    })

    expect(result).toEqual({
      models: ["qwen", "deepseek", "llama"],
      aliases: {
        qwen: "openscience/qwen",
        deepseek: "openscience/deepseek",
        llama: "openscience/llama",
      },
      tuned: true,
    })
    expect(seen).toEqual(["qwen", "deepseek", "llama"])
  })

  test("falls back to the selected models when an older server lacks context tuning", async () => {
    const result = await prepareOllamaModels(["qwen", "deepseek"], async () => {
      throw new SettingsApiError("Route not found: /settings/local/context", 404, "not_found")
    })

    expect(result).toEqual({ models: ["qwen", "deepseek"], aliases: {}, tuned: false })
  })

  test("does not hide a genuine Ollama failure", async () => {
    await expect(
      prepareOllamaModels(["qwen"], async () => {
        throw new SettingsApiError("Ollama ran out of memory", 400)
      }),
    ).rejects.toThrow("Ollama ran out of memory")
  })

  test("keeps generated context aliases out of the model chooser", () => {
    expect(
      selectableLocalModels([
        "llama3.2:latest",
        "openscience/llama3.2-latest-ctx-32768:latest",
        "qwen2.5:32b",
        "openscience/qwen2.5-32b-ctx-46080",
      ]),
    ).toEqual(["llama3.2:latest", "qwen2.5:32b"])
  })
})
