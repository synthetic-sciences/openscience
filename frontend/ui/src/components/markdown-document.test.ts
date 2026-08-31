import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { documentPreferencesKey } from "../../../workspace/src/atlas/document-preferences"

// Bun has its own CustomEvent; DOM focus-scope events must use jsdom's realm.
const originalCustomEvent = globalThis.CustomEvent
globalThis.CustomEvent = window.CustomEvent
const vite = await createServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const reactive = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const marked = (await vite.ssrLoadModule("@synsci/ui/context/marked")) as typeof import("@synsci/ui/context/marked")
const subject = (await vite.ssrLoadModule(
  "/src/atlas/MarkdownDocument.tsx",
)) as typeof import("../../../workspace/src/atlas/MarkdownDocument")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const mount = (props: Parameters<typeof subject.MarkdownDocument>[0]) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        marked.MarkedProvider({
          get children() {
            return subject.MarkdownDocument(props)
          },
        }),
      host,
    ),
  )
  return host
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!

afterAll(async () => {
  await vite.close()
  globalThis.CustomEvent = originalCustomEvent
})
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  localStorage.removeItem(documentPreferencesKey)
})

// Keep rendered Markdown tests in this package's jsdom environment. HappyDOM
// does not implement the live NodeIterator semantics the real sanitizer needs.
describe("Markdown document reading", () => {
  test("renders structure and keeps authorized local-file resolution", async () => {
    const opened: string[] = []
    const host = mount({
      name: "plan.md",
      text: "# Study plan\n\n| Run | Score |\n| --- | --- |\n| A | 0.82 |\n\n[Protocol](protocol.md)\n\n![Figure](figure.png)\n\n```text\nraw evidence\n```",
      resolveFile: (href) => (href === "protocol.md" ? "/allowed/protocol.md" : undefined),
      resolveImage: (href) => (href === "figure.png" ? "http://127.0.0.1/authorized-figure.png" : href),
      onOpenFile: (path) => opened.push(path),
    })
    await ready(() => host.querySelector("table") !== null)
    expect(host.querySelector("article")?.getAttribute("aria-label")).toBe("plan.md preview")
    expect(host.querySelector("h1")?.textContent).toBe("Study plan")
    expect(host.querySelector("pre")?.textContent).toContain("raw evidence")
    expect(host.querySelector("img")?.getAttribute("src")).toBe("http://127.0.0.1/authorized-figure.png")
    host.querySelector<HTMLAnchorElement>("a")!.click()
    expect(opened).toEqual(["/allowed/protocol.md"])
  })

  test("reacts to source changes and aligned README content without retaining the old document", async () => {
    const [text, setText] = reactive.createSignal("# First document\n\n```text\nobsolete code\n```")
    const host = mount({
      get text() {
        return text()
      },
    })
    await ready(() => host.textContent?.includes("First document") === true)
    // Code-copy enhancement runs after rendering. Navigation must remove its
    // wrapper along with obsolete code, not preserve another document's text.
    await ready(() => host.querySelector('[data-component="markdown-code"]') !== null)
    setText("# Second document\n\nReplacement text")
    await ready(() => host.querySelector("h1")?.textContent === "Second document")
    expect(host.textContent).not.toContain("obsolete code")
    setText('<div align="center">\n\n# Centered title\n\n</div>\n\n## Body section')
    await ready(() => host.querySelector("h2")?.textContent === "Body section")
    expect(host.querySelector('[data-align="center"] h1')?.textContent).toBe("Centered title")
    expect(host.textContent).not.toContain("First document")
    setText("# Third document\n\nCurrent contents")
    await ready(() => host.querySelector("h1")?.textContent === "Third document")
    expect(host.querySelector("[data-align]")).toBeNull()
    expect(host.textContent).not.toContain("Body section")
  })

  test("reading controls persist presentation, preserve text, and reset without editing", async () => {
    const host = mount({ text: "# Unchanged source\n\nKeep the research evidence." })
    await ready(() => host.querySelector("h1") !== null)
    const original = host.querySelector(".atlas-md")!.textContent
    expect(host.querySelector("article")!.style.getPropertyValue("--document-font-size")).toBe("13px")
    host.querySelector<HTMLButtonElement>('[aria-label="Reading options"]')!.click()
    await ready(() => button("Serif") !== undefined)
    button("Serif").click()
    button("19").click()
    button("Full width").click()
    const article = host.querySelector("article")!
    expect(article.dataset.readingFont).toBe("serif")
    expect(article.dataset.readingWidth).toBe("full")
    expect(article.style.getPropertyValue("--document-font-size")).toBe("19px")
    expect(button("19").getAttribute("aria-pressed")).toBe("true")
    expect(JSON.parse(localStorage.getItem(documentPreferencesKey)!)).toEqual({
      size: 19,
      font: "serif",
      width: "full",
    })
    expect(host.querySelector(".atlas-md")!.textContent).toBe(original)
    button("Reset reading options").click()
    expect(article.dataset.readingFont).toBe("sans")
    expect(article.dataset.readingWidth).toBe("readable")
    expect(article.style.getPropertyValue("--document-font-size")).toBe("13px")
    expect(button("13").getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector(".atlas-md")!.textContent).toBe(original)
  })

  test("new previews restore device reading preferences and dismiss options with Escape", async () => {
    localStorage.setItem(documentPreferencesKey, JSON.stringify({ size: 17, font: "serif", width: "full" }))
    const host = mount({ text: "# Restored preferences" })
    expect(host.querySelector("article")?.dataset.readingFont).toBe("serif")
    expect(host.querySelector("article")?.style.getPropertyValue("--document-font-size")).toBe("17px")
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Reading options"]')!
    trigger.click()
    await ready(() => button("Serif") !== undefined)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await ready(() => document.querySelector(".atlas-reading-options") === null)
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
  })
})
