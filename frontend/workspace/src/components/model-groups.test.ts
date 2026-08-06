import { describe, expect, test } from "bun:test"
import { MODEL_GROUPS, modelGroup, modelGroupLabel, modelGroupLabelRank, modelGroupRank } from "./model-groups"

const model = (id: string, provider: string) => ({ id, provider: { id: provider } })

describe("model groups", () => {
  test("uses the requested discovery order", () => {
    expect(MODEL_GROUPS.map((group) => group.label)).toEqual([
      "Pinned",
      "OpenAI Codex subscription",
      "Anthropic",
      "GLM",
      "OpenAI",
      "Miscellaneous",
    ])
  })

  test("recognizes native and routed provider families", () => {
    expect(modelGroup(model("gpt-5.6-sol", "openai-codex"))).toBe("codex")
    expect(modelGroup(model("anthropic/claude-opus-5", "openrouter"))).toBe("anthropic")
    expect(modelGroup(model("z-ai/glm-5.2", "openrouter"))).toBe("glm")
    expect(modelGroup(model("gpt-5.6-sol", "openai"))).toBe("openai")
    expect(modelGroup(model("kimi-k3", "moonshotai"))).toBe("misc")
  })

  test("puts pinned models ahead of every provider family", () => {
    const group = modelGroup(model("kimi-k3", "moonshotai"), true)
    expect(modelGroupLabel(group)).toBe("Pinned")
    expect(modelGroupRank(group)).toBe(0)
    expect(modelGroupLabelRank("Pinned")).toBe(0)
  })
})
