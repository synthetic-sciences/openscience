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
const activity = (await vite.ssrLoadModule("@synsci/ui/context/activity")) as typeof import("../context/activity")
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
const mount = (view: () => JSX.Element, store: Store, mode: () => "detailed" | "compact" = () => "detailed") => {
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
                        return activity.ActivityProvider({
                          value: mode,
                          get children() {
                            return view()
                          },
                        })
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

  test("shows live reasoning by default, respects collapse, and preserves explicit choices across remounts", async () => {
    const [message, setMessage] = reactive.createStore<AssistantMessage>(assistant())
    const [part, setPart] = reactive.createStore<ReasoningPart>(reasoning("prt_reason", { start: Date.now() - 12_300 }))
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const row = host.querySelector('[data-component="reasoning-part"]')!
    const toggle = row.querySelector<HTMLButtonElement>('[data-slot="reasoning-part-toggle"]')!
    expect(row.getAttribute("data-live")).toBe("true")
    expect(row.getAttribute("data-expanded")).toBe("true")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.getAttribute("aria-controls")).toBe("prt_reason-reasoning")
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning (12s)")
    expect(toggle.querySelector('[data-component="spinner"]')).not.toBeNull()
    await ready(() => row.querySelector("#prt_reason-reasoning p") !== null)

    toggle.click()
    await settle()
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(row.querySelector('[data-slot="reasoning-part-body"]')).toBeNull()
    setPart("text", part.text + " The new chunk must not reopen a reader's collapsed row.")
    await settle()
    expect(toggle.getAttribute("aria-expanded")).toBe("false")

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
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning (15s)")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    // A reader's choice survives the row being remounted (steps hidden and shown again).
    cleanups.splice(0).forEach((cleanup) => cleanup())
    document.body.replaceChildren()
    const again = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    expect(again.querySelector('[data-slot="reasoning-part-toggle"]')?.getAttribute("aria-expanded")).toBe("true")
    expect(again.querySelector('[data-slot="reasoning-part-body"]')).not.toBeNull()
  })

  test("an aborted turn shows a plain Reasoning label when reasoning never reported its end", async () => {
    const message = assistant(Date.now())
    const part = reasoning("prt_aborted", { start: Date.now() - 40_000 })
    const host = mount(() => parts.Part({ part, message, hideCopy: true }), empty())
    await settle()
    const row = host.querySelector('[data-component="reasoning-part"]')!
    const toggle = row.querySelector('[data-slot="reasoning-part-toggle"]')!
    expect(row.getAttribute("data-live")).toBeNull()
    expect(toggle.querySelector('[data-component="spinner"]')).toBeNull()
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning")
  })

  test("compact mode folds completed reasoning the reader never opened", async () => {
    const message = assistant(Date.now())
    const part = reasoning("prt_folded", { start: 1_000, end: 1_800 })
    const host = mount(
      () => parts.Part({ part, message, hideCopy: true }),
      empty(),
      () => "compact",
    )
    await settle()
    const toggle = host.querySelector('[data-slot="reasoning-part-toggle"]')!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    // Under one second the clock stays quiet rather than reading "Thinking (0s)".
    expect(toggle.querySelector('[data-slot="reasoning-part-title"]')?.textContent).toBe("Reasoning")
    expect(host.querySelector('[data-slot="reasoning-part-body"]')).toBeNull()
  })

  test("new rows follow mode changes while explicit collapse is remembered", async () => {
    const [mode, setMode] = reactive.createStore<{ value: "detailed" | "compact" }>({ value: "compact" })
    const part = reasoning("prt_mode", { start: 1_000, end: 2_000 })
    const host = mount(
      () => parts.Part({ part, message: assistant(2_000), hideCopy: true }),
      empty(),
      () => mode.value,
    )
    const toggle = () => host.querySelector<HTMLButtonElement>('[data-slot="reasoning-part-toggle"]')!
    await settle()
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    setMode("value", "detailed")
    await settle()
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    toggle().click()
    setMode("value", "compact")
    setMode("value", "detailed")
    await settle()
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
  })

  test("explains redacted-only reasoning without pretending there is readable text to expand", async () => {
    const part = { ...reasoning("prt_redacted", { start: 1_000, end: 2_000 }), text: "[REDACTED]" }
    const host = mount(() => parts.Part({ part, message: assistant(2_000), hideCopy: true }), empty())
    await settle()
    expect(host.querySelector('[data-origin="provider-reasoning-unavailable"]')?.textContent).toBe(
      "The model did not provide readable reasoning.",
    )
    expect(host.querySelector('[data-slot="reasoning-part-toggle"]')).toBeNull()
    expect(host.textContent).not.toContain("[REDACTED]")
  })

  test("a completed redacted-only turn retains its activity disclosure in Detailed mode", async () => {
    const message = assistant(2_000)
    const part = { ...reasoning("prt_redacted_turn", { start: 1_000, end: 2_000 }), text: "[REDACTED]" }
    const store: Store = {
      ...empty(),
      message: { [sessionID]: [user, message] },
      part: { [user.id]: [], [message.id]: [part] },
    }
    const host = mount(
      () => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id, stepsExpanded: true }),
      store,
    )
    await settle()
    expect(host.querySelector('[data-slot="session-turn-collapsible-trigger-content"]')).not.toBeNull()
    expect(host.querySelector('[data-origin="provider-reasoning-unavailable"]')).not.toBeNull()
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
  test("detailed mode keeps completed operations individually visible", async () => {
    const message = assistant(5_000)
    const store: Store = {
      ...empty(),
      message: { [sessionID]: [user, message] },
      part: {
        [user.id]: [],
        [message.id]: [read("prt_detail1", "paper.tex", 1_000), read("prt_detail2", "analysis.py", 2_000)],
      },
    }
    const host = mount(() => turn.SessionTurn({ sessionID, messageID: user.id, stepsExpanded: true }), store)
    await ready(() => host.querySelectorAll('[data-component="tool-part-wrapper"]').length === 2)
    expect(host.querySelector('[data-component="trace-run-group"]')).toBeNull()
    expect(host.textContent).toContain("paper.tex")
    expect(host.textContent).toContain("analysis.py")
  })

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
      () => "compact",
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
      () => "compact",
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

