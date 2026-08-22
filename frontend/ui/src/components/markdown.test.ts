import { describe, test, expect } from "bun:test"
import katex from "katex"
import { openFileLink, resolveFileLinks, resolveImages, sanitize } from "./markdown"

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

  test("regression guard: still strips script-injection attributes across every node (sanitizer stays active)", () => {
    const safe = sanitize("<img src=x onerror=alert(1)><img src=y onerror=alert(2)><script>evil()</script>")
    expect(safe).not.toContain("onerror")
    expect(safe).not.toContain("<script")
  })

  test("regression guard: neutralizes payloads nested in the annotation-xml HTML integration point (#194)", () => {
    const safe = sanitize(
      '<math><semantics><annotation-xml encoding="text/html"><img src=x onerror=alert(1)><script>evil()</script></annotation-xml></semantics></math>',
    )
    expect(safe).not.toContain("onerror")
    expect(safe).not.toContain("<script")
  })
})

describe("resolveImages (relative image rewriting)", () => {
  const resolve = (src: string) =>
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(src)
      ? src
      : `http://127.0.0.1:4096/file/raw?path=${encodeURIComponent(src)}`

  test("rewrites relative sources on already-sanitized markup", () => {
    const root = document.createElement("div")
    root.innerHTML = sanitize('<p>fig</p><img src="figures/plot.png" onerror="alert(1)" alt="plot">')

    resolveImages(root, resolve)

    const img = root.querySelector("img")
    expect(img?.getAttribute("src")).toBe("http://127.0.0.1:4096/file/raw?path=figures%2Fplot.png")
    expect(img?.getAttribute("alt")).toBe("plot")
    // sanitization already ran — script-injection attributes stay stripped
    expect(img?.getAttribute("onerror")).toBeNull()
  })

  test("leaves absolute and data URLs untouched", () => {
    const root = document.createElement("div")
    root.innerHTML = sanitize('<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">')

    resolveImages(root, resolve)

    const sources = Array.from(root.querySelectorAll("img")).map((img) => img.getAttribute("src"))
    expect(sources).toEqual(["https://example.com/a.png", "data:image/png;base64,AAAA"])
  })
})

describe("local Markdown file links", () => {
  test("opens relative and absolute PDF/file anchors in-app", () => {
    const root = document.createElement("div")
    root.innerHTML = sanitize(`
      <a href="appendix.pdf" class="external-link" target="_blank" rel="noopener noreferrer"><span>Appendix</span></a>
      <a href="/Users/research/CERBench/results/table.csv" class="external-link" target="_blank">Table</a>
    `)
    resolveFileLinks(root, (href) => (href.startsWith("/") ? href : `papers/${href}`))

    const links = root.querySelectorAll("a")
    expect(links[0].getAttribute("data-file-path")).toBe("papers/appendix.pdf")
    expect(links[1].getAttribute("data-file-path")).toBe("/Users/research/CERBench/results/table.csv")
    expect(Array.from(links).every((link) => !link.hasAttribute("target"))).toBe(true)
    expect(Array.from(links).every((link) => !link.classList.contains("external-link"))).toBe(true)

    const opened: string[] = []
    root.addEventListener("click", (event) => openFileLink(root, event as MouseEvent, (path) => opened.push(path)))
    expect(
      links[0].querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    ).toBe(false)
    expect(links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(false)
    expect(opened).toEqual(["papers/appendix.pdf", "/Users/research/CERBench/results/table.csv"])
  })

  test("preserves http(s) and mailto anchors as external browser links", () => {
    const root = document.createElement("div")
    root.innerHTML = sanitize(`
      <a href="https://example.com/paper.pdf" class="external-link" target="_blank" rel="noopener noreferrer">Web</a>
      <a href="mailto:author@example.com" class="external-link" target="_blank" rel="noopener noreferrer">Email</a>
    `)
    resolveFileLinks(root, (href) => (/^(?:https?:|mailto:)/i.test(href) ? undefined : href))

    const links = root.querySelectorAll("a")
    expect(Array.from(links).map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/paper.pdf",
      "mailto:author@example.com",
    ])
    expect(Array.from(links).every((link) => link.getAttribute("target") === "_blank")).toBe(true)
    expect(Array.from(links).every((link) => link.classList.contains("external-link"))).toBe(true)
    expect(Array.from(links).every((link) => !link.hasAttribute("data-file-link"))).toBe(true)
  })

  test("keeps only safe new-tab targets and hardens their opener relationship", () => {
    const safe = sanitize(`
      <a href="https://example.com" target="_blank">Safe</a>
      <a href="https://example.com/profile" target="named-window">Named</a>
    `)
    const root = document.createElement("div")
    root.innerHTML = safe
    const links = root.querySelectorAll("a")

    expect(links[0].getAttribute("target")).toBe("_blank")
    expect(new Set((links[0].getAttribute("rel") ?? "").split(/\s+/))).toEqual(new Set(["noopener", "noreferrer"]))
    expect(links[1].hasAttribute("target")).toBe(false)
  })
})
