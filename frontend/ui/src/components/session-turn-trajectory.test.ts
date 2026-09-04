import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { AssistantMessage, Part, ReasoningPart, TextPart, ToolPart, UserMessage } from "@synsci/sdk/v2"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

// jsdom has no ResizeObserver; the turn only measures with it, never depends on a callback here.
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: globalThis.ResizeObserver ?? Observer })

// Render the real trajectory components in jsdom: a folded reasoning row, the
// streaming caret hook on prose, and a turn whose repeated reads fold behind
// one counted header while the live call stays its own line.
const vite = await createServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  // fuzzysort ships a UMD wrapper that reads `this`; leave it to the runtime.
  ssr: { noExternal: true, external: ["fuzzysort"], resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const reactive = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const data = (await vite.ssrLoadModule("@synsci/ui/context/data")) as typeof import("../context/data")
const dialog = (await vite.ssrLoadModule("@synsci/ui/context/dialog")) as typeof import("../context/dialog")
const diff = (await vite.ssrLoadModule("@synsci/ui/context/diff")) as typeof import("../context/diff")
const marked = (await vite.ssrLoadModule("@synsci/ui/context/marked")) as typeof import("../context/marked")
const parts = (await vite.ssrLoadModule("@synsci/ui/message-part")) as typeof import("./message-part")
const turn = (await vite.ssrLoadModule("@synsci/ui/session-turn")) as typeof import("./session-turn")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(check()).toBe(true)
}

const sessionID = "ses_trajectory"
const user: UserMessage = {
  id: "msg_0001",
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "research",
  model: { providerID: "test", modelID: "test" },
}
const assistant = (completed?: number): AssistantMessage => ({
  id: "msg_0002",
  sessionID,
  parentID: user.id,
  role: "assistant",
  time: { created: 2, completed },
  modelID: "test",
  providerID: "test",
  agent: "research",
  mode: "research",
  path: { cwd: "/research", root: "/research" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const read = (id: string, file: string, start: number): ToolPart => ({
  id,
  sessionID,
  messageID: "msg_0002",
  type: "tool",
  callID: `call_${id}`,
  tool: "read",
  state: {
    status: "completed",
    input: { filePath: file },
    output: `<file>\n00001| line\n00002| line\n</file>`,
    title: file,
    metadata: {},
    time: { start, end: start + 400 },
  },
})

type Store = Parameters<typeof data.DataProvider>[0]["data"]
const mount = (view: () => JSX.Element, store: Store) => {
  const host = document.createElement("div")
  host.className = "session-scroller"
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        data.DataProvider({
          data: store,
          directory: "/research",
          get children() {
            return dialog.DialogProvider({
              get children() {
                return diff.DiffComponentProvider({
                  component: () => null,
                  get children() {
                    return marked.MarkedProvider({
                      get children() {
                        return view()
                      },
                    })
                  },
                })
              },
            })
          },
        }),
      host,
    ),
  )
  return host
}
const empty = (): Store => ({ session: [], session_status: {}, session_diff: {}, message: {}, part: {} })

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(() => vite.close())

describe("reasoning rows", () => {
  const reasoning = (id: string, time: ReasoningPart["time"]): ReasoningPart => ({
    id,
    sessionID,
    messageID: "msg_0002",
    type: "reasoning",
    text: "Comparing the two assay formats before choosing one.",
    time,
  })

  test("fold to a Thinking clock by default, open on click, and stay open across remounts", async () => {
    const [message, setMessage] = reactive.createStore<AssistantMessage>(assistant())
    const [part, setPart] = reactive.createStore<ReasoningPart>(reasoning("prt_reason", { start: Date.now() - 12_300 }))
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const row = host.querySelector('[data-component="reasoning-part"]')!
    const toggle = row.querySelector<HTMLButtonElement>('[data-slot="reasoning-part-toggle"]')!
    expect(row.getAttribute("data-live")).toBe("true")
    expect(row.getAttribute("data-expanded")).toBeNull()
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.getAttribute("aria-controls")).toBe("prt_reason-reasoning")
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Thinking (12s)")
    expect(toggle.querySelector('[data-component="spinner"]')).not.toBeNull()
    expect(row.querySelector('[data-slot="reasoning-part-body"]')).toBeNull()

    toggle.click()
    await ready(() => row.querySelector("#prt_reason-reasoning p") !== null)
    expect(row.getAttribute("data-expanded")).toBe("true")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(row.querySelector('[data-slot="reasoning-part-body"]')?.textContent).toContain("Comparing the two assay")

    // The turn completes: the clock freezes on the final duration and the row stays open.
    setPart("time", { start: part.time.start, end: part.time.start + 15_000 })
    setMessage("time", "completed", Date.now())
    await settle()
    expect(row.getAttribute("data-live")).toBeNull()
    expect(toggle.querySelector('[data-component="spinner"]')).toBeNull()
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Thinking (15s)")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    // A reader's choice survives the row being remounted (steps hidden and shown again).
    cleanups.splice(0).forEach((cleanup) => cleanup())
    document.body.replaceChildren()
    const again = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    expect(again.querySelector('[data-slot="reasoning-part-toggle"]')?.getAttribute("aria-expanded")).toBe("true")
    expect(again.querySelector('[data-slot="reasoning-part-body"]')).not.toBeNull()
  })

  test("an aborted turn shows a plain Thinking label when reasoning never reported its end", async () => {
    const message = assistant(Date.now())
    const part = reasoning("prt_aborted", { start: Date.now() - 40_000 })
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const row = host.querySelector('[data-component="reasoning-part"]')!
    const toggle = row.querySelector('[data-slot="reasoning-part-toggle"]')!
    expect(row.getAttribute("data-live")).toBeNull()
    expect(toggle.querySelector('[data-component="spinner"]')).toBeNull()
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Thinking")
  })

  test("a completed turn folds reasoning the reader never opened", async () => {
    const message = assistant(Date.now())
    const part = reasoning("prt_folded", { start: 1_000, end: 1_800 })
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const toggle = host.querySelector('[data-slot="reasoning-part-toggle"]')!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    // Under one second the clock stays quiet rather than reading "Thinking (0s)".
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Thinking")
    expect(host.querySelector('[data-slot="reasoning-part-body"]')).toBeNull()
  })
})

