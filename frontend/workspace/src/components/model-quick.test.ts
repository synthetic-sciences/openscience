import { describe, expect, test } from "bun:test"
import { curateQuickModelRows, curateQuickModels } from "./model-quick"

const model = (
  id: string,
  provider: string,
  options?: { latest?: boolean; reasoning?: boolean; released?: string },
) => ({
  id,
  name: id,
  provider: { id: provider, name: provider },
  latest: options?.latest,
  release_date: options?.released,
  capabilities: { reasoning: options?.reasoning ?? true },
  limit: { context: 200_000 },
})

describe("curated composer models", () => {
  test("interleaves connected choices and placeholders in DOM order before explicit exceptions", () => {
    const choice = (key: string) => ({ key })
    const rows = curateQuickModelRows([
      choice("openai/gpt-5-6-sol"),
      choice("openai/gpt-5-6-terra"),
      choice("anthropic/claude-opus-5"),
      choice("moonshotai/kimi-k3"),
      choice("deepseek/deepseek-v4-flash"),
      choice("google/gemini-3-6-flash"),
    ])

    expect(rows.map((row) => row.key)).toEqual([
      "openai/gpt-5-6-sol",
      "openai/gpt-5-6-terra",
      "anthropic/claude-opus-5",
      "moonshotai/kimi-k3",
      "zai/glm-5-3",
      "deepseek/deepseek-v4-flash",
      "anthropic/claude-fable-5",
      "xai/grok-4-6",
      "google/gemini-3-6-flash",
    ])
    expect(rows.map((row) => row.kind)).toEqual([
      "choice",
      "choice",
      "choice",
      "choice",
      "unavailable",
      "choice",
      "unavailable",
      "unavailable",
      "choice",
    ])
  })

  test("omits connected models hidden by the user while retaining truly unavailable placeholders", () => {
    const choice = (key: string) => ({ key })
    const rows = curateQuickModelRows([choice("openai/gpt-5-6-sol"), choice("anthropic/claude-opus-5")], {
      hidden: new Set(["openai/gpt-5-6-terra"]),
    })

    expect(rows.map((row) => row.key)).not.toContain("openai/gpt-5-6-terra")
    expect(rows.find((row) => row.key === "zai/glm-5-3")?.kind).toBe("unavailable")
  })

  test("moves pinned roster and catalog choices ahead of the default roster", () => {
    const choice = (key: string) => ({ key })
    const rows = curateQuickModelRows(
      [
        choice("openai/gpt-5-6-sol"),
        choice("openai/gpt-5-6-terra"),
        choice("anthropic/claude-opus-5"),
        choice("google/gemini-3-6-flash"),
      ],
      { pinned: ["anthropic/claude-opus-5", "google/gemini-3-6-flash"] },
    )

    expect(rows.slice(0, 4).map((row) => row.key)).toEqual([
      "anthropic/claude-opus-5",
      "google/gemini-3-6-flash",
      "openai/gpt-5-6-sol",
      "openai/gpt-5-6-terra",
    ])
  })

  test("shows the requested roster in order and keeps only the explicit current exception", () => {
    const sol = model("gpt-5.6-sol", "openai")
    const terra = model("gpt-5.6-terra", "openai")
    const opus = model("claude-opus-5", "anthropic")
    const current = model("gemini-3.6-flash", "google", { latest: true })
    const unrelated = model("grok-4.5", "xai", { latest: true })

    expect(
      curateQuickModels({
        pinned: [],
        current,
        available: [unrelated, opus, current, terra, sol],
      }).map((item) => item.id),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "claude-opus-5", "gemini-3.6-flash"])
  })

  test("puts an explicit pinned exception first while excluding other catalog models", () => {
    const sol = model("gpt-5.6-sol", "openai")
    const pinned = model("gemini-3.6-flash", "google")
    const unrelated = model("grok-4.5", "xai")

    expect(curateQuickModels({ pinned: [pinned], available: [unrelated, pinned, sol] }).map((item) => item.id)).toEqual(
      ["gemini-3.6-flash", "gpt-5.6-sol"],
    )
  })
})
