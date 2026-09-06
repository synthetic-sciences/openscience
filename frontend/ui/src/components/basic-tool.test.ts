import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createRoot } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { dict as en } from "../i18n/en"
import { resolveBasicToolChildren, type BasicToolProps } from "./basic-tool"

// Check the classic compact row and lifecycle semantics against live DOM.
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
  test("preparing, running and completed calls share one stable compact row", async () => {
    const { host, setProps, trigger, status } = mount({
      icon: "glasses",
      tool: "read",
      status: "pending",
      time: { start: Date.now() - 12_400 },
      trigger: { title: "Read", subtitle: "paper.tex" },
    })
    await settle()
    const row = trigger()
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Read")
    expect(status()?.getAttribute("data-outcome")).toBe("pending")
    expect(status()?.getAttribute("aria-label")).toBe("Preparing")
    expect(status()?.querySelector('[data-component="spinner"]')).toBeNull()
    expect(status()?.querySelector('[data-icon="clock"]')).not.toBeNull()

    setProps("status", "running")
    await settle()
    expect(status()?.getAttribute("data-outcome")).toBe("running")
    expect(status()?.querySelector('[data-component="spinner"]')).not.toBeNull()
    expect(status()?.getAttribute("aria-label")).toBe("Running")
    expect(host.querySelector('[data-slot="basic-tool-tool-time"]')).toBeNull()
    expect(host.textContent?.trim()).toBe("Readpaper.tex")
    // No body yet, so the row is a button that has nothing to expand.
    expect(trigger().tagName).toBe("BUTTON")
    expect(host.querySelector('[data-slot="collapsible-arrow"]')).toBeNull()

    setProps({ status: "completed", time: { start: Date.now() - 3_400, end: Date.now() } })
    await settle()
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Read")
    expect(status()?.getAttribute("data-outcome")).toBe("done")
    expect(status()?.querySelector('[data-component="spinner"]')).toBeNull()
    expect(status()?.getAttribute("aria-label")).toBe("Done")
    expect(status()?.querySelector('[data-icon="glasses"]')).not.toBeNull()
    expect(host.textContent?.trim()).toBe("Readpaper.tex")
    expect(trigger()).toBe(row)
  })

  test("output and receipt counts stay out of the compact row until opened or inspected", async () => {
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
    expect(host.querySelector('[data-slot="basic-tool-tool-detail"]')).toBeNull()
    expect(host.querySelector('[data-slot="basic-tool-tool-time"]')).toBeNull()
    expect(host.querySelector('[data-slot="basic-tool-tool-status"]')?.getAttribute("title")).toContain("12 lines")
    expect(host.textContent?.trim()).toBe("ShellRun the checks")
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

  test("a failure keeps the tool and filename visible with an explicit label and expandable error", async () => {
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
    expect(status()?.getAttribute("aria-label")).toBe("Failed")
    const label = host.querySelector('[data-slot="basic-tool-tool-failure-label"]')
    expect(label?.textContent).toBe("Failed")
    expect(label?.getAttribute("title")).toBe("File not found: paper.pdf")
    expect(host.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toBe("paper.pdf")
    expect(host.querySelector('[data-slot="basic-tool-failure"]')).toBeNull()

    trigger().click()
    await settle()
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    const failure = host.querySelector('[data-slot="basic-tool-failure"]')
    expect(failure?.getAttribute("data-variant")).toBe("error")
    expect(failure?.querySelector('[data-slot="message-part-tool-error-title"]')?.textContent).toBe("File not found")
    expect(failure?.querySelector('[data-slot="message-part-tool-error-message"]')?.textContent).toContain("paper.pdf")
  })

  test("an aborted call remains a cancellation when its details are opened", async () => {
    const { host, trigger, status } = mount({
      icon: "console",
      tool: "bash",
      status: "error",
      error: "Tool execution aborted",
      trigger: { title: "Shell" },
      get children() {
        const command = document.createElement("pre")
        command.textContent = "$ python optional_check.py\nPartial output remains available"
        return command
      },
    })
    await settle()
    expect(status()?.getAttribute("data-outcome")).toBe("cancelled")
    expect(status()?.getAttribute("aria-label")).toBe("Cancelled")
    expect(status()?.getAttribute("title")).toContain("Tool execution aborted")
    expect(host.querySelector('[data-slot="basic-tool-tool-failure-label"]')?.textContent).toBe("Cancelled")
    trigger().click()
    await settle()
    expect(host.querySelector('[data-slot="message-part-tool-error-title"]')?.textContent).toBe("Bash cancelled")
    expect(host.querySelector('[data-slot="basic-tool-failure"]')?.getAttribute("data-variant")).toBe("normal")
    expect(host.querySelector("pre")?.textContent).toBe("$ python optional_check.py\nPartial output remains available")
  })

  test("a nonzero command exit is visibly unsuccessful while retaining its output receipt", async () => {
    const { host, status } = mount({
      icon: "console",
      tool: "bash",
      status: "completed",
      metadata: { exit: 2 },
      summary: [{ key: "ui.tool.summary.exit", params: { code: 2 } }],
      trigger: { title: "Shell", subtitle: "Check project" },
    })
    await settle()
    expect(status()?.getAttribute("data-outcome")).toBe("error")
    expect(status()?.getAttribute("aria-label")).toBe("Failed")
    expect(host.querySelector('[data-slot="basic-tool-tool-failure-label"]')?.textContent).toBe("Failed")
    expect(status()?.getAttribute("title")).toContain("exit 2")
  })

  test("rows without lifecycle props keep their icon without inventing a status", async () => {
    const { host, status } = mount({ icon: "console", trigger: { title: "Checked environment · 2 steps" } })
    await settle()
    expect(status()?.hasAttribute("data-outcome")).toBe(false)
    expect(status()?.hasAttribute("aria-label")).toBe(false)
    expect(status()?.querySelector('[data-icon="console"]')).not.toBeNull()
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
    expect(keys.length).toBe(26)
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
