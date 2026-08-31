import { describe, expect, test } from "bun:test"
import { describeFile } from "./file-viewer"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("file preview markdown images", () => {
  test("markdown previews resolve relative images through the raw-file endpoint", async () => {
    const preview = await read("./FilePreview.tsx")

    expect(preview).toContain('import { assetUrl, localAssetPath } from "@/utils/markdown-assets"')
    expect(preview).toContain("base: resolvedPath()")
    expect(preview).toContain("url: (path) =>")
    expect(preview).toContain(
      "rawFileQuery({ directory: dir, path, sessionID: session, scope: resolvedScope(), inline: true })",
    )
    expect(preview).toContain("const activeSessionID = () =>")
    expect(preview).toContain('resolvedScope() === "session"')
    expect(preview).toContain("resolveImage={image}")
    expect(preview).toContain("resolveFile={file}")
    expect(preview).toContain("onOpenFile={openFile}")
  })

  test("markdown previews resolve file links relative to the document before opening the authenticated viewer", async () => {
    const preview = await read("./FilePreview.tsx")
    const manuscript = await read("../manuscript/ManuscriptWorkbench.tsx")

    expect(preview).toContain('import { assetUrl, localAssetPath } from "@/utils/markdown-assets"')
    expect(preview).toContain("const file = (href: string) => localAssetPath(href, resolvedPath())")
    expect(preview).toContain("resolveFile={file}")
    expect(manuscript).toContain("const file = (href: string) => localAssetPath(href, props.path)")
    expect(manuscript).toContain("text={preview()} resolveFile={file} onOpenFile={openFile}")
  })

  test("ordinary Markdown remains readable and editable through the existing save path", async () => {
    const preview = await read("./FilePreview.tsx")
    const css = await read("./FilePreview.css")

    expect(preview).toContain('sourceLabel={description().source && writable() !== false ? "Edit" : undefined}')
    expect(preview).toContain('import { CodeEditor } from "@/atlas/CodeEditor"')
    expect(preview).toContain("label={`${name()} source`}")
    expect(preview).toContain('wrap={kind() === "markdown"}')
    expect(preview).toContain("void save()")
    expect(css).toContain(".atlas-code-editor .cm-editor")
    expect(css).toContain("text-wrap: pretty")
    expect(css).toContain("text-wrap: balance")
  })

  test("README alignment wrappers keep their inner Markdown parsed and sanitized", async () => {
    const preview = await read("./FilePreview.tsx")
    const css = await read("./FilePreview.css")

    expect(preview).toContain('import { splitAlignedMarkdown } from "@/atlas/FilePreviewMarkdown"')
    expect(preview).toContain("data-align={lead().alignment}")
    expect(preview).toContain("text={lead().text}")
    expect(preview).toContain("text={rest()}")
    expect(css).toContain('.atlas-file-document-lead[data-align="center"]')
    expect(css).toContain("p:has(a > img)")
  })

  test("chat markdown resolves images against the project root via the shared context", async () => {
    const layout = await read("../pages/directory-layout.tsx")

    expect(layout).toContain('import { MarkdownImages } from "@synsci/ui/markdown"')
    expect(layout).toContain("rawFileQuery({")
    expect(layout).toContain("directory: directory()")
    expect(layout).toContain("<MarkdownImages resolve={image} resolveFile={file} openFile={openFile}>")
  })

  test("the shared renderer rewrites image sources only after DOMPurify sanitization", async () => {
    const markdown = await read("../../../ui/src/components/markdown.tsx")

    const sanitized = markdown.indexOf("(next) => sanitize(next)")
    const resolved = markdown.indexOf("if (resolve) resolveImages(temp, resolve)")
    expect(sanitized).toBeGreaterThan(-1)
    expect(resolved).toBeGreaterThan(sanitized)
  })
})

describe("file preview sandboxed html", () => {
  test("html files render inside a fully sandboxed iframe with a Source toggle", async () => {
    const preview = await read("./FilePreview.tsx")

    expect(preview).toContain('if (common().kind === "html") return "html"')
    expect(preview).toContain('sandbox=""')
    expect(preview).toContain("rewriteHtmlAssets")
    expect(preview).toContain('from "@/utils/html-assets"')
    expect(preview).toContain("srcdoc={html()}")
    expect(preview).toContain("loadHtmlStylesheets(")
    expect(preview).toContain("HTML_STYLESHEET_BYTES")
    expect(preview).toContain("resolveStylesheet:")
    expect(preview).toContain('<Match when={kind() === "html" && !view.source}>')
    // sandbox must stay fully locked down — never allow scripts or same-origin
    expect(preview).not.toContain("allow-scripts")
    expect(preview).not.toContain("allow-same-origin")
  })

  test("the iframe fills the pane", async () => {
    const css = await read("./FilePreview.css")

    expect(css).toContain(".atlas-file-html-frame")
    expect(css).toContain("min-height: 480px")
  })

  test("html documents expose the Preview/Source two-state control", () => {
    expect(describeFile({ kind: "html", format: "html" })).toEqual({
      label: "HTML document",
      source: true,
      copy: true,
      download: true,
    })
  })

  test("stale full-PDF and stylesheet reads are actively cancelled when the file changes", async () => {
    const preview = await read("./FilePreview.tsx")

    expect(preview).toContain("pdfAbort.current?.abort()")
    expect(preview).toContain("htmlAbort.current?.abort()")
    expect(preview).toContain("{ signal: controller.signal }")
    expect(preview).toContain("controller.signal.aborted")
  })

  test("a transient primary read keeps the last valid preview while retrying with bounded backoff", async () => {
    const preview = await read("./FilePreview.tsx")

    expect(preview).toContain('readyKey === key && view.status === "ready" && view.data')
    expect(preview).toContain(
      'untrack(() => readyOwner === location && readyKey === key && view.status === "ready" && view.data)',
    )
    expect(preview).toContain("fileReadRetryDelay(readRetry.count)")
    expect(preview).toContain("File preview transport remained interrupted after bounded retries")
    expect(preview).not.toContain("queueMicrotask(() =>")
  })
})
