import { describe, expect, test } from "bun:test"
import { FONT_WEIGHT, sectionTitle } from "./tokens"

describe("workspace typography tokens", () => {
  test("mirrors the shared quiet weight scale", async () => {
    const css = await Bun.file(new URL("../../../ui/src/styles/theme.css", import.meta.url)).text()

    expect(FONT_WEIGHT).toEqual({ regular: 380, medium: 480, emphasis: 500 })
    expect(sectionTitle["font-weight"]).toBe(FONT_WEIGHT.medium)
    expect(css).toContain(`--font-weight-regular: ${FONT_WEIGHT.regular}`)
    expect(css).toContain(`--font-weight-medium: ${FONT_WEIGHT.medium}`)
    expect(css).toContain(`--font-weight-emphasis: ${FONT_WEIGHT.emphasis}`)
  })
})
