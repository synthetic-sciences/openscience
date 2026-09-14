import { describe, expect, test } from "bun:test"
import { cleanReleaseLine, parseReleaseBody } from "./highlights"

describe("release body parsing", () => {
  test("a GitHub release body becomes one highlight per section with clean bullet items", () => {
    const body = [
      "## Core",
      "- Literature tool, arXiv fallbacks, and structured source diagnostics (#610)",
      "- [Family headers](https://example.org/docs) per **model family**",
      "",
      "<!-- openscience-release-source:50c9554e8c3c549146fa897d8c9e768c4ef4ad10 -->",
      "",
      "The Windows desktop installer is unsigned while Microsoft Artifact Signing setup is incomplete.",
      "",
      "## Desktop",
      "* Faster startup",
    ].join("\n")
    expect(parseReleaseBody(body, "v2.0.96")).toEqual([
      {
        title: "Core",
        description: "",
        items: [
          "Literature tool, arXiv fallbacks, and structured source diagnostics",
          "Family headers per model family",
        ],
      },
      { title: "Desktop", description: "", items: ["Faster startup"] },
    ])
  })

  test("bullets without a heading and prose-only bodies still render", () => {
    expect(parseReleaseBody("- One fix (#12)\n- Another", "v1.2.3")).toEqual([
      { title: "v1.2.3", description: "", items: ["One fix", "Another"] },
    ])
    expect(parseReleaseBody("<!-- marker -->\nA short note.\nSecond line.", "v1.2.3")).toEqual([
      { title: "v1.2.3", description: "A short note. Second line." },
    ])
    expect(parseReleaseBody("<!-- only a marker -->", "v1.2.3")).toEqual([])
  })

  test("cleanReleaseLine strips links, emphasis and the trailing PR reference", () => {
    expect(cleanReleaseLine("**Bold** and [a link](http://x) here (#42)")).toBe("Bold and a link here")
  })
})
