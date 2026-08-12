import { describe, expect, test } from "bun:test"
import { dict } from "./en"

const deliberateFragments = new Set([
  "provider.connect.oauth.code.visit.suffix",
  "provider.connect.oauth.auto.visit.suffix",
])

describe("English interface copy", () => {
  test("uses sentence case instead of accidental lowercase labels", () => {
    const offenders = Object.entries(dict)
      .filter(([key, value]) => {
        const text = String(value).trimStart()
        if (key === "model.provider.xai") return false
        if (deliberateFragments.has(key)) return false
        if (/^https?:\/\//.test(text)) return false
        return /^[a-z]/.test(text)
      })
      .map(([key, value]) => `${key}: ${value}`)

    expect(offenders).toEqual([])
  })

  test("preserves technical acronym casing", () => {
    expect(dict["dialog.mcp.title"]).toBe("MCPs")
    expect(dict["model.input.pdf"]).toBe("PDF")
    expect(dict["provider.connect.method.apiKey"]).toBe("API key")
    expect(dict["status.popover.tab.lsp"]).toBe("LSP")
  })
})
