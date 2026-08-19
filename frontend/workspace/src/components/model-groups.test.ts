import { describe, expect, test } from "bun:test"
import { MODEL_GROUPS, modelGroup, modelGroupLabel, modelGroupLabelRank, modelGroupRank } from "./model-groups"

const model = (id: string, provider: string) => ({ id, provider: { id: provider } })

describe("model groups", () => {
  test("uses the requested discovery order", () => {
    expect(MODEL_GROUPS.map((group) => group.label)).toEqual([
      "Quick access",
      "OpenAI Codex",
      "OpenAI",
      "Anthropic",
      "Google",
      "Kimi",
      "DeepSeek",
      "GLM",
      "xAI",
      "Qwen",
      "Meta",
      "Mistral",
    ])
  })

  test("recognizes native and routed provider families", () => {
    expect(modelGroup(model("gpt-5.6-sol", "openai-codex"))).toBe("codex")
    expect(modelGroup(model("anthropic/claude-opus-5", "openrouter"))).toBe("anthropic")
    expect(modelGroup(model("z-ai/glm-5.2", "openrouter"))).toBe("glm")
    expect(modelGroup(model("gpt-5.6-sol", "openai"))).toBe("openai")
    expect(modelGroup(model("kimi-k3", "moonshotai"))).toBe("kimi")
    expect(modelGroup(model("deepseek/deepseek-v4-pro", "openrouter"))).toBe("deepseek")
    expect(modelGroupLabel(modelGroup(model("command-r", "cohere")))).toBe("Cohere")
  })

  test("puts pinned models ahead of every provider family", () => {
    const group = modelGroup(model("kimi-k3", "moonshotai"), true)
    expect(modelGroupLabel(group)).toBe("Quick access")
    expect(modelGroupRank(group)).toBe(0)
    expect(modelGroupLabelRank("Quick access")).toBe(0)
  })

  test("keeps local and self-hosted models together at the end of the catalog", () => {
    const ollama = modelGroup(model("llama3.2", "ollama"))
    const ssh = modelGroup(model("deepseek-r1", "ssh-research-gpu-11434"))

    expect(modelGroupLabel(ollama)).toBe("Local Models")
    expect(ssh).toBe(ollama)
    expect(modelGroupRank(ollama)).toBe(MODEL_GROUPS.length)
  })
})
