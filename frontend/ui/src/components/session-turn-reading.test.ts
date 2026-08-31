import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { AssistantMessage, TextPart } from "@synsci/sdk/v2"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

// Render the real TextPart -> Markdown path in jsdom. Source-string checks
// alone allowed the previous selectors to survive after their DOM slot vanished.
const vite = await createServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
// Keep one module graph/context identity. Concurrent SSR entry evaluation can
// race shared provider dependencies when several roots import the same files.
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const reactive = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const data = (await vite.ssrLoadModule("@synsci/ui/context/data")) as typeof import("../context/data")
const marked = (await vite.ssrLoadModule("@synsci/ui/context/marked")) as typeof import("../context/marked")
const subject = (await vite.ssrLoadModule("@synsci/ui/message-part")) as typeof import("./message-part")
const markdown = (await vite.ssrLoadModule("@synsci/ui/markdown")) as typeof import("./markdown")
const styles = document.createElement("style")
styles.textContent = await Bun.file(
  new URL("../../../workspace/src/components/chat-surface.css", import.meta.url),
).text()
document.head.append(styles)
const cleanups: Array<() => void> = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(check()).toBe(true)
}
const message: AssistantMessage = {
  id: "msg_assistant",
  sessionID: "ses_reading",
  parentID: "msg_user",
  role: "assistant",
  time: { created: 1, completed: 2 },
  modelID: "test",
  providerID: "test",
  agent: "research",
  mode: "research",
  path: { cwd: "/research", root: "/research" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const mount = (source: string, assistant = true) => {
  const [part, setPart] = reactive.createStore<TextPart>({
    id: "prt_reading",
    sessionID: message.sessionID,
    messageID: message.id,
    type: "text",
    text: source,
  })
  const host = document.createElement("div")
  host.className = "session-scroller"
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        data.DataProvider({
          data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
          directory: "/research",
          get children() {
            return marked.MarkedProvider({
              get children() {
                return assistant ? subject.Part({ part, message, hideCopy: true }) : markdown.Markdown({ text: source })
              },
            })
          },
        }),
      host,
    ),
  )
  return { host, setPart }
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(async () => {
  styles.remove()
  await vite.close()
})

describe("rendered assistant prose", () => {
  test("the live Markdown matches heading, nested list, and table CSS", async () => {
    const { host } = mount(
      "# Study plan\n\n## Phase one\n\n### Workstream\n\n- Main step\n  - Nested step\n\n| Workload | Workers |\n| --- | --- |\n| A long descriptive workload in the first column | 8 |",
    )
    await ready(() => host.querySelector("table") !== null)
    const prose = host.querySelector('[data-component="markdown"][data-slot="assistant-prose"]')!
    expect(prose).not.toBeNull()
    expect(prose.querySelectorAll("h1, h2, h3")).toHaveLength(3)
    expect(prose.querySelector("li > ul > li")?.textContent).toBe("Nested step")
    // These computed properties prove that the production selectors match the
    // actual component DOM, rather than merely existing somewhere in a file.
    expect(getComputedStyle(prose.querySelector("h1")!).fontSize).toBe("1.286em")
    expect(getComputedStyle(prose.querySelector("h2")!).fontSize).toBe("1.143em")
    expect(getComputedStyle(prose.querySelector("li")!).marginBottom).toBe("4px")
    const table = prose.querySelector("table")!
    const frame = table.parentElement!
    expect(frame.getAttribute("data-component")).toBe("markdown-table")
    expect(frame.getAttribute("role")).toBe("region")
    expect(frame.getAttribute("aria-label")).toBe("Response table")
    expect(frame.tabIndex).toBe(0)
    frame.focus()
    expect(document.activeElement).toBe(frame)
    expect(getComputedStyle(frame).overflowX).toBe("auto")
    expect(getComputedStyle(table).display).toBe("table")
    for (const cell of prose.querySelectorAll("th, td")) {
      expect(getComputedStyle(cell).whiteSpace).toBe("normal")
      expect(getComputedStyle(cell).overflowWrap).toBe("anywhere")
    }
    expect(host.querySelector('[data-slot="text-part-copy-wrapper"]')).toBeNull()
  })

  test("growing streamed text keeps the prose slot and new structure styled", async () => {
    const { host, setPart } = mount("## Initial section\n\nFirst paragraph.")
    await ready(() => host.querySelector("h2") !== null)
    setPart("text", "## Initial section\n\nFirst paragraph.\n\n## Next section\n\n- Added during streaming")
    await ready(() => host.textContent?.includes("Added during streaming") === true)
    expect(host.querySelectorAll('[data-slot="assistant-prose"]')).toHaveLength(1)
    expect(getComputedStyle(host.querySelectorAll("h2")[1]!).fontSize).toBe("1.143em")
    expect(host.textContent).toContain("Added during streaming")
  })

  test("code and display math own horizontal overflow without expanding prose", async () => {
    const { host } = mount("```text\nlong_unbroken_code_line\n```\n\n\\[a+b+c+d+e=f\\]")
    await ready(
      () =>
        host.querySelector('[data-component="markdown-code"]') !== null &&
        host.querySelector(".katex-display") !== null,
    )
    for (const block of host.querySelectorAll("pre, .katex-display")) {
      expect(getComputedStyle(block).overflowX).toBe("auto")
      expect(getComputedStyle(block).maxWidth).toBe("100%")
      expect(getComputedStyle(block).scrollbarWidth).toBe("thin")
    }
    const frame = host.querySelector('[data-component="markdown-code"]')!
    const copy = frame.querySelector('[data-slot="markdown-copy-button"]')!
    expect(getComputedStyle(frame).display).toBe("grid")
    expect(getComputedStyle(copy).position).toBe("static")
    expect(getComputedStyle(copy).gridColumn).toBe("2")
  })

  test("table frames keep captions as labels and do not alter standalone Markdown", async () => {
    const source = "<table><caption>Worker allocation</caption><tr><th>Pool</th><td>8</td></tr></table>"
    const { host } = mount(source)
    await ready(() => host.querySelector("table") !== null)
    expect(host.querySelector('[data-component="markdown-table"]')?.getAttribute("aria-label")).toBe(
      "Worker allocation",
    )
    expect(host.querySelector("table > caption")?.textContent).toBe("Worker allocation")
    const generic = mount(source, false).host
    await ready(() => generic.querySelector("table") !== null)
    expect(generic.querySelector('[data-component="markdown-table"]')).toBeNull()
    expect(generic.querySelector('[data-slot="assistant-prose"]')).toBeNull()
  })
})
