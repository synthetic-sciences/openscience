import { describe, expect, test } from "bun:test"
import {
  HTML_STYLESHEET_LIMIT,
  cssStylesheets,
  htmlStylesheets,
  loadHtmlStylesheets,
  rewriteCssAssets,
  rewriteHtmlAssets,
} from "./html-assets"

describe("HTML preview assets", () => {
  test("removes document bases and rewrites local media attributes", () => {
    const result = rewriteHtmlAssets(
      `<!doctype html><html><head><base href="/escape/"></head><body>
        <picture><source srcset="small.png 1x, large.png 2x"><img src="figure.png" srcset="figure.png 1x, figure@2x.png 2x"></picture>
        <video src="movie.mp4" poster="poster.jpg"><track src="captions.vtt"></video>
        <object data="appendix.pdf"></object><svg><image href="plot.svg"></image></svg>
      </body></html>`,
      (value) => (/^[a-z]+:/i.test(value) ? value : `/raw?path=${encodeURIComponent(value)}`),
    )

    expect(result).not.toContain("<base")
    expect(result).toContain('src="/raw?path=figure.png"')
    expect(result).toContain('srcset="/raw?path=small.png 1x, /raw?path=large.png 2x"')
    expect(result).toContain('srcset="/raw?path=figure.png 1x, /raw?path=figure%402x.png 2x"')
    expect(result).toContain('poster="/raw?path=poster.jpg"')
    expect(result).toContain('src="/raw?path=captions.vtt"')
    expect(result).toContain('data="/raw?path=appendix.pdf"')
    expect(result).toContain('href="/raw?path=plot.svg"')
  })

  test("does not split embedded data srcsets or rewrite remote URLs", () => {
    const source = '<img src="https://example.com/a.png" srcset="data:image/svg+xml,%3Csvg%3E 1x">'
    const result = rewriteHtmlAssets(source, (value) => (/^https?:/i.test(value) ? value : `/raw?path=${value}`))

    expect(result).toContain('src="https://example.com/a.png"')
    expect(result).toContain('srcset="data:image/svg+xml,%3Csvg%3E 1x"')
  })

  test("rewrites inline CSS URLs and authenticated local stylesheets", () => {
    const stylesheets = new Map([
      [
        "styles/paper.css",
        '@import "theme/base.css"; .plot { background: url(../figures/plot.png) } .remote { mask: url("https://example.com/mask.svg") }',
      ],
    ])
    const result = rewriteHtmlAssets(
      `<html><head>
        <link rel="alternate stylesheet" href="styles/paper.css" media="print">
        <style>.hero { background-image: url("figures/hero.png") }</style>
      </head><body style="cursor: url(cursors/pointer.cur), auto"></body></html>`,
      (value) => (/^(?:https?:|data:|#)/i.test(value) ? value : `/html?path=${encodeURIComponent(value)}`),
      {
        stylesheets,
        resolveStylesheet: (sheet, value) =>
          /^(?:https?:|data:|#)/i.test(value)
            ? value
            : `/css?sheet=${encodeURIComponent(sheet)}&path=${encodeURIComponent(value)}`,
      },
    )

    expect(result).not.toContain("<link")
    expect(result).toContain('<style media="print">')
    expect(result).toContain('@import "/css?sheet=styles%2Fpaper.css&path=theme%2Fbase.css"')
    expect(result).toContain("url(/css?sheet=styles%2Fpaper.css&path=..%2Ffigures%2Fplot.png)")
    expect(result).toContain('url("https://example.com/mask.svg")')
    expect(result).toContain('url("/html?path=figures%2Fhero.png")')
    expect(result).toContain("url(/html?path=cursors%2Fpointer.cur)")
  })

  test("falls back to a raw stylesheet URL when its authenticated text read is unavailable", () => {
    const result = rewriteHtmlAssets(
      '<link rel="stylesheet" href="styles/missing.css">',
      (value) => `/raw?path=${encodeURIComponent(value)}`,
    )

    expect(result).toContain('href="/raw?path=styles%2Fmissing.css"')
  })

  test("discovers and loads unique stylesheets in bounded concurrent batches", async () => {
    const source = Array.from(
      { length: HTML_STYLESHEET_LIMIT + 3 },
      (_, index) => `<link rel="stylesheet" href="sheet-${index}.css">`,
    ).join("")
    const active = { value: 0, maximum: 0 }
    const loaded = await loadHtmlStylesheets(source, async (href) => {
      active.value += 1
      active.maximum = Math.max(active.maximum, active.value)
      await Promise.resolve()
      active.value -= 1
      return href === "sheet-2.css" ? undefined : `/* ${href} */`
    })

    expect(htmlStylesheets(`${source}<link rel="stylesheet" href="sheet-0.css">`)).toHaveLength(
      HTML_STYLESHEET_LIMIT + 3,
    )
    expect(loaded.size).toBe(HTML_STYLESHEET_LIMIT - 1)
    expect(loaded.has("sheet-2.css")).toBe(false)
    expect(loaded.has(`sheet-${HTML_STYLESHEET_LIMIT}.css`)).toBe(false)
    expect(active.maximum).toBe(4)
  })

  test("loads and inlines nested imports with assets relative to the imported stylesheet", async () => {
    const files = new Map([
      ["styles/paper.css", '@import "theme/base.css"; .paper { background: url(images/paper.png) }'],
      ["styles/theme/base.css", '.theme { mask: url("../icons/star.svg") }'],
    ])
    const path = (stylesheet: string, value: string) => {
      const url = new URL(value, `https://preview.invalid/${stylesheet}`)
      return url.pathname.slice(1)
    }
    const source = '<link rel="stylesheet" href="styles/paper.css">'
    const stylesheets = await loadHtmlStylesheets(
      source,
      async (href) => files.get(href),
      () => true,
      path,
    )
    const result = rewriteHtmlAssets(source, (value) => `/page/${value}`, {
      stylesheets,
      resolveStylesheetPath: path,
      resolveStylesheet: (stylesheet, value) => `/raw/${path(stylesheet, value)}`,
    })

    expect(cssStylesheets(files.get("styles/paper.css")!)).toEqual(["theme/base.css"])
    expect(stylesheets.size).toBe(2)
    expect(result).not.toContain("@import")
    expect(result).toContain('url("/raw/styles/icons/star.svg")')
    expect(result).toContain("url(/raw/styles/images/paper.png)")
  })

  test("keeps embedded and remote CSS references byte-for-byte stable", () => {
    const css = '.a{background:url(data:image/svg+xml,%3Csvg%20viewBox="0 0 1 1"%3E)} .b{mask:url(#mask)}'
    expect(rewriteCssAssets(css, (value) => (/^(?:data:|#)/i.test(value) ? value : `/raw?path=${value}`))).toBe(css)
  })
})
