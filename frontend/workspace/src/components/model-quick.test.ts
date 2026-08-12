import { describe, expect, test } from "bun:test"
import { curateQuickModels } from "./model-quick"

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
  test("uses only available models and keeps provider labs diverse", () => {
    const openai = model("gpt-live", "openai", { latest: true })
    const openaiOlder = model("gpt-older", "openai")
    const anthropic = model("claude-live", "anthropic", { latest: true })
    const google = model("gemini-live", "google", { latest: true })

    expect(
      curateQuickModels({
        pinned: [],
        current: openai,
        recent: [openaiOlder],
        available: [openaiOlder, openai, anthropic, google],
        limit: 3,
      }).map((item) => item.id),
    ).toEqual(["gpt-live", "claude-live", "gemini-live"])
  })

  test("honors explicit pins and deduplicates routed aliases", () => {
    const pinned = model("claude-opus-5", "anthropic")
    const routed = model("anthropic/claude-opus-5", "openrouter")
    const google = model("gemini-live", "google")

    expect(
      curateQuickModels({ pinned: [pinned], current: routed, recent: [], available: [routed, google] }).map(
        (item) => item.id,
      ),
    ).toEqual(["claude-opus-5", "gemini-live"])
  })
})
