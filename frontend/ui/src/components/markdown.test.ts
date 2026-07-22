import { describe, test, expect } from "bun:test"
import katex from "katex"
import { sanitize } from "./markdown"

const tex = "\\delta\\omega/\\omega < 10^{-6}"

describe("sanitize (KaTeX MathML annotation)", () => {
  test("keeps the <annotation> wrapper so raw TeX doesn't leak as visible text", () => {
    const katexHtml = katex.renderToString(tex, { throwOnError: false })
    const safe = sanitize(katexHtml)
    expect(safe).toContain("<annotation")
  })

  test("the TeX source appears only inside <annotation>, not as a bare child of <math>", () => {
    const katexHtml = katex.renderToString(tex, { throwOnError: false })
    const safe = sanitize(katexHtml)

    const doc = new DOMParser().parseFromString(safe, "text/html")
    const math = doc.querySelector("math")
    expect(math).not.toBeNull()

    // No direct text-node child of <math> should carry the raw TeX source.
    const bareLeak = Array.from(math?.childNodes ?? []).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").includes(tex),
    )
    expect(bareLeak).toBe(false)

    // The TeX source must actually be present, but only inside <annotation>.
    const annotation = doc.querySelector("annotation")
    expect(annotation).not.toBeNull()
    expect(annotation?.textContent).toContain(tex)
  })

  test("regression guard: still strips script-injection attributes (sanitizer stays active)", () => {
    const safe = sanitize('<img src=x onerror=alert(1)>')
    expect(safe).not.toContain("onerror")
  })
})
