import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")
const source = () => read("./KernelPanel.tsx")
const card = () => read("./KernelCard.tsx")
const command = () => read("./CommandCard.tsx")
const remote = () => read("./RemoteJobCard.tsx")
const execution = () => read("./ExecutionCard.tsx")
const research = () => read("./ResearchActivityCard.tsx")

describe("project Compute inventory", () => {
  test("merges current-session execution history into the project-wide live inventory", () => {
    const panel = source()

    expect(panel).toContain('aria-label="Project compute"')
    expect(panel).toContain("[...grouped().keys()].sort")
    expect(panel).toContain("<For each={groups()}>")
    expect(panel).toContain("<em>Current</em>")
    expect(panel).toContain('request<KernelsPayload>("/kernels"')
    expect(panel).toContain('request<CommandsPayload>("/kernels/commands"')
    expect(panel).toContain("createExecutionHistoryAPI(transport)")
    expect(panel).toContain("historyApi.list(sessionID)")
    expect(panel).toContain("`/session/${encodeURIComponent(sessionID)}/trace`")
    expect(panel).toContain("recentObservableResearch(trace)")
    expect(panel).toContain("<ExecutionCard")
    expect(panel).toContain("<ResearchActivityCard")
    expect(panel).toContain("jobApi.list()")
    expect(panel).toContain("<RemoteJobCard")
    expect(panel).toContain('data-location="local"')
    expect(panel).toContain('data-location="research"')
    expect(panel).toContain('data-location="remote"')
    expect(panel).toContain('kernels.filter((kernel) => kernel.active || kernel.state === "starting")')
  })

  test("keeps only controls for work that already exists", () => {
    const panel = `${source()}\n${card()}\n${command()}\n${remote()}`

    expect(panel).not.toContain("New kernel")
    expect(panel).not.toContain("Create kernel")
    expect(panel).not.toContain("Create named kernel")
    expect(panel).not.toContain("Saved environments")
    expect(panel).not.toContain("useExecutionAuthority")
    expect(panel).not.toContain('"interrupt"')
    expect(panel).not.toContain('"delete"')
    expect(panel).not.toContain('method: "DELETE"')
    expect(panel).toContain('export type KernelAction = "restart" | "stop"')
    expect(panel).toContain("kernelCanStop")
    expect(panel).toContain("Runtime restarted")
    expect(panel).toContain("Runtime stopped")
    expect(panel).toContain("Its child processes were terminated")
    expect(panel).toContain("provider cleanup")
    expect(panel).toContain('recover(job, "retry")')
    expect(panel).toContain('recover(job, "release")')
  })

  test("polls without blocking live work when history or remote jobs degrade", () => {
    const panel = source()

    expect(panel).toContain("if (document.hidden) return")
    expect(panel).toContain("setInterval(refresh, 2_500)")
    expect(panel).toContain('document.addEventListener("visibilitychange", refresh)')
    expect(panel).toContain('document.removeEventListener("visibilitychange", refresh)')
    expect(panel).toContain("Promise.all([")
    expect(panel).toContain('setView("history"')
    expect(panel).toContain('setView("research"')
    expect(panel).toContain('setView("remote"')
    expect(panel).toContain("Execution history unavailable")
    expect(panel).toContain("Research activity unavailable")
    expect(panel).toContain("Remote jobs unavailable")
  })

  test("uses quiet result-first cards and keeps implementation detail collapsed", () => {
    const panel = source()
    const cards = `${card()}\n${command()}\n${remote()}\n${execution()}\n${research()}`

    expect(panel).toContain("Work appears here automatically")
    expect(panel).toContain("Delegated research, source activity, Python and R results")
    expect(panel).toContain("Delegated tasks and external sources")
    expect(panel).toContain('class="kernel-session__summary"')
    expect(panel).toContain("summary().kinds")
    expect(panel).not.toContain("summary().memory")
    expect(panel).not.toContain("summary().cpu")
    expect(cards).toContain('class="activity-card__header"')
    expect(cards).toContain('class="activity-card__status"')
    expect(cards).toContain('class="activity-disclosure"')
    expect(cards).not.toContain("IconBraces")
    expect(cards).not.toContain("IconTerminal")
  })
})
