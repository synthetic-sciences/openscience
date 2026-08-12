import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./Toast.tsx", import.meta.url)).text()

describe("workspace toast contract", () => {
  test("uses the shared accessible toast region for every notification path", () => {
    expect(source).toContain("showToast({")
    expect(source).toContain('<Toast.Region aria-label="Notifications"')
    expect(source).toContain("toaster.dismiss(id)")
    expect(source).not.toContain("setTimeout(")
    expect(source).not.toContain("FONT_MONO")
  })

  test("normalizes legacy lowercase titles without transforming command or path descriptions", () => {
    expect(source).toContain("title: sentenceCase(input.title)")
    expect(source).toContain("description: input.description")
  })
})
