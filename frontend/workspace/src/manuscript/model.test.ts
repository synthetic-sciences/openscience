import { describe, expect, test } from "bun:test"
import {
  figureMarkdown,
  insertSelection,
  parseBibtex,
  parseManuscript,
  relativeArtifactPath,
  resolveReferencePath,
  rewritePreviewImages,
} from "./model"

describe("manuscript model", () => {
  test("keeps YAML frontmatter in source but removes it from the rendered body", () => {
    const source = `---
title: Result
bibliography: references.bib
---

# Result

Evidence [@doe2025].
`
    const manuscript = parseManuscript(source)

    expect(manuscript.frontmatter).toContain("title: Result")
    expect(manuscript.bibliographies).toEqual(["references.bib"])
    expect(manuscript.body).toBe("# Result\n\nEvidence [@doe2025].\n")
  })

  test("reads inline and block bibliography declarations without duplicates", () => {
    expect(
      parseManuscript(`---
bibliography: [refs/core.bib, "refs/more.bib", refs/core.bib]
---
Body`).bibliographies,
    ).toEqual(["refs/core.bib", "refs/more.bib"])

    expect(
      parseManuscript(`---
bibliography:
  - refs/biology.bib
  - 'refs/chemistry.bib'
---
Body`).bibliographies,
    ).toEqual(["refs/biology.bib", "refs/chemistry.bib"])
  })

  test("parses BibTeX keys and useful citation metadata", () => {
    const citations = parseBibtex(`
@article{doe2025,
  title = {A {Nested} Scientific Result},
  author = {Doe, Jane and Roe, Richard},
  year = "2025",
  journal = {Open Research}
}
@misc{dataset,
  title={Reference dataset},
  year={2024}
}`)

    expect(citations).toEqual([
      {
        key: "doe2025",
        title: "A Nested Scientific Result",
        author: "Doe, Jane and Roe, Richard",
        year: "2025",
        venue: "Open Research",
      },
      {
        key: "dataset",
        title: "Reference dataset",
        year: "2024",
      },
    ])
  })

  test("computes portable paths and figure Markdown relative to the manuscript", () => {
    expect(relativeArtifactPath("reports/paper.md", "figures/result plot.svg")).toBe("../figures/result plot.svg")
    expect(relativeArtifactPath("paper.md", "figures/result.svg")).toBe("figures/result.svg")
    expect(resolveReferencePath("reports/paper.md", "../references/core.bib")).toBe("references/core.bib")
    expect(resolveReferencePath("/work/project/reports/paper.md", "../references/core.bib")).toBe(
      "/work/project/references/core.bib",
    )
    expect(figureMarkdown("Primary endpoint", "reports/paper.md", "figures/result plot.svg")).toBe(
      "![Primary endpoint](../figures/result%20plot.svg)",
    )
  })

  test("rewrites local preview images through the file server without touching remote assets", () => {
    const markdown = [
      "![Local](../figures/result%20plot.svg)",
      "![Remote](https://example.com/result.svg)",
      "![Inline](data:image/png;base64,abc)",
    ].join("\n")

    expect(rewritePreviewImages(markdown, "reports/paper.md", (path) => `/raw?path=${encodeURIComponent(path)}`)).toBe(
      [
        "![Local](/raw?path=figures%2Fresult%20plot.svg)",
        "![Remote](https://example.com/result.svg)",
        "![Inline](data:image/png;base64,abc)",
      ].join("\n"),
    )
  })

  test("replaces the current editor selection and returns the next caret", () => {
    expect(insertSelection("Alpha placeholder omega", "[@doe2025]", 6, 17)).toEqual({
      text: "Alpha [@doe2025] omega",
      start: 16,
      end: 16,
    })
    expect(insertSelection("Alpha", " figure", 99, 99)).toEqual({
      text: "Alpha figure",
      start: 12,
      end: 12,
    })
  })
})
