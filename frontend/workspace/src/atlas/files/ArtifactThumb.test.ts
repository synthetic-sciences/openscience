import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/files/ArtifactThumb.tsx") as Promise<typeof import("./ArtifactThumb")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Loading a shiki grammar takes longer than a microtask and longer on a cold
// machine than a warm one, so the real-highlighter test waits for the condition
// rather than for a duration it would have to guess at.
const waitFor = async <T>(read: () => T | null | undefined, timeout = 15_000) => {
  const until = Date.now() + timeout
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > until) return undefined
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

let versions = 0
const artifact = (over: { filename: string; mimeType?: string; size?: number }) =>
  ({
    schemaVersion: 1,
    id: "art_1",
    projectID: "prj_1",
    title: over.filename,
    kind: "file",
    currentVersionID: "ver_1",
    createdAt: 0,
    updatedAt: 0,
    state: "active",
    versionCount: 1,
    current: {
      id: `ver_${(versions += 1)}`,
      artifactID: "art_1",
      version: 1,
      filename: over.filename,
      mimeType: over.mimeType ?? "application/octet-stream",
      size: over.size ?? 100,
      sha256: "abc",
      sessionID: "ses_1",
      sourcePath: `/tmp/${over.filename}`,
      captureQuality: "exact",
      createdAt: 0,
    },
  }) as never

describe("artifact thumbnail", () => {
  test("renders an image against the raw URL and defers its load", () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "fit.png", mimeType: "image/png" }),
        url: () => "http://local/raw",
        read: async () => "",
      }),
    )
    const image = host.querySelector("img")

    expect(image?.getAttribute("src")).toBe("http://local/raw")
    expect(image?.getAttribute("loading")).toBe("lazy")
  })

  // artifactUrl yields "" when no builder exists, which resolves to the current
  // document -- without onError that renders the browser's broken-image glyph.
  test("falls back to the extension when the image cannot be served", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "fit.png", mimeType: "image/png" }),
        url: () => "",
        read: async () => "",
      }),
    )
    host.querySelector("img")!.dispatchEvent(new Event("error"))
    await settle()

    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("png")
  })

  test("shows the first ten lines, tinted", async () => {
    const body = Array.from({ length: 20 }, (unused, index) => `line ${index}`).join("\n")
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        url: () => "",
        read: async () => body,
        highlight: async (code) => `<span class="tinted">${code}</span>`,
      }),
    )
    await settle()

    expect(host.querySelector(".tinted")?.textContent).toContain("line 0")
    expect(host.querySelector(".tinted")?.textContent).toContain("line 9")
    expect(host.querySelector(".tinted")?.textContent).not.toContain("line 10")
  })

  // The rule the Compute strip established: a degraded tile, never an error page.
  test("falls back to the extension when the read fails", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        url: () => "",
        read: async () => {
          throw new Error("gone")
        },
      }),
    )
    await settle()

    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("py")
  })

  test("falls back to plain text when highlighting fails", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        url: () => "",
        read: async () => "import numpy",
        highlight: async () => {
          throw new Error("no grammar")
        },
      }),
    )
    await settle()

    expect(host.querySelector("[data-thumb-text]")?.textContent).toContain("import numpy")
  })

  test("does not read an artifact past the preview limit", async () => {
    let reads = 0
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "huge.md", mimeType: "text/markdown", size: 70_000 }),
        url: () => "",
        read: async () => {
          reads += 1
          return "never"
        },
      }),
    )
    await settle()

    expect(reads).toBe(0)
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("md")
  })

  // Every other test injects `highlight`, which would let a wrong export name or
  // a wrong module specifier pass the suite and fail only in a browser. This one
  // runs the real shared highlighter, so the wiring itself is under test.
  test("tints with the shared highlighter when none is injected", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        url: () => "",
        read: async () => 'import numpy as np\nname = "x"\n',
      }),
    )

    const tinted = await waitFor(() => host.querySelector("[data-thumb-text] span[style*='--syntax-']"))

    expect(tinted).toBeTruthy()
    expect(host.querySelector("[data-thumb-text]")?.textContent).toContain("import numpy as np")
  }, 20_000)
})
