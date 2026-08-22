import { describe, expect, test } from "bun:test"
import { openFileLink, resolveFileLinks, resolveImages } from "@synsci/ui/markdown"
import { assetUrl, localAssetPath } from "./markdown-assets"

describe("Markdown file-link behavior", () => {
  test("opens relative and absolute PDF/file anchors through the in-app callback", () => {
    const root = document.createElement("div")
    root.innerHTML = `
      <a href="appendix.pdf" class="external-link" target="_blank" rel="noopener noreferrer"><span>Appendix</span></a>
      <a href="/Users/research/CERBench/results/table.csv" class="external-link" target="_blank">Table</a>
    `
    resolveFileLinks(root, (href) => localAssetPath(href, "papers/main.md"))

    const links = root.querySelectorAll("a")
    expect(links[0].getAttribute("data-file-path")).toBe("papers/appendix.pdf")
    expect(links[1].getAttribute("data-file-path")).toBe("/Users/research/CERBench/results/table.csv")
    expect(Array.from(links).every((link) => !link.hasAttribute("target"))).toBe(true)

    const opened: string[] = []
    root.addEventListener("click", (event) => openFileLink(root, event, (path) => opened.push(path)))
    links[0].querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

    expect(opened).toEqual(["papers/appendix.pdf", "/Users/research/CERBench/results/table.csv"])
  })

  test("keeps web and email anchors external", () => {
    const root = document.createElement("div")
    root.innerHTML = `
      <a href="https://example.com/paper.pdf" class="external-link" target="_blank" rel="noopener noreferrer">Web</a>
      <a href="mailto:author@example.com" class="external-link" target="_blank" rel="noopener noreferrer">Email</a>
    `
    resolveFileLinks(root, (href) => localAssetPath(href, "papers/main.md"))

    const links = root.querySelectorAll("a")
    expect(Array.from(links).map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/paper.pdf",
      "mailto:author@example.com",
    ])
    expect(Array.from(links).every((link) => link.getAttribute("target") === "_blank")).toBe(true)
    expect(Array.from(links).every((link) => link.classList.contains("external-link"))).toBe(true)
    expect(Array.from(links).every((link) => !link.hasAttribute("data-file-link"))).toBe(true)
  })

  test("rewrites an absolute local Markdown image to the authenticated raw-file route", () => {
    const root = document.createElement("div")
    root.innerHTML = '<img src="/Users/research/CERBench/figures/result.png" alt="result">'
    resolveImages(root, (src) =>
      assetUrl(src, {
        url: (path) => `/file/raw?path=${encodeURIComponent(path)}&sessionID=ses_1&project=prj_1`,
      }),
    )

    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      "/file/raw?path=%2FUsers%2Fresearch%2FCERBench%2Ffigures%2Fresult.png&sessionID=ses_1&project=prj_1",
    )
  })
})