describe("execution inspection", () => {
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
    const host = mount(
      () => turn.SessionTurn({ sessionID, messageID: user.id, lastUserMessageID: user.id, stepsExpanded: true }),
      store,
    )
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
      const [view, setView] = reactive.createStore({ expanded: true })
      const host = mount(
        () =>
          turn.SessionTurn({
            sessionID,
            messageID: user.id,
            lastUserMessageID: user.id,
            get stepsExpanded() {
              return view.expanded
            },
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
      expect(host.querySelector('[data-slot="session-turn-response-trigger"] [data-component="spinner"]')).toBeNull()
      expect(host.querySelector('[data-slot="session-turn-retry-message"]')).toBeNull()
      expect(host.querySelector('[data-slot="session-turn-progress-hint"]')).toBeNull()

      const tool = host.querySelector('[data-component="tool-part-wrapper"]')!
      tool.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click()
      await ready(() => tool.querySelector('[data-component="shell-output"] pre') !== null)
      expect(tool.querySelector('[data-component="shell-output"] pre')?.textContent).toContain("measurement=17")
      expect(tool.getAttribute("data-tool-status")).toBe("completed")

      setView("expanded", false)
      await settle()
      expect(host.querySelectorAll('[data-slot="session-state-message"]')).toHaveLength(1)
      expect(host.querySelector('[data-slot="session-state-message"]')?.textContent).toBe(timeout.data.message)
      expect(host.textContent).toContain(partial.text)

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
      expect(
        host.querySelector('[data-slot="session-turn-response-trigger"] [data-component="spinner"]'),
      ).not.toBeNull()
    },
  )
})
