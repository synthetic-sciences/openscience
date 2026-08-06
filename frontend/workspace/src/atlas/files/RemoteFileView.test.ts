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

const props = (over: Record<string, unknown> = {}) => ({
  file: { name: "notes.md", path: "notes.md", volume: "weights", size: 12 },
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

  // The route answers with Content-Disposition: attachment, which a browser may
  // honour by downloading rather than rendering, so bytes go through a blob.
  test("renders an image from a blob rather than the route", async () => {
    const host = mount(() =>
      subject.RemoteFileView(
        props({
          file: { name: "fit.png", path: "fit.png", volume: "weights", size: 40 },
          read: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        }) as never,
      ),
    )
    await settle()

    expect(host.querySelector("[data-remote-image]")?.getAttribute("src")).toStartWith("blob:")
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
})
