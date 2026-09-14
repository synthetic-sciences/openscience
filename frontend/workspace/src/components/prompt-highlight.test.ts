import { describe, expect, test } from "bun:test"
import { applyHighlight, slashTokenRanges } from "./prompt-highlight"

describe("slash token highlight", () => {
  test("covers known triggers at word boundaries and leaves paths and unknown tokens alone", () => {
    const editor = document.createElement("div")
    editor.append(
      document.createTextNode("/autoresearch run the sweep, then /Plan it; see /tmp/notes and /unknown "),
      document.createTextNode("/reproduce"),
    )
    const ranges = slashTokenRanges(editor, new Set(["autoresearch", "plan", "reproduce"]))
    expect(ranges.map((range) => range.toString())).toEqual(["/autoresearch", "/Plan", "/reproduce"])
    expect(slashTokenRanges(editor, new Set())).toEqual([])
  })

  test("applyHighlight is a no-op where the Custom Highlight API is missing", () => {
    const editor = document.createElement("div")
    editor.append(document.createTextNode("/plan now"))
    const ranges = slashTokenRanges(editor, new Set(["plan"]))
    const supported = "highlights" in (globalThis.CSS ?? {}) && "Highlight" in globalThis
    expect(applyHighlight("composer-slash", ranges)).toBe(supported)
  })
})
