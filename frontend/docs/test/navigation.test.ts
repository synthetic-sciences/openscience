import { describe, expect, test } from "bun:test"
import { aliases, headings, pageHref, parseRoute, resolveLink } from "../src/navigation"

describe("documentation routes", () => {
  test("keeps the page when navigating to a section", () => {
    const href = resolveLink("/openscience/sessions#exit-codes", { section: "openscience", path: "index" })
    expect(href).toBe("#/openscience/sessions#exit-codes")
    expect(parseRoute(href!)).toEqual({ section: "openscience", path: "sessions", anchor: "exit-codes" })
    expect(resolveLink("#exit-codes", { section: "openscience", path: "sessions" })).toBe(href)
  })
  test("retains old page and section links", () => {
    for (const [old, current] of Object.entries(aliases)) {
      expect(parseRoute("#/openscience/" + old).path).toBe(current)
      expect(parseRoute("#/agent-cli/" + old).path).toBe(current)
      expect(parseRoute("#" + old).path).toBe(current)
    }
  })
  test("unknown and malformed routes remain recoverable", () => {
    expect(parseRoute("#/openscience/missing").path).toBe("missing")
    expect(parseRoute("#/openscience/%ZZ").path).toBe("%ZZ")
    expect(parseRoute("")).toEqual({ section: "openscience", path: "index" })
    expect(parseRoute("#/openscience/")).toEqual({ section: "openscience", path: "index" })
  })
  test("preserves external links and encoded section names", () => {
    const route = { section: "openscience" as const, path: "models" }
    expect(resolveLink("https://example.org/a#b", route)).toBe("https://example.org/a#b")
    expect(resolveLink("mailto:help@example.org", route)).toBe("mailto:help@example.org")
    expect(parseRoute(pageHref("openscience", "models", "a b")).anchor).toBe("a b")
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
