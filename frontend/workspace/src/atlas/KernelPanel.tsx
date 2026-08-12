import { For, Show, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { identify } from "@/atlas/poll-identity"
import { KernelCard, type KernelAction } from "@/atlas/KernelCard"
import { CommandCard } from "@/atlas/CommandCard"
import type { Job } from "@/atlas/ComputeJobsAPI"
import { RemoteJobCard, visibleJobs } from "@/atlas/RemoteJobCard"
import { useKernelList } from "@/atlas/use-kernel-list"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { kernelMemoryLabel, type CommandStatus, type KernelStatus } from "@/notebook/runtime"

type KernelsPayload = { kernels: KernelStatus[] }
type CommandsPayload = { commands: CommandStatus[] }
type Group = { kernels: KernelStatus[]; commands: CommandStatus[]; jobs: Job[] }
const projectJobs = "__project_jobs__"

type KernelPanelProps = {
  request?: (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>
}

export function inventory<T>(request: Promise<T>, settled: (error: string) => void) {
  return request.then(
    (value) => {
      settled("")
      return value
    },
    (error) => {
      settled(error instanceof Error ? error.message : String(error))
      return undefined
    },
  )
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
  const ram = entries.some((entry) => entry.resources?.memory_bytes !== undefined)
    ? kernelMemoryLabel(memory)
    : "Memory —"
  const cores = entries.some((entry) => entry.resources?.cpu_percent !== undefined)
    ? `${cpu.toFixed(1)} cores`
    : "CPU —"
  return { kinds, memory: ram, cpu: cores }
}

export function KernelPanel(props: KernelPanelProps = {}): JSX.Element {
  const transport = props.request ?? useSDK().request
  const sync = useSync()
  const params = useParams()
  const client = identify()
  const [view, setView] = createStore({ error: "", remote: "", problem: "", notice: "", action: "" })
  const request = async <T,>(path: string, init?: RequestInit, query?: Record<string, string>) => {
    const response = await transport(path, init, query)
    if (response.ok) {
      const body = await response.text()
      if (!body) return undefined as T
      return JSON.parse(body) as T
    }
    const detail = await response.text().catch(() => "")
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  const jobApi = {
    list: () => request<Job[]>("/settings/compute/jobs", { cache: "no-store" }),
    log: (id: string) =>
      request<{ log: string }>(`/settings/compute/jobs/${encodeURIComponent(id)}/log`, { cache: "no-store" }),
    cancel: (id: string) => request<Job>(`/settings/compute/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  }
  const load = () =>
    inventory(
      Promise.all([
        request<KernelsPayload>("/notebook/kernels", undefined, { client }),
        request<CommandsPayload>("/notebook/commands", undefined, { client }),
        jobApi.list().then(
          (jobs) => {
            setView("remote", "")
            return jobs
          },
          (error) => {
            setView("remote", error instanceof Error ? error.message : String(error))
            return []
          },
        ),
      ]).then(([kernels, commands, jobs]) => ({ kernels: kernels.kernels, commands: commands.commands, jobs })),
      (error) => setView("error", error),
    )
  const [data, api] = createResource(load)
  const kernels = useKernelList(() => data.latest?.kernels)
  const commands = () => data.latest?.commands ?? []
  const jobs = () => data.latest?.jobs ?? []
  const route = () => (params.id && params.id !== "new" ? params.id : undefined)
  const live = createMemo(() => kernels.filter((kernel) => kernel.active || kernel.state === "starting"))
  const title = (sessionID: string) =>
    sessionID === projectJobs ? "Project jobs" : sync.session.get(sessionID)?.title?.trim() || "Untitled session"
  const grouped = createMemo(() => {
    const groups = new Map<string, Group>()
    const group = (sessionID: string) => groups.get(sessionID) ?? { kernels: [], commands: [], jobs: [] }
    for (const kernel of live()) {
      const value = group(kernel.sessionID)
      groups.set(kernel.sessionID, { ...value, kernels: [...value.kernels, kernel] })
    }
    for (const command of commands()) {
      const value = group(command.sessionID)
      groups.set(command.sessionID, { ...value, commands: [...value.commands, command] })
    }
    for (const job of visibleJobs(jobs())) {
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
      const activity = (sessionID: string) =>
        Math.max(
          ...(grouped()
            .get(sessionID)
            ?.kernels.map((kernel) => kernel.last_activity_at ?? kernel.started_at ?? 0) ?? []),
          ...(grouped()
            .get(sessionID)
            ?.commands.map((command) => command.started_at) ?? []),
          ...(grouped()
            .get(sessionID)
            ?.jobs.map((job) => Date.parse(job.started_at ?? job.created_at)) ?? []),
        )
      return activity(b) - activity(a)
    }),
  )

  const control = (kernel: KernelStatus, action: KernelAction) => {
    const key = `${kernel.id}:${action}`
    setView({ action: key, problem: "", notice: "" })
    return request<KernelStatus>(`/notebook/kernels/${encodeURIComponent(kernel.id)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: kernel.sessionID }),
    })
      .then(() => {
        setView("notice", "Kernel stopped. In-memory state was cleared; the next agent run will start fresh.")
        return api.refetch()
      })
      .catch((error) => setView("problem", error instanceof Error ? error.message : String(error)))
      .finally(() => setView("action", ""))
  }

  const stop = (command: CommandStatus) => {
    const key = `${command.id}:stop`
    setView({ action: key, problem: "", notice: "" })
    return request<{ stopped: boolean }>(`/notebook/commands/${encodeURIComponent(command.id)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: command.sessionID }),
    })
      .then(() => {
        setView("notice", "Command stopped. Its child processes were terminated.")
        return api.refetch()
      })
      .catch((error) => setView("problem", error instanceof Error ? error.message : String(error)))
      .finally(() => setView("action", ""))
  }

  const cancel = (job: Job) => {
    const key = `${job.id}:cancel`
    setView({ action: key, problem: "", notice: "" })
    return jobApi
      .cancel(job.id)
      .then(() => {
        setView("notice", "Remote job cancelled. OpenScience requested provider cleanup and will surface any warning.")
        return api.refetch()
      })
      .catch((error) => setView("problem", error instanceof Error ? error.message : String(error)))
      .finally(() => setView("action", ""))
  }

  const refresh = () => {
    if (document.hidden) return
    void api.refetch()
  }
  const timer = setInterval(refresh, 2_500)
  document.addEventListener("visibilitychange", refresh)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", refresh)
  })

  return (
    <section aria-label="Project compute" data-testid="kernel-panel" class="kernel-panel">
      <div class="atlas-scroll kernel-panel__body">
        <Show when={view.error || view.remote || view.problem}>
          <div role="alert" class="kernel-panel__message kernel-panel__message--error">
            {view.problem
              ? `Compute control failed. ${view.problem}`
              : view.error
                ? `Compute inventory unavailable. ${view.error}`
                : `Remote jobs unavailable. ${view.remote}`}
          </div>
        </Show>
        <Show when={view.notice}>
          <div role="status" class="kernel-panel__message">
            {view.notice}
          </div>
        </Show>

        <Show
          when={groups().length > 0}
          fallback={
            <div class="kernel-panel__empty">
              <strong>{view.error ? "Compute inventory unavailable" : "Runtimes start with your work"}</strong>
              <p>
                {view.error
                  ? "The last poll could not read this project's kernels, commands, and remote jobs, so this is not a count of what is running."
                  : "Python and R kernels preserve session state automatically. Live commands and remote jobs appear here too."}
              </p>
            </div>
          }
        >
          <div class="kernel-panel__sessions">
            <For each={groups()}>
              {(sessionID) => {
                const summary = () => usage(grouped().get(sessionID) ?? { kernels: [], commands: [], jobs: [] })
                return (
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
                      <div
                        class="kernel-session__summary"
                        aria-label={`${summary().kinds}, ${summary().memory}, ${summary().cpu}`}
                      >
                        <span>{summary().kinds}</span>
                        <span>{summary().memory}</span>
                        <span>{summary().cpu}</span>
                      </div>
                    </header>
                    <div class="kernel-panel__list">
                      <For each={grouped().get(sessionID)?.kernels ?? []}>
                        {(kernel) => (
                          <KernelCard
                            kernel={kernel}
                            action={view.action}
                            onControl={(action) => void control(kernel, action)}
                          />
                        )}
                      </For>
                      <For each={grouped().get(sessionID)?.commands ?? []}>
                        {(command) => (
                          <CommandCard
                            command={command}
                            stopping={view.action === `${command.id}:stop`}
                            onStop={() => void stop(command)}
                          />
                        )}
                      </For>
                      <For each={grouped().get(sessionID)?.jobs ?? []}>
                        {(job) => (
                          <RemoteJobCard
                            job={job}
                            cancelling={view.action === `${job.id}:cancel`}
                            onCancel={() => cancel(job).then(() => undefined)}
                            onOutput={() => jobApi.log(job.id).then((value) => value.log)}
                          />
                        )}
                      </For>
                    </div>
                  </section>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}
