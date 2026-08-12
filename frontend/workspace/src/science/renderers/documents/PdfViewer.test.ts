import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("PDF preview workbench", () => {
  test("fits the actual resizable preview width and rerenders through ResizeObserver", async () => {
    const source = await read("./PdfViewer.tsx")
    const css = await read("./PdfViewer.css")

    expect(source).toContain("new ResizeObserver")
    expect(source).toContain("entry?.contentRect.width")
    expect(source).not.toContain("getBoundingClientRect")
    expect(source).toContain('zoom: "fit"')
    expect(source).toContain('value === "fit" ? view.fitScale : value')
    expect(source).toContain('view.zoom === "fit" ? fitScale : (view.zoom as number)')
    expect(source).toContain('"Fit page width selected" : "Fit page width"')
    expect(css).toContain("container: pdf-viewer / inline-size")
    expect(css).toContain("@container pdf-viewer (max-width: 520px)")
  })

  test("owns scrolling and exposes page and zoom controls with accessible targets", async () => {
    const source = await read("./PdfViewer.tsx")
    const css = await read("./PdfViewer.css")

    expect(source).toContain('aria-label="Previous page"')
    expect(source).toContain('aria-label="Next page"')
    expect(source).toContain('aria-label="Zoom out"')
    expect(source).toContain('aria-label="Zoom in"')
    expect(source).toContain('behavior: "auto"')
    expect(css).toMatch(/\.pdf-viewer-body\s*\{[^}]*overflow: auto/s)
    expect(css).toContain("min-width: 32px")
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-width: 44px/s)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })

  test("retains bounded rendering and safe pdfjs cleanup", async () => {
    const source = await read("./PdfViewer.tsx")

    expect(source).toContain("Math.min(total, cfg.maxPages)")
    expect(source).toContain("loadingTask?.destroy?.().catch?.")
    expect(source).toContain("cancelTasks()")
    expect(source).toContain("pdfjs-dist/legacy/build/pdf.mjs")
  })
})
