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
  test("does not add a redundant Browse tab above the browser", () => {
    const host = mount(() =>
      subject.FileTabs({ open: ["train_lr.py"], active: undefined, onSelect: () => {}, onClose: () => {} }),
    )

    expect(host.querySelectorAll("[data-tab]")).toHaveLength(1)
    expect(host.querySelector("[data-tab-label]")?.textContent).toBe("train_lr.py")
    expect(host.querySelector('[data-tab="train_lr.py"]')?.getAttribute("aria-selected")).toBe("false")
  })

  test("hides the empty tab strip while browsing before a file is opened", () => {
    const host = mount(() => subject.FileTabs({ open: [], active: undefined, onSelect: () => {}, onClose: () => {} }))

    expect(host.querySelector('[role="tablist"]')).toBeNull()
  })

  test("keeps a real file named files selectable", () => {
    const picked: string[] = []
    const host = mount(() =>
      subject.FileTabs({ open: ["files"], active: "files", onSelect: (id) => picked.push(id), onClose: () => {} }),
    )

    host.querySelector<HTMLButtonElement>('[data-tab="files"]')?.click()

    expect(picked).toEqual(["files"])
  })

  test("selecting and closing report separately, and closing does not select", () => {
    const picked: string[] = []
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
