import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./KernelPanel.tsx", import.meta.url)), "utf8")
const card = () => readFileSync(fileURLToPath(new URL("./KernelCard.tsx", import.meta.url)), "utf8")

describe("live kernel inventory", () => {
  test("is project-wide and stays mounted across session changes", () => {
    const panel = source()

    expect(panel).toContain('aria-label="Live project kernels"')
    expect(panel).toContain("[...grouped().keys()].sort")
    expect(panel).toContain("<For each={groups()}>")
    expect(panel).toContain("<em>current</em>")
    expect(panel).toContain("{ client }")
    expect(panel).not.toContain("{ sessionID: params.id, client }")
  })

  test("does not expose any manual kernel creation or restart path", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).not.toContain("New kernel")
    expect(panel).not.toContain("Create kernel")
    expect(panel).not.toContain("Create named kernel")
    expect(panel).not.toContain("Saved environments")
    expect(panel).not.toContain("useExecutionAuthority")
    expect(panel).not.toContain('"restart"')
    expect(panel).not.toContain('"interrupt"')
    expect(panel).not.toContain('"delete"')
    expect(panel).not.toContain('method: "DELETE"')
    expect(panel).toContain('export type KernelAction = "stop"')
  })

  test("keeps one safe control for an already-live process", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain("/stop`")
    expect(panel).toContain("kernelCanStop")
    expect(panel).toContain("Stop this")
    expect(panel).toContain("the next agent run will start fresh")
  })

  test("polls unconditionally so an agent-started kernel appears", () => {
    const panel = source()

    expect(panel).toContain("if (document.hidden) return")
    expect(panel).toContain("setInterval(refresh, 2_500)")
    expect(panel).toContain('document.addEventListener("visibilitychange", refresh)')
    expect(panel).toContain('document.removeEventListener("visibilitychange", refresh)')
    expect(panel).toContain("inventory(request<KernelsPayload>")
  })

  test("explains idle and degraded states without claiming a failed poll is empty", () => {
    const panel = source()

    expect(panel).toContain("No live kernels")
    expect(panel).toContain("Kernels appear here the moment any session starts computing in this project.")
    expect(panel).toContain('{view.error ? "Kernel inventory unavailable" : "No live kernels"}')
    expect(panel).toContain("The last poll could not read this project's kernels")
  })
})
