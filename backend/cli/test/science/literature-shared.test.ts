import { describe, expect, test } from "bun:test"
import { fromInverted, xmlAttr, xmlSelfClosing } from "../../src/science/connectors/literature/shared"

describe("fromInverted", () => {
  test("reconstructs a plain abstract in position order", () => {
    expect(fromInverted({ Hello: [0], world: [1] })).toBe("Hello world")
  })

  test("keeps every token sharing a position", () => {
    expect(fromInverted({ improve: [3], results: [2], "improves.": [3] })).toBe("results improve improves.")
  })

  test("keeps repeated words at distinct positions without repeating duplicate postings", () => {
    expect(fromInverted({ repeat: [2, 0, 0], middle: [1], alternative: [0, 0] })).toBe(
      "repeat alternative middle repeat",
    )
  })

  test("keeps position order across gaps in the index", () => {
    expect(fromInverted({ end: [5], start: [0], middle: [2] })).toBe("start middle end")
  })

  test("handles sparse positions beyond the array-index range", () => {
    expect(fromInverted({ end: [Number.MAX_SAFE_INTEGER], middle: [2 ** 32], start: [0] })).toBe("start middle end")
  })

  test("ignores negative and non-integer positions", () => {
    expect(fromInverted({ bad: [-1, 1.5, NaN, Infinity, -Infinity], good: [0] })).toBe("good")
    expect(fromInverted({ bad: [-1, 1.5, NaN, Infinity], empty: [] })).toBeUndefined()
  })

  test("returns undefined for missing or empty indexes", () => {
    expect(fromInverted(undefined)).toBeUndefined()
    expect(fromInverted(null)).toBeUndefined()
    expect(fromInverted({})).toBeUndefined()
  })
})


describe("XML/Atom attributes", () => {
  test("reads single-quoted arXiv category terms", () => {
    expect(xmlAttr("<arxiv:primary_category term='cs.AI' />", "arxiv:primary_category", "term")).toBe("cs.AI")
  })

  test("parses single-quoted and mixed-quoted self-closing PDF links", () => {
    const links = xmlSelfClosing(
      `<link title='pdf' href='https://arxiv.org/pdf/1234.56789?x=1&amp;y=2' />` +
        `<link title="pdf" href='https://arxiv.org/pdf/9876.54321' />` +
        `<link title='other' href="https://example.com/O'Brien" />`,
      "link",
    )
    expect(links.map((link) => link.attrs)).toEqual([
      { title: "pdf", href: "https://arxiv.org/pdf/1234.56789?x=1&y=2" },
      { title: "pdf", href: "https://arxiv.org/pdf/9876.54321" },
      { title: "other", href: "https://example.com/O'Brien" },
    ])
  })
})
