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
  server.ssrLoadModule("/src/atlas/files/FileTabs.tsx") as Promise<typeof import("./FileTabs")>,
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

describe("file tabs", () => {
  test("always offers the Files tab and marks the active one", () => {
    const host = mount(() =>
      subject.FileTabs({ open: ["train_lr.py"], active: "files", onSelect: () => {}, onClose: () => {} }),
    )

    expect(host.querySelector('[data-tab="files"]')?.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector('[data-tab="train_lr.py"]')?.getAttribute("aria-selected")).toBe("false")
  })

  test("selecting and closing report separately, and closing does not select", () => {
    const picked: string[] = []
    const closed: string[] = []
    const host = mount(() =>
      subject.FileTabs({
        open: ["train_lr.py"],
        active: "files",
        onSelect: (id) => picked.push(id),
        onClose: (id) => closed.push(id),
      }),
    )

    host.querySelector<HTMLButtonElement>('[data-tab="train_lr.py"]')?.click()
    host.querySelector<HTMLButtonElement>('[data-tab-close="train_lr.py"]')?.click()

    expect(picked).toEqual(["train_lr.py"])
    expect(closed).toEqual(["train_lr.py"])
  })

  test("truncates a long filename in the middle so the extension survives", () => {
    const host = mount(() =>
      subject.FileTabs({
        open: ["modal_env_parser_test.ipynb"],
        active: "modal_env_parser_test.ipynb",
        onSelect: () => {},
        onClose: () => {},
      }),
    )
    const label = host.querySelector('[data-tab="modal_env_parser_test.ipynb"] [data-tab-label]')?.textContent ?? ""

    expect(label).toContain("…")
    expect(label.endsWith(".ipynb")).toBe(true)
    expect(label.length).toBeLessThan("modal_env_parser_test.ipynb".length)
  })
})
