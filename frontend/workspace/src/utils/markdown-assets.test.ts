import { describe, expect, test } from "bun:test"
import { alignLoopbackAssetHost, assetUrl, localAssetPath, resolvePath } from "./markdown-assets"

const raw = (path: string) => `http://127.0.0.1:4096/file/raw?path=${encodeURIComponent(path)}&project=prj_1`

describe("markdown asset resolution", () => {
  test("resolves relative references against the previewed file's directory", () => {
    expect(assetUrl("figures/plot.png", { base: "notes/paper.md", url: raw })).toBe(raw("notes/figures/plot.png"))
    expect(assetUrl("./figures/plot.png", { base: "notes/paper.md", url: raw })).toBe(raw("notes/figures/plot.png"))
    expect(assetUrl("../shared/logo.svg", { base: "docs/guide/intro.md", url: raw })).toBe(raw("docs/shared/logo.svg"))
    expect(assetUrl("plot.png", { base: "readme.md", url: raw })).toBe(raw("plot.png"))
  })

  test("resolves against the workspace root when no base file is given", () => {
    expect(assetUrl("results/output.png", { url: raw })).toBe(raw("results/output.png"))
    expect(assetUrl("results/../output.png", { url: raw })).toBe(raw("output.png"))
  })

  test("routes absolute local images through the authenticated raw-file endpoint", () => {
    expect(assetUrl("/Users/research/CERBench/figures/result.png", { url: raw })).toBe(
      raw("/Users/research/CERBench/figures/result.png"),
    )
    expect(assetUrl("file:///Users/research/CERBench/figures/result%20plot.png", { url: raw })).toBe(
      raw("/Users/research/CERBench/figures/result plot.png"),
    )
  })

  test("classifies relative and absolute file anchors without capturing external links", () => {
    expect(localAssetPath("appendix.pdf", "papers/main.md")).toBe("papers/appendix.pdf")
    expect(localAssetPath("../data/results.csv#row-10", "papers/sections/method.md")).toBe("papers/data/results.csv")
    expect(localAssetPath("/Users/research/CERBench/paper.pdf")).toBe("/Users/research/CERBench/paper.pdf")
    expect(localAssetPath("file:///Users/research/CERBench/paper%20draft.pdf")).toBe(
      "/Users/research/CERBench/paper draft.pdf",
    )
    expect(localAssetPath("https://example.com/paper.pdf")).toBeUndefined()
    expect(localAssetPath("mailto:author@example.com")).toBeUndefined()
  })

  test("decodes markdown-encoded references before building the query", () => {
    expect(assetUrl("figures/final%20plot.png", { base: "paper.md", url: raw })).toBe(raw("figures/final plot.png"))
  })

  test("keeps malformed percent-escapes rather than throwing", () => {
    expect(assetUrl("figures/100%.png", { base: "paper.md", url: raw })).toBe(raw("figures/100%.png"))
  })

  test("leaves external, embedded, and anchor references untouched", () => {
    for (const src of [
      "https://example.com/plot.png",
      "http://example.com/plot.png",
      "data:image/png;base64,AAAA",
      "blob:http://127.0.0.1/abcd",
      "//cdn.example.com/plot.png",
      "#section",
      "mailto:someone@example.com",
    ])
      expect(assetUrl(src, { base: "notes/paper.md", url: raw })).toBe(src)
  })

  test("normalizes windows separators and duplicate slashes", () => {
    expect(resolvePath("notes\\paper.md", "figures//plot.png")).toBe("notes/figures/plot.png")
    expect(resolvePath("", "./a/./b.png")).toBe("a/b.png")
    expect(resolvePath("/work/project/notes/paper.md", "../figures/plot.png")).toBe("/work/project/figures/plot.png")
    expect(resolvePath("C:\\work\\project\\notes\\paper.md", "../figures/plot.png")).toBe(
      "C:/work/project/figures/plot.png",
    )
  })

  test("aligns mismatched loopback hostnames without changing the API port or project capability", () => {
    const url = "http://localhost:4096/file/raw?path=assets%2Fwordmark.svg&project=prj_1&directory=%2Fworkspace"

    expect(alignLoopbackAssetHost(url, "http://127.0.0.1:4444")).toBe(
      "http://127.0.0.1:4096/file/raw?path=assets%2Fwordmark.svg&project=prj_1&directory=%2Fworkspace",
    )
    expect(alignLoopbackAssetHost(url, "http://localhost:4444")).toBe(url)
    expect(alignLoopbackAssetHost("https://files.example.com/plot.svg", "http://127.0.0.1:4444")).toBe(
      "https://files.example.com/plot.svg",
    )
  })

  test("applies loopback alignment only to generated project-local asset URLs", () => {
    const localhostRaw = (path: string) =>
      `http://localhost:4096/file/raw?path=${encodeURIComponent(path)}&project=prj_1`

    expect(
      assetUrl("assets/wordmark.svg", {
        base: "README.md",
        url: localhostRaw,
        pageOrigin: "http://127.0.0.1:4444",
      }),
    ).toBe("http://127.0.0.1:4096/file/raw?path=assets%2Fwordmark.svg&project=prj_1")
    expect(
      assetUrl("https://example.com/logo.svg", {
        url: localhostRaw,
        pageOrigin: "http://127.0.0.1:4444",
      }),
    ).toBe("https://example.com/logo.svg")
  })
})
