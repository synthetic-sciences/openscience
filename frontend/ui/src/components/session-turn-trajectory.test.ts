import { afterAll, afterEach, describe, expect, test } from "bun:test"
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

// Render the real transcript in jsdom: all provider-readable reasoning,
// streaming prose, and chronological tool rows with expandable output.
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
const codeContext = (await vite.ssrLoadModule("@synsci/ui/context/code")) as typeof import("../context/code")
const marked = (await vite.ssrLoadModule("@synsci/ui/context/marked")) as typeof import("../context/marked")
const parts = (await vite.ssrLoadModule("@synsci/ui/message-part")) as typeof import("./message-part")
const turn = (await vite.ssrLoadModule("@synsci/ui/session-turn")) as typeof import("./session-turn")
const markdown = (await vite.ssrLoadModule("@synsci/ui/markdown")) as typeof import("./markdown")
const assets = (await vite.ssrLoadModule(
  "/src/utils/markdown-assets.ts",
)) as typeof import("../../../workspace/src/utils/markdown-assets")
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
                        // JSX initializes components untracked. Calling the
                        // view directly makes constructor reads (such as the
                        // initial duration) remount the whole test subtree.
                        return web.createComponent(view, {})
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

  test("keeps all streamed reasoning inline through completion and remounts without a toggle", async () => {
    const [message, setMessage] = reactive.createStore<AssistantMessage>(assistant())
    const [part, setPart] = reactive.createStore<ReasoningPart>(reasoning("prt_reason", { start: Date.now() - 12_300 }))
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const row = host.querySelector('[data-component="reasoning-part"]')!
    const header = row.querySelector('[data-slot="reasoning-part-header"]')!
    expect(row.getAttribute("data-live")).toBe("true")
    expect(row.querySelector("button")).toBeNull()
    expect(header.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning (12s)")
    expect(header.querySelector('[data-component="spinner"]')).not.toBeNull()
    await ready(() => row.querySelector('[data-slot="reasoning-part-body"] p') !== null)
    const body = row.querySelector('[data-slot="reasoning-part-body"]')!
    setPart("text", part.text + "\n\n**Researching cost distribution**\n\nThe entire next passage stays visible.")
    await ready(() => body.textContent?.includes("The entire next passage stays visible.") === true)
    expect(row.querySelector('[data-slot="reasoning-part-body"]')).toBe(body)
    expect(body.querySelector("strong")?.textContent).toBe("Researching cost distribution")
    expect(row.querySelector('[data-slot="reasoning-part-body"]')?.textContent).toContain("Comparing the two assay")

    // The turn completes: the clock freezes on the final duration and the row stays open.
    setPart("time", { start: part.time.start, end: part.time.start + 15_000 })
    setMessage("time", "completed", Date.now())
    await settle()
    expect(row.getAttribute("data-live")).toBeNull()
    expect(header.querySelector('[data-component="spinner"]')).toBeNull()
    expect(header.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning (15s)")
    expect(body.textContent).toContain("The entire next passage stays visible.")

    // Hydrating a completed turn keeps the full provider text visible too.
    cleanups.splice(0).forEach((cleanup) => cleanup())
    document.body.replaceChildren()
    const again = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    await ready(() => again.querySelector('[data-slot="reasoning-part-body"] p') !== null)
    expect(again.querySelector('[data-slot="reasoning-part-body"]')?.textContent).toContain(
      "The entire next passage stays visible.",
    )
    expect(again.querySelector('[data-slot="reasoning-part-toggle"]')).toBeNull()
  })

  test("an aborted turn shows a plain Reasoning label when reasoning never reported its end", async () => {
    const message = assistant(Date.now())
    const part = reasoning("prt_aborted", { start: Date.now() - 40_000 })
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const row = host.querySelector('[data-component="reasoning-part"]')!
    const header = row.querySelector('[data-slot="reasoning-part-header"]')!
    expect(row.getAttribute("data-live")).toBeNull()
    expect(header.querySelector('[data-component="spinner"]')).toBeNull()
    expect(header.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning")
  })

  test("completed reasoning is visible without a stored presentation preference", async () => {
    const message = assistant(Date.now())
    const part = reasoning("prt_folded", { start: 1_000, end: 1_800 })
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const header = host.querySelector('[data-slot="reasoning-part-header"]')!
    // Under one second the clock stays quiet rather than reading "Thinking (0s)".
    expect(header.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning")
    await ready(() => host.querySelector('[data-slot="reasoning-part-body"] p') !== null)
    expect(host.querySelector('[data-slot="reasoning-part-body"]')?.textContent).toContain(part.text)
  })

  test.each(["", " \n ", "[REDACTED]", "[REDACTED]\n[REDACTED]"])("omits non-readable reasoning %j", async (text) => {
    const part = { ...reasoning("prt_redacted", { start: 1_000, end: 2_000 }), text }
    const host = mount(() => parts.Part({ part, message: assistant(2_000), hideCopy: true }), empty())
    await settle()
    expect(host.textContent).toBe("")
    expect(host.querySelector('[data-component="reasoning-part"]')).toBeNull()
  })

  test("interleaved encrypted parts do not add blank rows or repeated notices to a completed turn", async () => {
    const message = assistant(2_000)
    const visible = reasoning("prt_visible", { start: 1_000, end: 2_000 })
    const answer: TextPart = { id: "prt_answer", sessionID, messageID: message.id, type: "text", text: "Final answer." }
    const store: Store = {
      ...empty(),
      message: { [sessionID]: [user, message] },
      part: {
        [user.id]: [],
        [message.id]: [
          { ...visible, id: "prt_empty", text: "" },
          { ...visible, id: "prt_redacted1", text: "[REDACTED]" },
          visible,
          { ...visible, id: "prt_redacted2", text: "[REDACTED]" },
          answer,
        ],
      },
    }
    const host = mount(() => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id }), store)
    await ready(() => host.textContent?.includes(answer.text) === true)
    expect(host.querySelector('[data-slot="session-turn-status"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-component="reasoning-part"]')).toHaveLength(1)
    expect(host.querySelector('[data-slot="reasoning-part-body"]')?.textContent).toContain(visible.text)
    expect(host.querySelector('[data-origin="provider-reasoning-unavailable"]')).toBeNull()
    expect(host.textContent).not.toContain("did not provide readable reasoning")
    expect(host.textContent).not.toContain("[REDACTED]")
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

describe("chronological activity in a turn", () => {
  test("completed operations stay individually visible without an outer disclosure or mode selector", async () => {
    const message = assistant(5_000)
    const store: Store = {
      ...empty(),
      message: { [sessionID]: [user, message] },
      part: {
        [user.id]: [],
        [message.id]: [read("prt_detail1", "paper.tex", 1_000), read("prt_detail2", "analysis.py", 2_000)],
      },
    }
    const host = mount(() => turn.SessionTurn({ sessionID, messageID: user.id }), store)
    await ready(() => host.querySelectorAll('[data-component="tool-part-wrapper"]').length === 2)
    expect(host.querySelector('[data-component="trace-run-group"]')).toBeNull()
    expect(host.textContent).toContain("paper.tex")
    expect(host.textContent).toContain("analysis.py")
    const status = host.querySelector('[data-slot="session-turn-status"]')!
    expect(status.tagName).not.toBe("BUTTON")
    expect(status.hasAttribute("aria-expanded")).toBe(false)
    expect(host.querySelector('[data-slot="session-turn-activity-mode"]')).toBeNull()
  })

  test("repeated reads and the live call retain their individual chronological rows", async () => {
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
    const host = mount(() => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id }), store)
    await ready(() => host.querySelectorAll('[data-component="tool-part-wrapper"]').length === 4)
    expect(host.querySelector('[data-component="trace-run-group"]')).toBeNull()
    const rows = host.querySelectorAll('[data-component="tool-part-wrapper"]')
    expect(
      [...rows].slice(0, 3).map((row) => row.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent),
    ).toEqual(["paper.tex", "analysis.py", "results.csv"])
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
    const host = mount(() => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id }), store)
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

    // Completion does not replace the rows or reset an opened tool receipt.
    setStore("message", sessionID, 1, "time", { created: 2, completed: Date.now() })
    await settle()
    expect(host.querySelector('[data-component="trace-run-group"]')).toBeNull()
    expect(rows()).toHaveLength(2)
    expect(row("paper.tex").querySelector('[data-slot="collapsible-trigger"]')).toBe(first)
    expect(first.getAttribute("aria-expanded")).toBe("true")
  })
})

