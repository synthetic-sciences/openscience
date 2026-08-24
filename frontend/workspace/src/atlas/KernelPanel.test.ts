import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")
const source = () => read("./KernelPanel.tsx")
const cards = () => [read("./KernelCard.tsx"), read("./CommandCard.tsx"), read("./RemoteJobCard.tsx")].join("\n")

describe("project Compute tracker", () => {
  test("reads only the live project inventories", () => {
    const panel = source()

    expect(panel).toContain('aria-label="Project compute"')
    expect(panel).toContain("kernelRequest<KernelsPayload>(kernelAPI.inventory")
    expect(panel).toContain("kernelRequest<CommandsPayload>(kernelAPI.commands")
    expect(panel).toContain('request<Job[]>("/settings/compute/jobs"')
    expect(panel).toContain("visibleJobs(jobs)")
    expect(panel).not.toContain('method: "POST"')
    expect(panel).not.toContain("kernelAPI.control")
    expect(panel).not.toContain("kernelAPI.stopCommand")
    expect(panel).not.toContain("/cancel")
    expect(panel).not.toContain("/retry")
    expect(panel).not.toContain("/release")
    expect(panel).not.toContain("/log")
  })

  test("tracks warm kernels from every session and groups the current one first", () => {
    const panel = source()

    expect(panel).toContain('kernel.active || kernel.state === "starting" || kernel.state === "running"')
    expect(panel).not.toContain("kernel.sessionID === route() && kernel.active")
    expect(panel).toContain("Number(route() === b) - Number(route() === a)")
    expect(panel).toContain("Other sessions")
    expect(panel).toContain("<em>Current</em>")
    expect(panel).toContain("summary().kinds")
    expect(panel).toContain("summary().memory")
    expect(panel).toContain("summary().cpu")
  })

  test("polls while visible without loading conversation or completed history", () => {
    const panel = source()

    expect(panel).toContain("if (document.hidden) return")
    expect(panel).toContain("setInterval(refresh, 2_500)")
    expect(panel).toContain('document.addEventListener("visibilitychange", refresh)')
    expect(panel).toContain('document.removeEventListener("visibilitychange", refresh)')
    expect(panel).not.toContain("createExecutionHistoryAPI")
    expect(panel).not.toContain("ExecutionCard")
    expect(panel).not.toContain("Recent runs")
    expect(panel).not.toContain("Recent jobs")
  })

  test("keeps successful inventories visible when a later poll fails", () => {
    const panel = source()

    expect(panel).toContain("info.value")
    expect(panel).toContain("Showing the last successful compute inventory.")
    expect(panel).toContain('data-state={state().stale ? "stale" : "unavailable"}')
  })

  test("advances row samples only when the combined runtime inventory succeeds", () => {
    const panel = source()

    expect(panel).toContain('setView("sample", (value) => value + 1)')
    expect(panel).toContain("<KernelCard kernel={kernel} sample={view.sample} />")
    expect(panel).toContain("<CommandCard command={command} sample={view.sample} />")
  })

  test("renders a flat passive ledger, not a tutorial or control surface", () => {
    const panel = source()
    const rows = cards()

    expect(panel).toContain("No active compute")
    expect(panel).toContain("The live inventory could not be read")
    expect(panel).not.toContain("How compute works")
    expect(panel).not.toContain("Ready when needed")
    expect(panel).not.toContain("activity-boundary")
    expect(rows).toContain('class="compute-row')
    expect(rows).not.toContain("<button")
    expect(rows).not.toContain("<details")
    expect(rows).not.toContain("<summary")
    expect(rows).not.toContain("<pre")
  })
})
