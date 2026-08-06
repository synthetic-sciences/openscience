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
      subject.FileTabs({ open: ["train_lr.py"], active: undefined, onSelect: () => {}, onClose: () => {} }),
    )

    expect(host.querySelector('[data-tab="files"]')?.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector('[data-tab="train_lr.py"]')?.getAttribute("aria-selected")).toBe("false")
  })

  // The browser is "no open file", not a reserved name: a file really can be
  // called `files`, and a sentinel string would hand it the browser's own tab.
  test("keeps the browser tab distinct from an open file that shares its name", () => {
    const picked: Array<string | undefined> = []
    const host = mount(() =>
      subject.FileTabs({ open: ["files"], active: "files", onSelect: (id) => picked.push(id), onClose: () => {} }),
    )
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[data-tab]")]

    expect(tabs.map((node) => node.getAttribute("aria-selected"))).toEqual(["false", "true"])

    tabs[0]!.click()

    expect(picked).toEqual([undefined])
  })

  test("selecting and closing report separately, and closing does not select", () => {
    const picked: Array<string | undefined> = []
    const closed: string[] = []
    const host = mount(() =>
      subject.FileTabs({
        open: ["train_lr.py"],
        active: undefined,
        onSelect: (id) => picked.push(id),
        onClose: (id) => closed.push(id),
      }),
    )

    host.querySelector<HTMLButtonElement>('[data-tab="train_lr.py"]')?.click()
    host.querySelector<HTMLButtonElement>('[data-tab-close="train_lr.py"]')?.click()

    expect(picked).toEqual(["train_lr.py"])
    expect(closed).toEqual(["train_lr.py"])
  })

  test("reorders file tabs with the keyboard", () => {
    const moved: Array<[string, number]> = []
    const host = mount(() =>
      subject.FileTabs({
        open: ["train.py", "README.md"],
        active: "train.py",
        onSelect: () => {},
        onClose: () => {},
        onReorder: (id, to) => moved.push([id, to]),
      }),
    )
    const tab = host.querySelector<HTMLButtonElement>('[data-tab="train.py"]')!

    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }))

    expect(moved).toEqual([["train.py", 1]])
  })

  test("keeps close a sibling of the tab it closes, not a control inside it", () => {
    // Nested interactive content is invalid, and the nested label folds into the
    // parent's accessible name: the tab would announce as "train_lr.py Close
    // train_lr.py", one control with two purposes.
    const host = mount(() =>
      subject.FileTabs({ open: ["train_lr.py"], active: undefined, onSelect: () => {}, onClose: () => {} }),
    )
    const tab = host.querySelector<HTMLElement>('[data-tab="train_lr.py"]')!
    const close = host.querySelector<HTMLElement>('[data-tab-close="train_lr.py"]')!

    expect(tab.contains(close)).toBe(false)
    expect(tab.querySelector("button, [role='button']")).toBeNull()
    expect(close.tagName).toBe("BUTTON")
    expect(close.getAttribute("tabindex")).toBeNull()
    expect(close.getAttribute("aria-label")).toBe("Close train_lr.py")
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
