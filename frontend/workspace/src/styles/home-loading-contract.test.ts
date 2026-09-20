import { describe, expect, test } from "bun:test"

const css = await Bun.file(new URL("../pages/home-workbench.css", import.meta.url)).text()
const app = await Bun.file(new URL("../app.tsx", import.meta.url)).text()

const parsed = Array.from(css.matchAll(/(?<selector>[^{}]+)\{(?<body>[^{}]*)\}/g), (rule) => ({
  selectors: rule.groups!.selector.split(",").map((one) =>
    one
      .trim()
      .split(/\s*\n\s*/)
      .pop()!
      .trim(),
  ),
  body: rule.groups!.body,
}))
const declarations = {
  tokens: parsed
    .filter((rule) => rule.selectors.includes(":root"))
    .map((rule) => rule.body)
    .join("\n"),
}
/** Every rule for a selector that declares the given property, at every width. */
const declared = (selector: string, property: string) =>
  parsed
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body.match(new RegExp(`(?:^|;|\\{)\\s*${property}:\\s*(?<value>[^;]+)`))?.groups?.value)
    .filter((value): value is string => value !== undefined)

/**
 * The route's Suspense fallback stands in for the projects page before it
 * renders. It lives outside the page's own markup, so the only thing keeping
 * its mark where the page's card will put it is that both sides read the same
 * custom properties. A term the fallback alone knows about is a term that
 * drifts the next time the page's spacing moves.
 */
describe("projects loading placement", () => {
  test("the route fallback is offset by the page's own geometry, not by a number of its own", () => {
    expect(app).toContain('class="science-home__fallback"')

    const fallback = css.match(/\.science-home__fallback\s*\{(?<body>[^}]*)\}/)?.groups?.body
    expect(fallback).toBeDefined()
    expect(fallback).toContain("padding-top: var(--science-home-loader-top)")
    // Top-aligned: the mark hangs off that offset instead of the surface centre.
    expect(fallback).toContain("align-content: start")
    expect(fallback).not.toMatch(/\d+(?:\.\d+)?px/)
  })

  test("every term of the offset is a property the page itself lays out from", () => {
    const offset = css.match(/--science-home-loader-top:\s*calc\((?<value>[\s\S]*?)\);/)?.groups?.value
    expect(offset).toBeDefined()

    const terms = new Set(Array.from(offset!.matchAll(/var\((--[a-z0-9-]+)\)/g), (match) => match[1]!))
    // The strip, the main's top padding, the title's two metrics, the gap under
    // it, the lede's own size, the stacked actions, the card's margin and its
    // own top padding -- and not one literal.
    expect([...terms].sort()).toEqual([
      "--font-size-base",
      "--science-home-bar",
      "--science-home-copy-gap",
      "--science-home-heading-stack",
      "--science-home-loading-pad",
      "--science-home-main-top",
      "--science-home-state-gap",
      "--science-home-title-leading",
      "--science-home-title-size",
    ])
    expect(offset).not.toMatch(/\d+(?:\.\d+)?px/)

    for (const term of terms) {
      if (term === "--font-size-base") continue // a theme token, defined outside this file
      expect(declarations.tokens, `${term} is never defined`).toContain(`${term}:`)
    }
    // The heading only stacks its actions under the copy at narrow widths, and
    // it does that with the page's own gap and control height.
    expect(declarations.tokens).toContain(
      "--science-home-heading-stack: calc(var(--science-home-heading-gap) + var(--science-home-action-height))",
    )
  })

  test("the narrow and coarse bands move the terms rather than the rules", () => {
    for (const band of ["@media (max-width: 760px)", "@media (max-width: 520px)", "@media (pointer: coarse)"]) {
      const start = css.indexOf(band)
      expect(start, `${band} is gone`).toBeGreaterThan(-1)
      expect(css.slice(start, css.indexOf("\n}\n", start))).toContain("--science-home-")
    }
    // Every rule that sets one of these at any width sets it from the term the
    // offset adds up, so a band cannot quietly go back to a number.
    const bound: Array<[string, string, string]> = [
      [".science-home__bar.g-strip", "min-height", "--science-home-bar"],
      [".science-home__main", "padding", "--science-home-main-top"],
      [".science-home__title h1", "font-size", "--science-home-title-size"],
      [".science-home__title h1", "line-height", "--science-home-title-leading"],
      [".science-home__heading-copy", "gap", "--science-home-copy-gap"],
      [".science-home__heading-copy > p", "font-size", "--font-size-base"],
      [".science-home__state", "margin-top", "--science-home-state-gap"],
      [".science-home__state.science-home__state--loading", "padding", "--science-home-loading-pad"],
      [".science-home__button", "min-height", "--science-home-action-height"],
    ]
    for (const [selector, property, term] of bound) {
      const values = declared(selector, property)
      expect(values.length, `${selector} no longer sets ${property}`).toBeGreaterThan(0)
      for (const value of values) expect(value.trim(), `${selector} { ${property} }`).toStartWith(`var(${term})`)
    }
    // The heading's stacked band and the card at its narrowest keep theirs too.
    expect(declared(".science-home__heading", "gap").at(-1)).toStartWith("var(--science-home-heading-gap)")
    expect(declared(".science-home__state", "padding").at(-1)).toStartWith("var(--science-home-state-top)")
  })

  /**
   * .science-home__state--loading is the same specificity as the generic
   * ≤520 ".science-home__state" rule and loses to it on source order alone,
   * so the loading card needs both a token of its own AND a selector that
   * actually outranks the band -- either half missing lets the band silently
   * retune the loading card's padding back down with the generic card's.
   */
  test("no band retunes the loading card's own padding", () => {
    for (const band of ["@media (max-width: 760px)", "@media (max-width: 520px)", "@media (pointer: coarse)"]) {
      const start = css.indexOf(band)
      const block = css.slice(start, css.indexOf("\n}\n", start))
      expect(block, `${band} redefines the loading card's own padding token`).not.toContain(
        "--science-home-loading-pad",
      )
    }
    const loadingRule = css.match(/\.science-home__state\.science-home__state--loading\s*\{(?<body>[^}]*)\}/)?.groups
      ?.body
    expect(loadingRule, "the loading card's rule must name both classes to outrank the ≤520 band").toBeDefined()
    expect(loadingRule).toContain("padding: var(--science-home-loading-pad)")
  })
})
