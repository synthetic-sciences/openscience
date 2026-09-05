import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { decodeCodeBlockEntities, highlightSnippet, registerOpenScienceDiffTheme, retryable } from "./marked"
import { markdownFallback } from "../components/markdown"

const source = await readFile(new URL("./marked.tsx", import.meta.url), "utf8")

describe("markdown runtime loading", () => {
  test("registers the OpenScience theme before first-use highlighting", async () => {
    const html = await highlightSnippet("const result = 42", "javascript")

    expect(html).toContain("result")
    expect(html).toContain("var(--syntax-keyword)")
    expect(html).toContain("<span")
  })

  test("registers each diff runtime only once", () => {
    let registrations = 0
    const registerCustomTheme = () => registrations++

    registerOpenScienceDiffTheme({ registerCustomTheme })
    registerOpenScienceDiffTheme({ registerCustomTheme })

    expect(registrations).toBe(1)
  })

  test("retries a transient chunk failure instead of poisoning the app lifetime", async () => {
    let attempts = 0
    const load = retryable(async () => {
      attempts++
      if (attempts === 1) throw new Error("stale chunk")
      return "loaded"
    })

    expect(load()).rejects.toThrow("stale chunk")
    expect(await load()).toBe("loaded")
    expect(await load()).toBe("loaded")
    expect(attempts).toBe(2)
  })

  test("preserves readable escaped source when markdown parsing fails", () => {
    expect(markdownFallback("Result <unsafe>\nTry 'again'")).toBe(
      '<p data-markdown-fallback="true">Result &lt;unsafe&gt;<br>Try &#39;again&#39;</p>',
    )
  })

  test("decodes one code-entity layer without double-unescaping nested input", () => {
    expect(decodeCodeBlockEntities("&lt;tag&gt; &amp; &quot;text&quot; &#39;value&#39;")).toBe(`<tag> & "text" 'value'`)
    expect(decodeCodeBlockEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;")
    expect(decodeCodeBlockEntities("&amp;quot; &amp;#39; &amp;amp;")).toBe("&quot; &#39; &amp;")
  })
})
