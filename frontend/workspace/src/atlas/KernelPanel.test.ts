import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")
const source = () => read("./KernelPanel.tsx")
const card = () => read("./KernelCard.tsx")
const command = () => read("./CommandCard.tsx")
const remote = () => read("./RemoteJobCard.tsx")

describe("project Compute inventory", () => {
  test("shows live, actionable, and bounded successful compute in one project inventory", () => {
    const panel = source()

    expect(panel).toContain('aria-label="Project compute"')
    expect(panel).toContain("[...grouped().keys()].sort")
    expect(panel).toContain("<For each={groups()}>")
    expect(panel).toContain("<em>Current</em>")
    expect(panel).toContain("kernelRequest<KernelsPayload>(kernelAPI.inventory")
    expect(panel).toContain("kernelRequest<CommandsPayload>(kernelAPI.commands")
    expect(panel).not.toContain("createExecutionHistoryAPI")
    expect(panel).not.toContain("/trace")
    expect(panel).not.toContain("<ExecutionCard")
    expect(panel).not.toContain("<TraceKernelCard")
    expect(panel).not.toContain("<ResearchActivityCard")
    expect(panel).toContain("jobApi.list()")
    expect(panel).toContain("visibleJobs(jobs)")
    expect(panel).toContain("<RemoteJobCard")
    expect(panel).toContain('data-location="local"')
    expect(panel).not.toContain('data-location="research"')
    expect(panel).toContain('data-location="remote"')
    expect(panel).toContain('kernel.state === "running" || kernel.state === "starting"')
    expect(panel).toContain("kernel.sessionID === route() && kernel.active")
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
    expect(panel).toContain("kernelRequest<KernelStatus>(kernelAPI.control(kernel.id, action)")
    expect(panel).toContain("kernelRequest<{ stopped: boolean }>(kernelAPI.stopCommand(command.id)")
    expect(panel).toContain('recover(job, "retry")')
    expect(panel).toContain('recover(job, "release")')
  })

  test("polls the two live feeds without loading conversation history", () => {
    const panel = source()

    expect(panel).toContain("if (document.hidden) return")
    expect(panel).toContain("setInterval(refresh, 2_500)")
    expect(panel).toContain('document.addEventListener("visibilitychange", refresh)')
    expect(panel).toContain('document.removeEventListener("visibilitychange", refresh)')
    expect(panel).toContain("const [runtime, runtimeApi] = createResource")
    expect(panel).toContain("const [remote, remoteApi] = createResource")
    expect(panel).toContain("if (!runtime.loading)")
    expect(panel).toContain('setView("remote"')
    expect(panel).not.toContain("Execution history unavailable")
    expect(panel).not.toContain("Research activity")
    expect(panel).toContain("Remote jobs unavailable")
  })

  test("uses quiet live cards without completed search or run history", () => {
    const panel = source()
    const cards = `${card()}\n${command()}\n${remote()}`

    expect(panel).toContain("No compute activity yet")
    expect(panel).toContain("Nothing is running")
    expect(panel).toContain("Python, R, shell, and governed remote jobs")
    expect(panel).not.toContain("Sources and delegated tasks")
    expect(panel).not.toContain("Recent runs")
    expect(panel).not.toContain("Recent jobs")
    expect(panel).not.toContain("websearch")
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
