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
const subject = (await server.ssrLoadModule("/src/atlas/files/RemoteFileView.tsx")) as typeof import("./RemoteFileView")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
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

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

let unique = 0
const props = (over: Record<string, unknown> = {}) => ({
  file: { name: "notes.md", path: `notes-${(unique += 1)}.md`, volume: "weights", size: 12 },
  read: async () => new Blob(["# Objective"], { type: "text/markdown" }),
  onDownload: () => {},
  onClose: () => {},
  highlight: async (code: string) => `<span class="tinted">${code}</span>`,
  ...over,
})

describe("remote file view", () => {
  test("renders text it fetched, tinted", async () => {
    const host = mount(() => subject.RemoteFileView(props() as never))
    await settle()

    expect(host.querySelector("[data-remote-text]")?.textContent).toContain("# Objective")
    expect(host.querySelector(".tinted")).not.toBeNull()
  })

  test("falls back to plain text when highlighting fails", async () => {
    const host = mount(() =>
      subject.RemoteFileView(
        props({
          highlight: async () => {
            throw new Error("no grammar")
          },
        }) as never,
      ),
    )
    await settle()

    expect(host.querySelector("[data-remote-text]")?.textContent).toContain("# Objective")
  })

  // The app's CSP is img-src 'self' data: https: -- no blob: -- so an image
  // rendered from a blob: URL never decodes. Verified in the running app: the
  // same PNG loads as data: and fails as blob:.
  test("renders an image from a data URL, which the CSP allows", async () => {
    const host = mount(() =>
      subject.RemoteFileView(
        props({
          file: { name: "fit.png", path: "fit.png", volume: "weights", size: 40 },
          read: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        }) as never,
      ),
    )
    await settle()

    expect(host.querySelector("[data-remote-image]")?.getAttribute("src")).toStartWith("data:image/png")
  })

  // frame-src does allow blob:, so a PDF keeps it -- but the bytes arrive as
  // application/octet-stream, and an <iframe> handed that downloads the file
  // instead of displaying it.
  test("renders a PDF from a blob typed as a PDF", async () => {
    let seen: string | undefined
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob: Blob) => {
      seen = (blob as Blob).type
      return create(blob)
    }
    try {
      const host = mount(() =>
        subject.RemoteFileView(
          props({
            file: { name: "paper.pdf", path: "paper.pdf", volume: "weights", size: 40 },
            read: async () => new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/octet-stream" }),
          }) as never,
        ),
      )
      await settle()

      expect(seen).toBe("application/pdf")
      expect(host.querySelector("[data-remote-pdf]")?.getAttribute("src")).toStartWith("blob:")
    } finally {
      URL.createObjectURL = create
    }
  })

  test("offers download instead of guessing at a format it cannot render", async () => {
    let reads = 0
    const host = mount(() =>
      subject.RemoteFileView(
        props({
          file: { name: "model.safetensors", path: "model.safetensors", volume: "weights", size: 40 },
          read: async () => {
            reads += 1
            return new Blob([""])
          },
        }) as never,
      ),
    )
    await settle()

    expect(host.querySelector("[data-remote-unsupported]")).not.toBeNull()
    // Nothing is pulled out of the cloud for a file that will not be shown.
    expect(reads).toBe(0)
    expect(host.querySelector("[data-remote-download]")).not.toBeNull()
  })

  test("does not fetch a file too large to preview", async () => {
    let reads = 0
    const host = mount(() =>
      subject.RemoteFileView(
        props({
          file: { name: "huge.json", path: "huge.json", volume: "weights", size: 900 * 1024 * 1024 },
          read: async () => {
            reads += 1
            return new Blob([""])
          },
        }) as never,
      ),
    )
    await settle()

    expect(reads).toBe(0)
    expect(host.querySelector("[data-remote-unsupported]")).not.toBeNull()
  })

  test("says so when the bytes cannot be read, and still offers download", async () => {
    const host = mount(() =>
      subject.RemoteFileView(
        props({
          read: async () => {
            throw new Error("volume unreachable")
          },
        }) as never,
      ),
    )
    await settle()

    expect(host.querySelector("[data-remote-error]")?.textContent).toContain("volume unreachable")
    expect(host.querySelector("[data-remote-download]")).not.toBeNull()
  })

  test("reports download and close to its owner", async () => {
    const events: string[] = []
    const host = mount(() =>
      subject.RemoteFileView(
        props({ onDownload: () => events.push("download"), onClose: () => events.push("close") }) as never,
      ),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-remote-download]")!.click()
    host.querySelector<HTMLButtonElement>('[aria-label="Close notes.md"]')!.click()

    expect(events).toEqual(["download", "close"])
  })

  // Switching tabs unmounts this viewer, so without a cache every switch went
  // back to Modal for bytes already in hand.
  test("does not re-fetch a file it has already pulled down", async () => {
    let reads = 0
    const file = { name: "shared.md", path: "shared.md", volume: "weights", size: 12 }
    const view = () =>
      subject.RemoteFileView(
        props({
          file,
          read: async () => {
            reads += 1
            return new Blob(["# Objective"], { type: "text/markdown" })
          },
        }) as never,
      )

    const first = mount(view)
    await settle()
    expect(first.querySelector("[data-remote-text]")?.textContent).toContain("# Objective")
    expect(reads).toBe(1)

    cleanups.splice(0).forEach((fn) => fn())
    document.body.replaceChildren()

    const second = mount(view)
    await settle()

    expect(second.querySelector("[data-remote-text]")?.textContent).toContain("# Objective")
    expect(reads).toBe(1)
  })

  // A Volume file can change, unlike an artifact version; the size a listing
  // reports is the cheapest signal of that.
  test("fetches again when the file has changed size", async () => {
    let reads = 0
    const read = async () => {
      reads += 1
      return new Blob(["# Objective"], { type: "text/markdown" })
    }
    mount(() =>
      subject.RemoteFileView(
        props({ file: { name: "grew.md", path: "grew.md", volume: "weights", size: 12 }, read }) as never,
      ),
    )
    await settle()
    cleanups.splice(0).forEach((fn) => fn())
    document.body.replaceChildren()

    mount(() =>
      subject.RemoteFileView(
        props({ file: { name: "grew.md", path: "grew.md", volume: "weights", size: 4096 }, read }) as never,
      ),
    )
    await settle()

    expect(reads).toBe(2)
  })
})
