import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./KernelPanel.tsx", import.meta.url)), "utf8")
const card = () => readFileSync(fileURLToPath(new URL("./KernelCard.tsx", import.meta.url)), "utf8")
const command = () => readFileSync(fileURLToPath(new URL("./CommandCard.tsx", import.meta.url)), "utf8")
const remote = () => readFileSync(fileURLToPath(new URL("./RemoteJobCard.tsx", import.meta.url)), "utf8")

describe("live compute inventory", () => {
  test("is project-wide and stays mounted across session changes", () => {
    const panel = source()

    expect(panel).toContain('aria-label="Live project compute"')
    expect(panel).toContain("[...grouped().keys()].sort")
    expect(panel).toContain("<For each={groups()}>")
    expect(panel).toContain("<em>current</em>")
    expect(panel).toContain("{ client }")
    expect(panel).not.toContain("{ sessionID: params.id, client }")
    expect(panel).toContain('request<CommandsPayload>("/notebook/commands"')
    expect(panel).toContain("<CommandCard")
    expect(panel).toContain("jobApi.list()")
    expect(panel).toContain("<RemoteJobCard")
    expect(panel).not.toContain("KernelResultCard")
    expect(panel).not.toContain("recentLocal")
    expect(panel).not.toContain('aria-label="Recent local results"')
    expect(panel).toContain('aria-label="Recent remote results"')
    expect(panel).toContain('kernels.filter((kernel) => kernel.active || kernel.state === "starting")')
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
    const panel = `${source()}\n${card()}\n${command()}\n${remote()}`

    expect(panel).toContain("/stop`")
    expect(panel).toContain("kernelCanStop")
    expect(panel).toContain("Stop this")
    expect(panel).toContain("the next agent run will start fresh")
    expect(panel).toContain("Its child processes were terminated")
    expect(panel).toContain("provider cleanup")
    expect(panel).toContain("jobLive")
  })

  test("polls unconditionally so an agent-started kernel appears", () => {
    const panel = source()

    expect(panel).toContain("if (document.hidden) return")
    expect(panel).toContain("setInterval(refresh, 2_500)")
    expect(panel).toContain('document.addEventListener("visibilitychange", refresh)')
    expect(panel).toContain('document.removeEventListener("visibilitychange", refresh)')
    expect(panel).toContain("Promise.all([")
    expect(panel).toContain("jobApi.list()")
  })

  test("explains idle and degraded states without claiming a failed poll is empty", () => {
    const panel = source()

    expect(panel).toContain("No live compute")
    expect(panel).toContain(
      "Kernels, commands, and remote jobs appear here the moment any session starts computing in this project.",
    )
    expect(panel).toContain('{view.error ? "Compute inventory unavailable" : "No live compute"}')
    expect(panel).toContain("The last poll could not read this project's kernels, commands, and remote jobs")
  })
})
