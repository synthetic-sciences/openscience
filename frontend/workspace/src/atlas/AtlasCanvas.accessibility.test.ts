import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./AtlasCanvas.tsx", import.meta.url)), "utf8")

describe("Atlas canvas accessibility", () => {
  test("keeps graph nodes named, focusable, and keyboard operable", () => {
    const canvas = source()

    expect(canvas).toContain(
      'aria-label="Gateway research graph. Use Tab to move between nodes and Enter to open one."',
    )
    expect(canvas).toContain("data-node-id={s.id}")
    expect(canvas).toContain('role="button"')
    expect(canvas).toContain("tabindex={0}")
    expect(canvas).toContain("aria-pressed={sel()}")
    expect(canvas).toContain("onfocus={(event) =>")
    expect(canvas).toContain('event.key !== "Enter" && event.key !== " "')
    expect(canvas).toContain("setSelectedID((current) => (current === s.id ? null : s.id))")
  })
})
