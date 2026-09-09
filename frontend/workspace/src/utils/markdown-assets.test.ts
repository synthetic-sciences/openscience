import { describe, expect, test } from "bun:test"
import {
  alignLoopbackAssetHost,
  assetUrl,
  chatFilePath,
  localAssetPath,
  resolvePath,
  workspaceAssetPath,
  workspaceReceiptPath,
} from "./markdown-assets"

const raw = (path: string) => `http://127.0.0.1:4096/file/raw?path=${encodeURIComponent(path)}&project=prj_1`

describe("markdown asset resolution", () => {
  test("exact completed receipts preserve filesystem bytes without broadening raw Markdown links", () => {
    for (const path of [
      "/research/note.md",
      "/session-scratch/note.md",
      "/connected/note%20#?.md",
      "C:\\Research\\note.md",
    ]) {
      expect(workspaceReceiptPath(path)).toBe(path)
    }
    for (const path of ["note.md", "https://example.com/note.md", "file:///private/note.md", "/bad\0path.md"]) {
      expect(workspaceReceiptPath(path)).toBeUndefined()
    }
    expect(workspaceAssetPath("/session-scratch/note.md", "/research")).toBeUndefined()
    expect(workspaceAssetPath("/connected/note.md", "/research")).toBeUndefined()
  })

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

  test("keeps chat links inside the active workspace authority", () => {
    expect(workspaceAssetPath("results/table.csv", "/work/project")).toBe("results/table.csv")
    expect(workspaceAssetPath("/work/project/results/table.csv", "/work/project")).toBe(
      "/work/project/results/table.csv",
    )
    expect(workspaceAssetPath("/work/project-old/results/table.csv", "/work/project")).toBeUndefined()
    expect(workspaceAssetPath("/private/tmp/scan_external.py", "/work/project")).toBeUndefined()
    expect(
      assetUrl("/private/tmp/generated.png", {
        root: "/work/project",
        url: raw,
      }),
    ).toBe("/private/tmp/generated.png")
  })

  test("opens conversation links to scratch, connected and served files in the Files tab", () => {
    const root = "/work/project"
    const origin = "http://localhost:4096"
    expect(chatFilePath("results/table.csv", root, origin)).toBe("results/table.csv")
    expect(chatFilePath("/work/project/results/table.csv", root, origin)).toBe("/work/project/results/table.csv")
    // Session scratch and connected folders live outside the project; the
    // backend authorizes the read, the link must not become a localhost page.
    expect(chatFilePath("/Users/me/.openscience/scratch/46411193/report.md", root, origin)).toBe(
      "/Users/me/.openscience/scratch/46411193/report.md",
    )
    expect(chatFilePath("C:\\data\\report.md", root, origin)).toBe("C:/data/report.md")
    expect(chatFilePath("file:///Users/me/data/report.md", root, origin)).toBe("/Users/me/data/report.md")
    // The UI's own served-file route, echoed back by a model.
    expect(chatFilePath("/file/raw?path=%2Fwork%2Fproject%2Fout.png&project=prj_1", root, origin)).toBe(
      "/work/project/out.png",
    )
    expect(chatFilePath(raw("/tmp/out/report.md"), root, origin)).toBe("/tmp/out/report.md")
    expect(chatFilePath("http://localhost:4096/file/raw?path=%2Ftmp%2Fa.md", root, origin)).toBe("/tmp/a.md")
    // Genuine web links stay in the browser.
    expect(chatFilePath("https://example.com/file/raw?path=%2Fetc%2Fpasswd", root, origin)).toBeUndefined()
    expect(chatFilePath("https://doi.org/10.1000/xyz", root, origin)).toBeUndefined()
    expect(chatFilePath("mailto:team@example.com", root, origin)).toBeUndefined()
    expect(chatFilePath("#section", root, origin)).toBeUndefined()
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
