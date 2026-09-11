import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  decodeCodeBlockEntities,
  highlightSnippet,
  LIVE_HIGHLIGHT_LIMIT,
  openFence,
  parseMarkdown,
  plainStreamingFence,
  registerOpenScienceDiffTheme,
  retryable,
} from "./marked"
import { markdownFallback } from "../components/markdown"

const source = await readFile(new URL("./marked.tsx", import.meta.url), "utf8")

describe("markdown runtime loading", () => {
  test("keeps decoded file paths inside the link attribute", async () => {
    const pathname = '/tmp/a"><img src="https://example.test/tracker">&result.txt'
    const html = await parseMarkdown(`[result](file://${encodeURI(pathname).replaceAll('"', "%22")})`)
    const doc = new DOMParser().parseFromString(html, "text/html")
    expect(doc.querySelectorAll("a").length).toBe(1)
    expect(doc.querySelector("a")?.getAttribute("href")).toBe(pathname)
    expect(doc.querySelector("img")).toBeNull()
  })

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

describe("streaming code fences", () => {
  const script = Array.from({ length: 120 }, (_, i) => `def step_${i}(model):\n    return model.train(step=${i})`).join(
    "\n",
  )

  test("finds the fence a response is still inside and the code written so far", () => {
    const open = openFence("Intro\n\n```python\nprint(1)\nprint(2)")
    expect(open?.code).toBe("print(1)\nprint(2)")
    expect("Intro\n\n```python\nprint(1)\nprint(2)".slice(open!.info.start, open!.info.end)).toBe("python")
    expect(openFence("```python\nprint(1)\n```\nDone")).toBeUndefined()
    // A closing fence must match the character and be at least as long.
    expect(openFence("````python\n```\ninner\n")?.code).toBe("```\ninner\n")
    expect(openFence("~~~py\ncode\n```\n")?.code).toBe("code\n```\n")
    // A backtick fence whose info string contains a backtick is not a fence.
    expect(openFence("``` `x`\ntext")).toBeUndefined()
    expect(openFence("plain prose only")).toBeUndefined()
  })

  test("keeps a long, still-open block plain until its fence closes, and leaves everything else alone", () => {
    expect(script.length).toBeGreaterThan(LIVE_HIGHLIGHT_LIMIT)
    const streaming = `Here is the script:\n\n\`\`\`python title="train.py"\n${script}`
    expect(plainStreamingFence(streaming)).toBe(`Here is the script:\n\n\`\`\`text\n${script}`)
    const closed = `${streaming}\n\`\`\`\n`
    expect(plainStreamingFence(closed)).toBe(closed)
    const short = "```python\nprint(1)"
    expect(plainStreamingFence(short)).toBe(short)
  })

  test("renders the streaming block as plain code and highlights it once the fence closes", async () => {
    const streaming = `\`\`\`python\n${script}`
    const live = await parseMarkdown(streaming)
    expect(live).toContain(script.split("\n")[0])
    expect(live).not.toContain("var(--syntax-keyword)")
    const done = await parseMarkdown(`${streaming}\n\`\`\`\n`)
    expect(done).toContain("var(--syntax-keyword)")
  })
})
