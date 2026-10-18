import { describe, expect, test } from "bun:test"
import { aliases, documentTitle, headings, movedHref, pageHref, parseRoute, resolveLink } from "../src/navigation"

describe("documentation routes", () => {
  test("pages have their own paths, with anchors for sections", () => {
    const href = resolveLink("/openscience/sessions#exit-codes", { section: "openscience", path: "index" })
    expect(href).toBe("/docs/sessions#exit-codes")
    expect(parseRoute(href!)).toEqual({ section: "openscience", path: "sessions", anchor: "exit-codes" })
    expect(resolveLink("#exit-codes", { section: "openscience", path: "sessions" })).toBe(href)
    expect(resolveLink("quickstart.mdx", { section: "openscience", path: "index" })).toBe("/docs/quickstart")
    expect(pageHref("openscience", "index")).toBe("/docs")
    expect(parseRoute("/docs")).toEqual({ section: "openscience", path: "index" })
    expect(parseRoute("/docs/")).toEqual({ section: "openscience", path: "index" })
  })
  test("retains old hash links, renamed pages and section prefixes", () => {
    for (const [old, current] of Object.entries(aliases)) {
      expect(parseRoute("#/openscience/" + old).path).toBe(current)
      expect(parseRoute("#/agent-cli/" + old).path).toBe(current)
      expect(parseRoute("#" + old).path).toBe(current)
      expect(parseRoute("/docs/" + old).path).toBe(current)
      expect(movedHref("/docs/", "#" + old)).toBe("/docs/" + current)
      expect(movedHref("/docs/" + old, "")).toBe("/docs/" + current)
    }
    expect(movedHref("/docs/", "#/openscience/sessions#exit-codes")).toBe("/docs/sessions#exit-codes")
    expect(movedHref("/docs/", "#/openscience/index")).toBe("/docs")
    expect(movedHref("/docs/sessions", "#exit-codes")).toBeNull()
    expect(movedHref("/docs", "#quickstart")).toBeNull()
    expect(movedHref("/docs/constructor", "")).toBeNull()
  })
  test("unknown and malformed routes remain recoverable", () => {
    expect(parseRoute("#/openscience/missing").path).toBe("missing")
    expect(parseRoute("#/openscience/%ZZ").path).toBe("%ZZ")
    expect(parseRoute("/docs/%ZZ").path).toBe("%ZZ")
    expect(parseRoute("")).toEqual({ section: "openscience", path: "index" })
    expect(parseRoute("#/openscience/")).toEqual({ section: "openscience", path: "index" })
  })
  test("preserves external links and encoded section names", () => {
    const route = { section: "openscience" as const, path: "models" }
    expect(resolveLink("https://example.org/a#b", route)).toBe("https://example.org/a#b")
    expect(resolveLink("mailto:help@example.org", route)).toBe("mailto:help@example.org")
    expect(parseRoute(pageHref("openscience", "models", "a b")).anchor).toBe("a b")
  })
  test("titles fit in search results", () => {
    expect(documentTitle("Quickstart")).toBe("Quickstart · OpenScience Docs")
    expect(documentTitle("OpenScience", "index")).toBe("OpenScience Docs")
    expect(documentTitle("A title long enough to drop the Docs suffix")).toBe(
      "A title long enough to drop the Docs suffix · OpenScience",
    )
    expect(documentTitle("x".repeat(70))).toBe("x".repeat(70))
  })
})

test("all real headings are indexed, but example headings are excluded", () => {
  const lines = Array.from({ length: 14 }, (_, index) => "## Section " + index)
  const code = String.fromCharCode(96).repeat(3)
  const document = [
    ...lines,
    code + "markdown",
    "## Example only",
    code,
    "~~~text",
    "## Also an example",
    "~~~",
    "## Last",
  ].join("\n")
  expect(headings(document)).toEqual([...lines.map((line) => line.slice(3)), "Last"])
})

test("tool entries have deep links without filling the page contents with subsections", () => {
  const source = "## Analysis\n### SciPy\n### Matplotlib\n"
  expect(headings(source)).toEqual(["Analysis"])
  expect(headings(source, 3).map((value) => value.toLowerCase())).toEqual(["analysis", "scipy", "matplotlib"])
})