describe("streaming prose", () => {
  test("marks a growing text part until its end arrives", async () => {
    const [message, setMessage] = reactive.createStore<AssistantMessage>(assistant())
    const [part, setPart] = reactive.createStore<TextPart>({
      id: "prt_text",
      sessionID,
      messageID: "msg_0002",
      type: "text",
      text: "First paragraph of the answer.",
      time: { start: 1_000 },
    })
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await ready(() => host.querySelector('[data-component="text-part"] p') !== null)
    expect(host.querySelector('[data-component="text-part"]')?.getAttribute("data-streaming")).toBe("true")

    setPart("time", { start: 1_000, end: 2_000 })
    setMessage("time", "completed", 2_000)
    await settle()
    expect(host.querySelector('[data-component="text-part"]')?.getAttribute("data-streaming")).toBeNull()
  })
})

describe("folded runs in a turn", () => {
  test("repeated reads share one counted header while the live call keeps its own verb line", async () => {
    const message = assistant()
    const grep: ToolPart = {
      id: "prt_grep",
      sessionID,
      messageID: message.id,
      type: "tool",
      callID: "call_grep",
      tool: "grep",
      state: { status: "running", input: { pattern: "cite" }, title: "cite", time: { start: Date.now() - 2_000 } },
    }
    const prompt: TextPart = { id: "prt_prompt", sessionID, messageID: user.id, type: "text", text: "Review the paper" }
    const store: Store = {
      ...empty(),
      session_status: { [sessionID]: { type: "busy" } },
      message: { [sessionID]: [user, message] },
      part: {
        [user.id]: [prompt],
        [message.id]: [
          read("prt_read1", "paper.tex", 1_000),
          read("prt_read2", "analysis.py", 2_000),
          read("prt_read3", "results.csv", 3_000),
          grep,
        ] satisfies Part[],
      },
    }
    const host = mount(
      () => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id, stepsExpanded: true }),
      store,
    )
    await ready(() => host.querySelector('[data-component="trace-run-group"]') !== null)

    const run = host.querySelector('[data-component="trace-run-group"]')!
    const header = run.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!
    expect(run.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Read")
    expect(run.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toBe(
      "paper.tex · analysis.py · results.csv",
    )
    expect(run.querySelector('[data-slot="basic-tool-tool-detail"]')?.textContent).toBe("3 calls")
    expect(run.querySelector('[data-slot="basic-tool-tool-status"]')?.getAttribute("data-outcome")).toBe("done")
    expect(header.getAttribute("aria-expanded")).toBe("false")
    expect(run.querySelectorAll('[data-component="tool-part-wrapper"]')).toHaveLength(0)

    header.click()
    await settle()
    expect(header.getAttribute("aria-expanded")).toBe("true")
    const rows = run.querySelectorAll('[data-slot="trace-run-items"] > [data-component="tool-part-wrapper"]')
    expect(rows).toHaveLength(3)
    expect(rows[1]?.querySelector('[data-slot="basic-tool-tool-detail"]')?.textContent).toBe("2 lines")

    const live = host.querySelector('[data-component="tool-part-wrapper"][data-tool-status="running"]')!
    expect(live.closest('[data-component="trace-run-group"]')).toBeNull()
    expect(live.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Searching")
    expect(live.querySelector('[data-slot="basic-tool-tool-status"]')?.getAttribute("data-outcome")).toBe("running")
    expect(live.querySelector('[data-slot="basic-tool-tool-time"]')?.textContent).toBe("2s")
  })

  test("a call that just finished keeps its own row and receipt while the turn works", async () => {
    const message = assistant()
    const running: ToolPart = {
      id: "prt_read2",
      sessionID,
      messageID: message.id,
      type: "tool",
      callID: "call_prt_read2",
      tool: "read",
      state: { status: "running", input: { filePath: "analysis.py" }, title: "analysis.py", time: { start: 2_000 } },
    }
    const prompt: TextPart = { id: "prt_prompt", sessionID, messageID: user.id, type: "text", text: "Review the paper" }
    const [store, setStore] = reactive.createStore<Store>({
      ...empty(),
      session_status: { [sessionID]: { type: "busy" } },
      message: { [sessionID]: [user, message] },
      part: { [user.id]: [prompt], [message.id]: [read("prt_read1", "paper.tex", 1_000), running] },
    })
    const host = mount(
      () => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id, stepsExpanded: true }),
      store,
    )
    const rows = () => host.querySelectorAll('[data-component="tool-part-wrapper"]')
    const row = (id: string) =>
      [...rows()].find((item) => item.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent === id)!
    await ready(() => rows().length === 2)
    expect(host.querySelector('[data-component="trace-run-group"]')).toBeNull()

    // The reader opens the first read while the second is still running.
    const first = row("paper.tex").querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!
    first.click()
    await settle()
    expect(first.getAttribute("aria-expanded")).toBe("true")

    // The second read completes: its own row shows the receipt, and the first stays open and literal.
    setStore("part", message.id, 1, read("prt_read2", "analysis.py", 2_000))
    await settle()
    expect(host.querySelector('[data-component="trace-run-group"]')).toBeNull()
    expect(rows()).toHaveLength(2)
    const second = row("analysis.py")
    expect(second.getAttribute("data-tool-status")).toBe("completed")
    expect(second.querySelector('[data-slot="basic-tool-tool-status"]')?.getAttribute("data-outcome")).toBe("done")
    expect(second.querySelector('[data-slot="basic-tool-tool-detail"]')?.textContent).toBe("2 lines")
    expect(row("paper.tex").querySelector('[data-slot="collapsible-trigger"]')?.getAttribute("aria-expanded")).toBe(
      "true",
    )

    // The turn settles: the two reads fold behind one counted header.
    setStore("message", sessionID, 1, "time", { created: 2, completed: Date.now() })
    await ready(() => host.querySelector('[data-component="trace-run-group"]') !== null)
    const run = host.querySelector('[data-component="trace-run-group"]')!
    expect(run.querySelector('[data-slot="basic-tool-tool-detail"]')?.textContent).toBe("2 calls")
    expect(run.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toBe("paper.tex · analysis.py")
    expect(host.querySelectorAll('[data-component="tool-part-wrapper"]')).toHaveLength(0)
  })
})