describe("execution inspection", () => {
  test("a preview's explicit file resolver is not replaced by surrounding turn provenance", async () => {
    const opened: string[] = []
    const host = mount(
      () =>
        web.createComponent(markdown.MarkdownFileScope, {
          paths: ["/research/TWITTER_THREAD.md"],
          get children() {
            return web.createComponent(markdown.Markdown, {
              text: "`TWITTER_THREAD.md`",
              resolveFile: (path) => `/document/${path}`,
              onOpenFile: (path) => opened.push(path),
            })
          },
        }),
      empty(),
    )
    await ready(() => host.querySelector("code[data-file-path]") !== null)
    host.querySelector<HTMLElement>("code")!.click()
    expect(opened).toEqual(["/document/TWITTER_THREAD.md"])
  })

  test.each(["/research/TWITTER_THREAD.md", "/session-scratch/TWITTER_THREAD.md", "/connected/TWITTER_THREAD.md"])(
    "bare filename opens exact receipt %s without overriding explicit links",
    async (target) => {
      const message = assistant(3_000)
      const write: ToolPart = {
        id: "prt_write",
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: "call_write",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "TWITTER_THREAD.md" },
          metadata: { filepath: target },
          output: "Written",
          title: "TWITTER_THREAD.md",
          time: { start: 1_000, end: 2_000 },
        },
      }
      const response: TextPart = {
        id: "prt_response",
        sessionID,
        messageID: message.id,
        type: "text",
        text: "Updated `TWITTER_THREAD.md`. [Explicit scratch link](TWITTER_THREAD.md).",
      }
      const [store, setStore] = reactive.createStore<Store>({
        ...empty(),
        message: { [sessionID]: [user, message] },
        part: { [user.id]: [], [message.id]: [write, response] },
      })
      const opened: string[] = []
      const host = mount(
        () =>
          web.createComponent(markdown.MarkdownImages, {
            resolve: (src) => src,
            resolveFile: (path) => assets.workspaceAssetPath(path, "/research"),
            resolveFileReceipt: assets.workspaceReceiptPath,
            openFile: (path) => opened.push(path),
            get children() {
              return web.createComponent(codeContext.CodeComponentProvider, {
                component: () => null,
                get children() {
                  return web.createComponent(turn.SessionTurn, { sessionID, messageID: user.id })
                },
              })
            },
          }),
        store,
      )
      await ready(() => host.querySelector('[data-slot="assistant-prose"] code[data-file-path]') !== null)
      const code = host.querySelector<HTMLElement>('[data-slot="assistant-prose"] code')!
      const anchor = host.querySelector<HTMLAnchorElement>('[data-slot="assistant-prose"] a')!
      expect(code.getAttribute("data-file-path")).toBe(target)
      expect(anchor.getAttribute("data-file-path")).toBe("TWITTER_THREAD.md")
      code.click()
      expect(opened).toEqual([target])

      // A later receipt with the same basename is genuinely ambiguous. It
      // removes the shortcut instead of falling back to the old scratch copy.
      setStore("part", message.id, (parts) => [
        ...parts,
        {
          ...write,
          id: "prt_other_write",
          callID: "call_other_write",
          state: { ...write.state, metadata: { filepath: "/research/drafts/TWITTER_THREAD.md" } },
        },
      ])
      await ready(() => !code.hasAttribute("data-file-path"))
      expect(host.querySelector('[data-slot="assistant-prose"] code')).toBe(code)
      code.click()
      expect(opened).toEqual([target])
      anchor.click()
      expect(opened).toEqual([target, "TWITTER_THREAD.md"])
    },
  )

  test.each(["missing", "denied"] as const)(
    "shell copy handles a %s clipboard and recovers on retry",
    async (failure) => {
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard")
      const writes: string[] = []
      const clipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value })
      clipboard(failure === "missing" ? undefined : { writeText: () => Promise.reject(new Error("Permission denied")) })
      try {
        const part: ToolPart = {
          id: `prt_copy_${failure}`,
          sessionID,
          messageID: "msg_0002",
          type: "tool",
          callID: `call_copy_${failure}`,
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "inspect results" },
            title: "Inspect results",
            output: "done",
            metadata: { exit: 0 },
            time: { start: 1_000, end: 2_000 },
          },
        }
        const host = mount(() => parts.Part({ part, message: assistant(2_000) }), empty())
        host.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click()
        await settle()
        const copy = () => host.querySelector<HTMLButtonElement>('[data-slot="shell-output-actions"] button')!
        copy().click()
        await ready(() => host.querySelector('[data-slot="shell-output-copy-error"]') !== null)
        expect(copy().getAttribute("aria-label")).toBe("Copy")
        expect(host.querySelector('[data-slot="shell-output-copy-error"]')?.textContent).toContain("copy it manually")
        clipboard({
          writeText: async (text: string) => {
            writes.push(text)
          },
        })
        copy().click()
        await ready(() => copy().getAttribute("aria-label") === "Copied!")
        expect(writes).toEqual(["$ inspect results\n\ndone"])
        expect(host.querySelector('[data-slot="shell-output-copy-error"]')).toBeNull()
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original)
        else Reflect.deleteProperty(navigator, "clipboard")
      }
    },
  )

  test("shell output stays literal, bounded and collapsed until opened", async () => {
    const output = "```\n<script>not executable</script>\n**literal output**\n"
    const part: ToolPart = {
      id: "prt_shell",
      sessionID,
      messageID: "msg_0002",
      type: "tool",
      callID: "call_shell",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "inspect results", description: "Inspect output" },
        title: "Inspect output",
        output,
        metadata: { exit: 0 },
        time: { start: 1_000, end: 2_000 },
      },
    }
    const host = mount(() => parts.Part({ part, message: assistant(2_000) }), empty())
    await settle()
    expect(host.querySelector('[data-component="shell-output"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click()
    await settle()
    expect(host.querySelector('[data-component="tool-output"][data-scrollable] pre code')?.textContent).toBe(
      `$ inspect results\n\n${output}`,
    )
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector('[data-slot="shell-output-actions"] button')?.getAttribute("aria-label")).toBe("Copy")
  })

  test("an agent's completed operation is not labelled as its current activity, and manual collapse survives progress", async () => {
    const [part, setPart] = reactive.createStore<ToolPart>({
      id: "prt_agent",
      sessionID,
      messageID: "msg_0002",
      type: "tool",
      callID: "call_agent",
      tool: "task",
      state: {
        status: "running",
        input: { subagent_type: "research", description: "Compare assays" },
        title: "Compare assays",
        metadata: {
          summary: [{ id: "read_done", tool: "read", state: { status: "completed", title: "Read old paper" } }],
        },
        time: { start: Date.now() - 8_000 },
      },
    })
    const host = mount(() => parts.Part({ part, message: assistant() }), empty())
    await settle()
    const card = host.querySelector<HTMLDetailsElement>('[data-component="delegation-card"]')!
    expect(card.open).toBe(true)
    expect(card.querySelector('[data-slot="delegation-current"]')).toBeNull()
    expect(card.querySelector('[data-slot="delegation-summary-meta"]')?.textContent).toContain("8s")
    card.querySelector<HTMLElement>("summary")!.click()
    await settle()
    expect(card.open).toBe(false)
    setPart("state", {
      ...part.state,
      status: "running",
      title: "Compare assays",
      time: { start: Date.now() - 9_000 },
      metadata: { summary: [{ id: "read_live", tool: "read", state: { status: "running", title: "Read new paper" } }] },
    })
    await settle()
    expect(card.open).toBe(false)
    card.querySelector<HTMLElement>("summary")!.click()
    await settle()
    expect(card.querySelector('[data-slot="delegation-current"]')?.textContent).toContain("Read new paper")
  })

  test("a new model request replaces the preceding command status with its own wait", async () => {
    const first = assistant()
    const next = { ...assistant(), id: "msg_0003" }
    const command: ToolPart = {
      id: "prt_prior_command",
      sessionID,
      messageID: first.id,
      type: "tool",
      callID: "call_prior",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "inspect results" },
        title: "Inspect results",
        metadata: {},
        time: { start: Date.now() - 1_000 },
      },
    }
    const [store, setStore] = reactive.createStore<Store>({
      ...empty(),
      session_status: { [sessionID]: { type: "busy" } },
      message: { [sessionID]: [user, first] },
      part: { [user.id]: [], [first.id]: [command] },
    })
    const host = mount(() => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id }), store)
    const status = () => host.querySelector('[data-slot="session-turn-status-text"]')?.textContent ?? ""
    await ready(() => status().includes("Running commands"))
    setStore("session_progress", {
      [sessionID]: {
        sessionID,
        messageID: first.id,
        attempt: 1,
        agent: "research",
        providerID: "openrouter",
        modelID: "openai/gpt-5.6-sol",
        phase: "streaming",
        since: Date.now() - 60_000,
        elapsedMs: 0,
        stalls: 0,
        lastOutputAt: Date.now() - 60_000,
      },
    })
    await settle()
    // A model waiting for an actively running tool is not a stalled provider.
    expect(status()).toContain("Running commands")
    setStore("part", first.id, 0, {
      ...command,
      state: { status: "pending", input: {}, raw: "" },
    })
    await settle()
    // The model is still generating arguments; no command is executing yet.
    expect(status()).toContain("No new output from")
    expect(status()).not.toContain("Running commands")
    setStore("part", first.id, 0, {
      ...command,
      state: {
        ...command.state,
        status: "completed",
        title: "Inspect results",
        metadata: {},
        output: "done",
        time: { start: 1_000, end: 2_000 },
      },
    })
    setStore("message", sessionID, [user, { ...first, time: { created: 2, completed: 2_000 } }, next])
    setStore("part", next.id, [])
    setStore("session_progress", {
      [sessionID]: {
        sessionID,
        messageID: next.id,
        attempt: 2,
        agent: "research",
        providerID: "openrouter",
        modelID: "openai/gpt-5.6-sol",
        phase: "waiting_first_token",
        since: Date.now(),
        elapsedMs: 7_000,
        stalls: 0,
      },
    })
    await ready(() => status().includes("Waiting for output from openai/gpt-5.6-sol"))
    expect(status()).not.toContain("Running commands")
  })
})

