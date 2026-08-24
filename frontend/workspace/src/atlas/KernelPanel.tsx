import { For, Show, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { identify } from "@/atlas/poll-identity"
import { KernelCard } from "@/atlas/KernelCard"
import { CommandCard } from "@/atlas/CommandCard"
import type { Job } from "@/atlas/ComputeJobsAPI"
import { RemoteJobCard, visibleJobs } from "@/atlas/RemoteJobCard"
import { useKernelList } from "@/atlas/use-kernel-list"
import { useStableList } from "@/atlas/use-stable-list"
import { createKernelRouteRequester, kernelAPI, type KernelRoute } from "@/atlas/kernel-api"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { kernelMemoryLabel, type CommandStatus, type KernelStatus } from "@/atlas/kernel-runtime"

type KernelsPayload = { kernels: KernelStatus[] }
type CommandsPayload = { commands: CommandStatus[] }
type RuntimePayload = KernelsPayload & CommandsPayload
type Group = {
  kernels: KernelStatus[]
  commands: CommandStatus[]
  jobs: Job[]
}
const projectJobs = "__project_jobs__"

type KernelPanelProps = {
  request?: (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>
}

export function inventory<T>(
  request: Promise<T>,
  settled: (error: string) => void,
  previous?: T,
  completed?: () => void,
) {
  return request.then(
    (value) => {
      settled("")
      completed?.()
      return value
    },
    (error) => {
      settled(error instanceof Error ? error.message : String(error))
      return previous
    },
  )
}

export function freshness(view: { runtime: string; remote: string; runtimeSeen: boolean; remoteSeen: boolean }) {
  const problem = view.runtime || view.remote
  const stale = Boolean(problem) && view.runtimeSeen && view.remoteSeen
  const ready = view.runtimeSeen && view.remoteSeen && !problem
  const empty = problem
    ? stale
      ? "Compute activity may be out of date"
      : "Compute unavailable"
    : ready
      ? "No active compute"
      : "Reading compute…"
  return { problem, stale, empty }
}

export const usage = (group: Group) => {
  const entries = [...group.kernels, ...group.commands]
  const memory = entries.reduce((total, entry) => total + (entry.resources?.memory_bytes ?? 0), 0)
  const cpu = entries.reduce((total, entry) => total + (entry.resources?.cpu_percent ?? 0), 0) / 100
  const kinds = [
    group.kernels.length ? `${group.kernels.length} ${group.kernels.length === 1 ? "kernel" : "kernels"}` : undefined,
    group.commands.length
      ? `${group.commands.length} ${group.commands.length === 1 ? "command" : "commands"}`
      : undefined,
    group.jobs.length ? `${group.jobs.length} ${group.jobs.length === 1 ? "job" : "jobs"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  const ram = entries.some((entry) => entry.resources?.memory_bytes !== undefined) ? kernelMemoryLabel(memory) : "— RSS"
  const cores = entries.some((entry) => entry.resources?.cpu_percent !== undefined)
    ? `${cpu.toFixed(1)} cores`
    : "— cores"
  return { kinds, memory: ram, cpu: cores }
}

const emptyGroup = (): Group => ({ kernels: [], commands: [], jobs: [] })

export function KernelPanel(props: KernelPanelProps = {}): JSX.Element {
  const transport = props.request ?? useSDK().request
  const routeRequest = createKernelRouteRequester(transport)
  const sync = useSync()
  const params = useParams()
  const client = identify()
  const [view, setView] = createStore({
    runtime: "",
    remote: "",
    runtimeSeen: false,
    remoteSeen: false,
    sample: 0,
  })
  const read = async <T,>(response: Response) => {
    if (response.ok) {
      const body = await response.text()
      if (!body) return undefined as T
      return JSON.parse(body) as T
    }
    const detail = await response.text().catch(() => "")
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  const request = <T,>(path: string, init?: RequestInit, query?: Record<string, string>) =>
    transport(path, init, query).then(read<T>)
  const kernelRequest = <T,>(route: KernelRoute, init?: RequestInit, query?: Record<string, string>) =>
    routeRequest(route, init, query).then(read<T>)
  const route = () => (params.id && params.id !== "new" ? params.id : undefined)
  const load = (_: string, info: { value: RuntimePayload | undefined }) =>
    inventory(
      Promise.all([
        kernelRequest<KernelsPayload>(kernelAPI.inventory, undefined, { client }),
        kernelRequest<CommandsPayload>(kernelAPI.commands, undefined, { client }),
      ]).then(([kernels, commands]) => ({ kernels: kernels.kernels, commands: commands.commands })),
      (error) => setView("runtime", error),
      info.value,
      () => {
        setView("runtimeSeen", true)
        setView("sample", (value) => value + 1)
      },
    ).then((value) => value ?? info.value ?? { kernels: [], commands: [] })

  // Route changes refetch immediately; the timer only keeps the passive
  // tracker fresh while it is visible.
  const [runtime, runtimeApi] = createResource(() => route() ?? projectJobs, load)
  const [remote, remoteApi] = createResource<Job[]>((_, info) =>
    inventory(
      request<Job[]>("/settings/compute/jobs", { cache: "no-store" }),
      (error) => setView("remote", error),
      info.value,
      () => setView("remoteSeen", true),
    ).then((value) => value ?? info.value ?? []),
  )
  const kernels = useKernelList(() => runtime.latest?.kernels)
  const commands = useStableList(() => runtime.latest?.commands)
  const jobs = useStableList(() => remote.latest)

  // An idle active kernel is still valuable state: it retains variables for a
  // follow-up, including when it belongs to another session on this machine.
  const live = createMemo(() =>
    kernels.filter((kernel) => kernel.active || kernel.state === "starting" || kernel.state === "running"),
  )
  const title = (sessionID: string) =>
    sessionID === projectJobs ? "Project jobs" : sync.session.get(sessionID)?.title?.trim() || "Untitled session"
  const grouped = createMemo(() => {
    const groups = new Map<string, Group>()
    const group = (sessionID: string) => groups.get(sessionID) ?? emptyGroup()
    for (const kernel of live()) {
      const value = group(kernel.sessionID)
      groups.set(kernel.sessionID, { ...value, kernels: [...value.kernels, kernel] })
    }
    for (const command of commands) {
      const value = group(command.sessionID)
      groups.set(command.sessionID, { ...value, commands: [...value.commands, command] })
    }
    for (const job of visibleJobs(jobs)) {
      const sessionID = job.session_id ?? projectJobs
      const value = group(sessionID)
      groups.set(sessionID, { ...value, jobs: [...value.jobs, job] })
    }
    return groups
  })
  const groups = createMemo(() =>
    [...grouped().keys()].sort((a, b) => {
      const current = Number(route() === b) - Number(route() === a)
      if (current) return current
      const activity = (sessionID: string) => {
        const group = grouped().get(sessionID) ?? emptyGroup()
        return Math.max(
          0,
          ...group.kernels.map((kernel) => kernel.last_activity_at ?? kernel.started_at ?? 0),
          ...group.commands.map((command) => command.started_at),
          ...group.jobs.map((job) => Date.parse(job.started_at ?? job.created_at) || 0),
        )
      }
      return activity(b) - activity(a)
    }),
  )
  const otherIDs = createMemo(() => groups().filter((sessionID) => sessionID !== route()))
  const firstOther = createMemo(() => groups().findIndex((sessionID) => sessionID !== route()))
  const otherUsage = createMemo(() => {
    const aggregate = otherIDs().reduce<Group>((combined, sessionID) => {
      const group = grouped().get(sessionID) ?? emptyGroup()
      return {
        kernels: [...combined.kernels, ...group.kernels],
        commands: [...combined.commands, ...group.commands],
        jobs: [...combined.jobs, ...group.jobs],
      }
    }, emptyGroup())
    return usage(aggregate)
  })
  const state = createMemo(() => freshness(view))

  const refresh = () => {
    if (document.hidden) return
    if (!runtime.loading) void runtimeApi.refetch()
    if (!remote.loading) void remoteApi.refetch()
  }
  const timer = setInterval(refresh, 2_500)
  document.addEventListener("visibilitychange", refresh)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", refresh)
  })

  return (
    <section aria-label="Project compute" data-testid="kernel-panel" class="kernel-panel activity-panel">
      <div class="atlas-scroll kernel-panel__body">
        <Show when={state().problem && groups().length > 0}>
          <div role="status" class="kernel-panel__message" data-state={state().stale ? "stale" : "unavailable"}>
            {state().stale ? "Showing the last successful compute inventory." : "Some live compute is unavailable."}
          </div>
        </Show>

        <Show
          when={groups().length > 0}
          fallback={
            <div class="kernel-panel__empty" data-state={state().problem ? "unavailable" : "idle"}>
              <strong>{state().empty}</strong>
              <Show when={state().problem}>
                <span>
                  {state().stale ? "Showing the last successful inventory." : "The live inventory could not be read."}
                </span>
              </Show>
            </div>
          }
        >
          <div class="kernel-panel__sessions">
            <For each={groups()}>
              {(sessionID, index) => {
                const group = () => grouped().get(sessionID) ?? emptyGroup()
                const summary = () => usage(group())
                return (
                  <>
                    <Show when={index() === firstOther()}>
                      <div class="kernel-panel__other" aria-label="Other sessions summary">
                        <span>Other sessions</span>
                        <span>
                          {otherUsage().kinds} · {otherUsage().memory} · {otherUsage().cpu}
                        </span>
                      </div>
                    </Show>
                    <section
                      class="kernel-session"
                      aria-label={`${title(sessionID)} compute`}
                      data-current={route() === sessionID ? "true" : undefined}
                    >
                      <header class="kernel-session__header">
                        <div class="kernel-session__identity">
                          <strong>{title(sessionID)}</strong>
                          <Show when={route() === sessionID}>
                            <em>Current</em>
                          </Show>
                        </div>
                        <div class="kernel-session__summary" aria-label={summary().kinds}>
                          <span>{summary().kinds}</span>
                          <span>{summary().memory}</span>
                          <span>{summary().cpu}</span>
                        </div>
                      </header>
                      <div class="kernel-panel__list">
                        <For each={group().kernels}>
                          {(kernel) => <KernelCard kernel={kernel} sample={view.sample} />}
                        </For>
                        <For each={group().commands}>
                          {(command) => <CommandCard command={command} sample={view.sample} />}
                        </For>
                        <For each={group().jobs}>{(job) => <RemoteJobCard job={job} />}</For>
                      </div>
                    </section>
                  </>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}
