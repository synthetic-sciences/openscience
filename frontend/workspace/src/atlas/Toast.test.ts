import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./Toast.tsx", import.meta.url)).text()
const directory = await Bun.file(new URL("../pages/directory-layout.tsx", import.meta.url)).text()
const preview = await Bun.file(new URL("./FilePreview.tsx", import.meta.url)).text()

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

  test("confirms a saved Result with a path-safe version label and a real open target", () => {
    expect(directory).toContain('title: "Saved to Results"')
    expect(preview).toContain('title: "Saved to Results"')
    expect(directory).toContain("description: saved ? savedResultLabel(saved) : name")
    expect(preview).toContain("description: saved ? savedResultLabel(saved) : name()")
    expect(directory).toContain("actions: saved")
    expect(preview).toContain("actions: saved")
    expect(directory).toContain("onClick: () => uiStore.openSaved(saved)")
    expect(preview).toContain("onClick: () => uiStore.openSaved(saved)")
    expect(directory).not.toContain("description: `${path}")
    expect(preview).not.toContain("description: props.path")
  })
})
