import { expect, test } from "bun:test"
import { markdownImages, rewriteMarkdownImages } from "../../../../tooling/util/src/markdown"

test("ignores figures and reference definitions in Markdown HTML comments", () => {
  const text = [
    "<!-- ![Old](figures/old.png) -->",
    "<!--",
    "![Hidden](figures/missing.png)",
    "[hidden]: figures/old-reference.png",
    "-->",
    "![Visible](figures/real.png)",
    "![Unresolved][hidden]",
    "`<!-- ![Literal](figures/code.png) -->`",
  ].join("\n")
  expect(markdownImages(text).map((image) => [image.alt, image.target, image.line])).toEqual([
    ["Visible", "figures/real.png", 6],
  ])
  expect(rewriteMarkdownImages(text, () => "/replacement.png")).toContain("![Visible](/replacement.png)")
  expect(rewriteMarkdownImages(text, () => "/replacement.png")).toContain("![Hidden](figures/missing.png)")
})

test("resumes figure scanning after an inline closing comment", () => {
  const text = "Text <!-- ![Hidden](ghost.png) --> ![Shown](figure.png)"
  expect(markdownImages(text).map((image) => image.target)).toEqual(["figure.png"])
})

test("an unmatched backtick does not hide a subsequent HTML comment", () => {
  const text = "An unmatched `code\n<!-- ![Hidden](ghost.png) -->\n![Shown](figure.png)"
  expect(markdownImages(text).map((image) => image.target)).toEqual(["figure.png"])
})
