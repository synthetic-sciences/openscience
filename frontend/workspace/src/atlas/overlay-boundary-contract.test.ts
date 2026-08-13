import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("workspace overlay boundary language", () => {
  test("uses the same quiet edge and elevation for local popovers and menus", async () => {
    const [model, prompt, files] = await Promise.all([
      read("../components/model-settings-popover.css"),
      read("../components/prompt-input.css"),
      read("./files/FilesPane.css"),
    ])

    for (const source of [model, prompt, files]) {
      expect(source).toContain("border: 1px solid var(--color-border)")
      expect(source).toContain("background-clip: padding-box")
      expect(source).toContain("var(--atlas-shadow-md)")
    }

    expect(files).not.toMatch(/box-shadow:\s*[^;]*rgb\(/)
    expect(prompt).not.toContain("box-shadow: var(--atlas-shadow-float)")
    expect(model).not.toContain("box-shadow: var(--atlas-shadow-float)")
  })

  test("drops the side seam when the inspector overlay occupies the full width", async () => {
    const pane = await read("./right-pane-tabs.css")

    expect(pane).toMatch(
      /\.session-right-pane\[data-expanded="true"\],\s*\.session-right-pane\[data-overlay="true"\]\[data-mobile="true"\]\s*\{[^}]*border-left:\s*0;/s,
    )
    expect(pane).toMatch(/@media \(max-width: 719px\)[\s\S]*\.session-right-pane\s*\{[^}]*border:\s*0;/)
  })
})