describe("timeout recovery", () => {
  const timeout: NonNullable<AssistantMessage["error"]> = {
    name: "APIError",
    data: {
      message:
        "The model request timed out waiting for new output. Received output was preserved. The provider may have processed the request; it was not automatically sent again.",
      isRetryable: false,
      metadata: {
        code: "provider_request_timeout",
        openscience_state: "stopped",
        action: "resubmit",
        dispatch_state: "outcome_unknown",
        phase: "output",
      },
    },
  }

  test.each(["busy", "retry"] as const)(
    "keeps partial output and stops live indicators after a terminal timeout despite stale %s state",
    async (status) => {
      const message = assistant()
      const reason: ReasoningPart = {
        id: `prt_timeout_reason_${status}`,
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: "The measurement is incomplete, so the result cannot be confirmed yet.",
        time: { start: Date.now() - 8_000 },
      }
      const partial: TextPart = {
        id: `prt_timeout_text_${status}`,
        sessionID,
        messageID: message.id,
        type: "text",
        text: "The preliminary measurement was 17 units.",
      }
      const command: ToolPart = {
        id: `prt_timeout_tool_${status}`,
        sessionID,
        messageID: message.id,
        type: "tool",
        tool: "bash",
        callID: `call_timeout_${status}`,
        state: {
          status: "completed",
          input: { command: "inspect measurements" },
          title: "Inspect measurements",
          output: "measurement=17",
          metadata: { exit: 0 },
          time: { start: 1_000, end: 2_000 },
        },
      }
      const [store, setStore] = reactive.createStore<Store>({
        ...empty(),
        session_status: { [sessionID]: { type: "busy" } },
        session_progress: {
          [sessionID]: {
            sessionID,
            messageID: message.id,
            attempt: 1,
            agent: "research",
            providerID: "openrouter",
            modelID: "openai/gpt-5.6-sol",
            phase: "streaming",
            since: Date.now(),
            elapsedMs: 0,
            stalls: 0,
            lastOutputAt: Date.now(),
          },
        },
        message: { [sessionID]: [user, message] },
        part: { [user.id]: [], [message.id]: [command, reason, partial] },
      })
      const host = mount(
        () =>
          turn.SessionTurn({
            sessionID,
            messageID: user.id,
            lastUserMessageID: user.id,
          }),
        store,
      )
      await ready(() => host.querySelector('[data-slot="reasoning-part-body"] p') !== null)
      expect(host.querySelector('[data-component="reasoning-part"]')?.getAttribute("data-live")).toBe("true")

      // Completion and status are independent events. A lost/late idle event
      // must not keep the completed request looking like an automatic retry.
      setStore("message", sessionID, 1, { ...message, error: timeout, time: { created: 2, completed: Date.now() } })
      setStore(
        "session_status",
        sessionID,
        status === "busy"
          ? { type: "busy" }
          : { type: "retry", attempt: 2, next: Date.now() + 10_000, message: "Reconnecting to the provider" },
      )
      await ready(() => host.querySelector('[data-slot="session-state-message"]') !== null)
      expect(host.querySelectorAll('[data-slot="session-state-message"]')).toHaveLength(1)
      expect(host.querySelector('[data-slot="session-state-message"]')?.textContent).toBe(timeout.data.message)
      expect(host.querySelector('[data-slot="reasoning-part-body"]')?.textContent).toContain(reason.text)
      expect(host.textContent).toContain(partial.text)
      expect(host.querySelector('[data-component="reasoning-part"]')?.getAttribute("data-live")).toBeNull()
      expect(host.querySelector('[data-slot="session-turn-status"] [data-component="spinner"]')).toBeNull()
      expect(host.querySelector('[data-slot="session-turn-retry-message"]')).toBeNull()
      expect(host.querySelector('[data-slot="session-turn-progress-hint"]')).toBeNull()

      const tool = host.querySelector('[data-component="tool-part-wrapper"]')!
      tool.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click()
      await ready(() => tool.querySelector('[data-component="shell-output"] pre') !== null)
      expect(tool.querySelector('[data-component="shell-output"] pre')?.textContent).toContain("measurement=17")
      expect(tool.getAttribute("data-tool-status")).toBe("completed")

      // An older failed attempt must not mask a new, genuinely active request.
      const next = { ...assistant(), id: "msg_0003" }
      setStore("message", sessionID, [user, store.message[sessionID][1], next])
      setStore("part", next.id, [])
      setStore("session_status", sessionID, { type: "busy" })
      setStore("session_progress", sessionID, {
        ...store.session_progress![sessionID],
        messageID: next.id,
        phase: "waiting_first_token",
        since: Date.now(),
      })
      await ready(() =>
        (host.querySelector('[data-slot="session-turn-status-text"]')?.textContent ?? "").includes(
          "Waiting for output from openai/gpt-5.6-sol",
        ),
      )
      expect(host.querySelector('[data-slot="session-turn-status"] [data-component="spinner"]')).not.toBeNull()
    },
  )
})