describe("turn layout contract", () => {
  const turnCss = readFileSync(fileURLToPath(new URL("./session-turn.css", import.meta.url)), "utf8")
  const partCss = readFileSync(fileURLToPath(new URL("./message-part.css", import.meta.url)), "utf8")
  const toolCss = readFileSync(fileURLToPath(new URL("./basic-tool.css", import.meta.url)), "utf8")
  const chatCss = readFileSync(
    fileURLToPath(new URL("../../../workspace/src/components/chat-surface.css", import.meta.url)),
    "utf8",
  )

  test("the status row has one fixed height and truncates instead of wrapping", () => {
    expect(turnCss).toMatch(
      /\[data-slot="session-turn-collapsible-trigger-content"\]\s*\{[^}]*height: 32px;[^}]*white-space: nowrap;/s,
    )
    expect(turnCss).toMatch(/\[data-slot="session-turn-status-text"\],\s*\[data-slot="session-turn-retry-message"\]/)
  })

  test("a running write reserves the same row height as the finished card", () => {
    expect(partCss).toMatch(/\[data-component="tool-progress"\]\s*\{[^}]*min-height: 40px;/s)
    expect(chatCss).toMatch(/\.session-scroller \[data-component="tool-progress"\]\s*\{[^}]*min-height: 32px;/s)
    expect(chatCss).toMatch(/\[data-slot="reasoning-part-toggle"\]\s*\{[^}]*min-height: 32px;/s)
  })

  test("the status rail and streaming caret stay still and quiet", () => {
    expect(toolCss).toContain("font-variant-numeric: tabular-nums")
    expect(toolCss).toMatch(/\[data-slot="basic-tool-tool-time"\]\s*\{[^}]*min-width: 3\.5ch;/s)
    const caret = partCss.slice(
      partCss.indexOf('[data-streaming="true"]'),
      partCss.indexOf('[data-component="reasoning-part"] {'),
    )
    expect(caret).toContain("opacity: 0.35")
    expect(caret).not.toContain("animation")
    expect(partCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-slot="reasoning-part-chevron"\][\s\S]*transition: none/,
    )
  })
})
