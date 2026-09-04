import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createRoot } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { dict as en } from "../i18n/en"
import { resolveBasicToolChildren, type BasicToolProps } from "./basic-tool"

// Render the real BasicTool row in jsdom so the status rail, the running verb,
// and the disclosure state are checked against live DOM rather than source.
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
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const reactive = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const subject = (await vite.ssrLoadModule("@synsci/ui/basic-tool")) as typeof import("./basic-tool")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const mount = (initial: BasicToolProps) => {
  const [props, setProps] = reactive.createStore<BasicToolProps>(initial)
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.BasicTool(props), host))
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!
  const status = () => host.querySelector('[data-slot="basic-tool-tool-status"]')
  return { host, setProps, trigger, status }
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(() => vite.close())

describe("BasicTool children", () => {
  test("constructs a stateful child once when the resolved content is read repeatedly", () => {
    let constructions = 0

    createRoot((dispose) => {
      const content = resolveBasicToolChildren(() => {
        constructions++
        return "stateful child"
      })

      expect(content()).toBe("stateful child")
      expect(content()).toBe("stateful child")
      expect(content()).toBe("stateful child")
      expect(constructions).toBe(1)
      dispose()
    })
  })
})

describe("tool row lifecycle", () => {
  test("a live call reads as one verb line with a spinner and a ticking clock", async () => {
    const { host, setProps, trigger, status } = mount({
      icon: "glasses",
      tool: "read",
      status: "running",
      time: { start: Date.now() - 12_400 },
      trigger: { title: "Read", subtitle: "paper.tex" },
    })
    await settle()
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Reading")
    expect(status()?.getAttribute("data-outcome")).toBe("running")
    expect(status()?.querySelector('[data-component="spinner"]')).not.toBeNull()
    expect(status()?.querySelector('[data-slot="basic-tool-tool-time"]')?.textContent).toBe("12s")
    expect(status()?.querySelector('[data-slot="basic-tool-tool-glyph"]')?.getAttribute("aria-label")).toBe("Running")
    // No body yet, so the row is a button that has nothing to expand.
    expect(trigger().tagName).toBe("BUTTON")
    expect(host.querySelector('[data-slot="collapsible-arrow"]')).toBeNull()

    setProps({ status: "completed", time: { start: Date.now() - 3_400, end: Date.now() } })
    await settle()
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Read")
    expect(status()?.getAttribute("data-outcome")).toBe("done")
    expect(status()?.querySelector('[data-component="spinner"]')).toBeNull()
    expect(status()?.querySelector('[data-slot="basic-tool-tool-glyph"]')?.getAttribute("aria-label")).toBe("Done")
    expect(status()?.querySelector('[data-slot="basic-tool-tool-time"]')?.textContent).toBe("3.4s")
  })

  test("output stays collapsed behind a one-line receipt until the reader opens it", async () => {
    const { host, trigger } = mount({
      icon: "console",
      tool: "bash",
      status: "completed",
      time: { start: 1_000, end: 1_400 },
      summary: [
        { key: "ui.tool.summary.exit", params: { code: 2 } },
        { key: "ui.tool.summary.lines.other", params: { count: 12 } },
      ],
      trigger: { title: "Shell", subtitle: "Run the checks" },
      get children() {
        const output = document.createElement("div")
        output.setAttribute("data-slot", "test-output")
        output.textContent = "12 lines of output"
        return output
      },
    })
    await settle()
    expect(host.querySelector('[data-slot="basic-tool-tool-detail"]')?.textContent).toBe("exit 2 · 12 lines")
    // Sub-second durations stay quiet; the reserved clock slot keeps its place.
    expect(host.querySelector('[data-slot="basic-tool-tool-time"]')?.textContent).toBe("")
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector('[data-slot="test-output"]')).toBeNull()
    expect(host.querySelector('[data-slot="collapsible-arrow"]')).not.toBeNull()

    trigger().click()
    await settle()
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[data-slot="test-output"]')?.textContent).toBe("12 lines of output")

    trigger().click()
    await settle()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector('[data-slot="test-output"]')).toBeNull()
  })

  test("a failure keeps the tool's own row, shows the first error line inline, and folds the detail", async () => {
    const { host, trigger, status } = mount({
      icon: "glasses",
      tool: "read",
      status: "error",
      time: { start: 1_000, end: 1_200 },
      error: "Error: File not found: paper.pdf\nStack trace line",
      trigger: { title: "Read", subtitle: "paper.pdf" },
    })
    await settle()
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Read")
    expect(status()?.getAttribute("data-outcome")).toBe("error")
    expect(status()?.querySelector('[data-slot="basic-tool-tool-glyph"]')?.getAttribute("aria-label")).toBe("Failed")
    const detail = host.querySelector('[data-slot="basic-tool-tool-detail"]')
    expect(detail?.textContent).toBe("File not found: paper.pdf")
    expect(detail?.getAttribute("data-error")).toBe("true")
    expect(host.querySelector('[data-slot="basic-tool-failure"]')).toBeNull()

    trigger().click()
    await settle()
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    const failure = host.querySelector('[data-slot="basic-tool-failure"]')
    expect(failure?.getAttribute("data-variant")).toBe("error")
    expect(failure?.querySelector('[data-slot="message-part-tool-error-title"]')?.textContent).toBe("File not found")
    expect(failure?.querySelector('[data-slot="message-part-tool-error-message"]')?.textContent).toContain("paper.pdf")
  })

  test("an aborted call is marked cancelled, not failed", async () => {
    const { status } = mount({
      icon: "console",
      tool: "bash",
      status: "error",
      error: "Tool execution aborted",
      trigger: { title: "Shell" },
    })
    await settle()
    expect(status()?.getAttribute("data-outcome")).toBe("cancelled")
    expect(status()?.querySelector('[data-slot="basic-tool-tool-glyph"]')?.getAttribute("aria-label")).toBe("Cancelled")
    expect(status()?.querySelector('[data-slot="basic-tool-tool-detail"]')?.textContent).toBe("Tool execution aborted")
  })

  test("rows without lifecycle props render no status rail", async () => {
    const { host, status } = mount({ icon: "console", trigger: { title: "Checked environment · 2 steps" } })
    await settle()
    expect(status()).toBeNull()
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Checked environment · 2 steps")
  })
})

describe("trajectory strings", () => {
  test("every running verb, status label, receipt, and reasoning clock exists in every locale", async () => {
    const keys = Object.keys(en).filter(
      (key) =>
        key.startsWith("ui.tool.running.") ||
        key.startsWith("ui.tool.status.") ||
        key.startsWith("ui.tool.summary.") ||
        key.startsWith("ui.tool.calls.") ||
        key === "ui.messagePart.reasoning.thinking",
    )
    expect(keys.length).toBe(25)
    const dir = fileURLToPath(new URL("../i18n/", import.meta.url))
    const locales = readdirSync(dir).filter((file) => file.endsWith(".ts"))
    expect(locales.length).toBe(15)
    for (const file of locales) {
      const mod = (await import(`${dir}${file}`)) as { dict: Record<string, string> }
      for (const key of keys) {
        expect(`${file}:${key}:${mod.dict[key] ?? ""}`).not.toBe(`${file}:${key}:`)
        for (const name of en[key as keyof typeof en].match(/{{\w+}}/g) ?? []) {
          expect(`${file}:${key}:${mod.dict[key]}`).toContain(name)
        }
      }
    }
  })
})
