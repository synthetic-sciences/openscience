import { For, Show, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { identify } from "@/atlas/poll-identity"
import { KernelCard, type KernelAction } from "@/atlas/KernelCard"
import { CommandCard } from "@/atlas/CommandCard"
import type { Job } from "@/atlas/ComputeJobsAPI"
import { RemoteJobCard, visibleJobs } from "@/atlas/RemoteJobCard"
import { ExecutionCard } from "@/atlas/ExecutionCard"
import { ResearchActivityCard } from "@/atlas/ResearchActivityCard"
import {
  createExecutionHistoryAPI,
  executionTime,
  recentExecutions,
  type ExecutionRecord,
} from "@/atlas/ExecutionHistoryAPI"
import { recentObservableResearch, type ObservableResearchActivity } from "@/atlas/session-trace-model"
import { useKernelList } from "@/atlas/use-kernel-list"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { kernelMemoryLabel, type CommandStatus, type KernelStatus } from "@/atlas/kernel-runtime"
import type { SessionTraceResponse } from "@synsci/sdk/v2/client"

type KernelsPayload = { kernels: KernelStatus[] }
type CommandsPayload = { commands: CommandStatus[] }
type Group = {
  kernels: KernelStatus[]
  commands: CommandStatus[]
  executions: ExecutionRecord[]
  jobs: Job[]
  research: ObservableResearchActivity[]
}
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
    group.executions.length
      ? `${group.executions.length} ${group.executions.length === 1 ? "run" : "runs"}`
      : undefined,
    group.research.length
      ? `${group.research.length} research ${group.research.length === 1 ? "action" : "actions"}`
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
  const [view, setView] = createStore({
    error: "",
    history: "",
    research: "",
    remote: "",
    problem: "",
    notice: "",
    action: "",
  })
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
    retry: (id: string) => request<Job>(`/settings/compute/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
    release: (id: string) =>
      request<Job>(`/settings/compute/jobs/${encodeURIComponent(id)}/release`, { method: "POST" }),
  }
  const historyApi = createExecutionHistoryAPI(transport)
  const route = () => (params.id && params.id !== "new" ? params.id : undefined)
  const history = () => {
    const sessionID = route()
    if (!sessionID) {
      setView("history", "")
      return Promise.resolve<ExecutionRecord[]>([])
    }
    return historyApi.list(sessionID).then(
      (executions) => {
        setView("history", "")
        return executions
      },
      (error) => {
        setView("history", error instanceof Error ? error.message : String(error))
        return []
      },
    )
  }
  const research = () => {
    const sessionID = route()
    if (!sessionID) {
      setView("research", "")
      return Promise.resolve<ObservableResearchActivity[]>([])
    }
    return request<SessionTraceResponse>(`/session/${encodeURIComponent(sessionID)}/trace`, {
      cache: "no-store",
    }).then(
      (trace) => {
        setView("research", "")
        return recentObservableResearch(trace)
      },
      (error) => {
        setView("research", error instanceof Error ? error.message : String(error))
        return []
      },
    )
  }
  const load = () =>
    inventory(
      Promise.all([
        request<KernelsPayload>("/kernels", undefined, { client }),
        request<CommandsPayload>("/kernels/commands", undefined, { client }),
        history(),
        research(),
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
      ]).then(([kernels, commands, executions, research, jobs]) => ({
        kernels: kernels.kernels,
        commands: commands.commands,
        executions,
        research,
        jobs,
      })),
      (error) => setView("error", error),
    )
  // Re-read the selected conversation immediately; the interval is only for
  // background freshness, never navigation latency.
  const [data, api] = createResource(() => route() ?? projectJobs, load)
  const kernels = useKernelList(() => data.latest?.kernels)
  const commands = () => data.latest?.commands ?? []
  const executions = () => data.latest?.executions ?? []
  const researchActivity = () => data.latest?.research ?? []
  const jobs = () => data.latest?.jobs ?? []
  const live = createMemo(() => kernels.filter((kernel) => kernel.active || kernel.state === "starting"))
  const title = (sessionID: string) =>
    sessionID === projectJobs ? "Project jobs" : sync.session.get(sessionID)?.title?.trim() || "Untitled session"
  const grouped = createMemo(() => {
    const groups = new Map<string, Group>()
    const group = (sessionID: string) =>
      groups.get(sessionID) ?? { kernels: [], commands: [], executions: [], jobs: [], research: [] }
    for (const kernel of live()) {
      const value = group(kernel.sessionID)
      groups.set(kernel.sessionID, { ...value, kernels: [...value.kernels, kernel] })
    }
    for (const command of commands()) {
      const value = group(command.sessionID)
      groups.set(command.sessionID, { ...value, commands: [...value.commands, command] })
    }
    for (const execution of executions()) {
      const value = group(execution.session_id)
      groups.set(execution.session_id, { ...value, executions: [...value.executions, execution] })
    }
    const current = route()
    if (current && researchActivity().length > 0) {
      const value = group(current)
      groups.set(current, { ...value, research: researchActivity() })
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
          ...(grouped().get(sessionID)?.executions.map(executionTime) ?? []),
          ...(grouped()
            .get(sessionID)
            ?.research.map((item) => item.at) ?? []),
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
    return request<KernelStatus>(`/kernels/${encodeURIComponent(kernel.id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: kernel.sessionID }),
    })
      .then(() => {
        setView(
          "notice",
          action === "restart"
            ? "Runtime restarted. In-memory state and queued work were cleared."
            : "Runtime stopped. In-memory state was cleared; the next agent run will start fresh.",
        )
        return api.refetch()
      })
      .catch((error) => setView("problem", error instanceof Error ? error.message : String(error)))
      .finally(() => setView("action", ""))
  }

  const stop = (command: CommandStatus) => {
    const key = `${command.id}:stop`
    setView({ action: key, problem: "", notice: "" })
    return request<{ stopped: boolean }>(`/kernels/commands/${encodeURIComponent(command.id)}/stop`, {
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

  const recover = (job: Job, action: "retry" | "release") => {
    const key = `${job.id}:${action}`
    setView({ action: key, problem: "", notice: "" })
    return jobApi[action](job.id)
      .then(() => {
        setView(
          "notice",
          action === "retry"
            ? "Output recovery restarted. New delivery status will appear here."
            : "Remote cleanup retried. Resource status will update here.",
        )
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
    <section aria-label="Project compute" data-testid="kernel-panel" class="kernel-panel activity-panel">
      <div class="atlas-scroll kernel-panel__body">
        <Show when={view.error || view.history || view.research || view.remote || view.problem}>
          <div role="alert" class="kernel-panel__message kernel-panel__message--error">
            {view.problem
              ? `Compute control failed. ${view.problem}`
              : view.error
                ? `Live activity unavailable. ${view.error}`
                : view.history
                  ? `Execution history unavailable. ${view.history}`
                  : view.research
                    ? `Research activity unavailable. ${view.research}`
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
              <strong>{view.error ? "Compute unavailable" : "Work appears here automatically"}</strong>
              <p>
                {view.error
                  ? "The last poll could not read this project's live runtimes and jobs, so this is not a count of what is running."
                  : "Delegated research, source activity, Python and R results, live local work, and governed remote jobs appear here automatically."}
              </p>
            </div>
          }
        >
          <div class="kernel-panel__sessions">
            <For each={groups()}>
              {(sessionID) => {
                const group = () =>
                  grouped().get(sessionID) ?? { kernels: [], commands: [], executions: [], jobs: [], research: [] }
                const summary = () => usage(group())
                const localCount = () => group().kernels.length + group().commands.length + group().executions.length
                return (
                  <section
                    class="kernel-session"
                    aria-label={`${title(sessionID)} activity`}
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
                      </div>
                    </header>
                    <Show when={group().research.length > 0}>
                      <section class="activity-boundary" data-location="research" aria-label="Research activity">
                        <header class="activity-boundary__header">
                          <strong>Research</strong>
                          <span>Delegated tasks and external sources</span>
                        </header>
                        <div class="kernel-panel__list">
                          <For each={group().research}>
                            {(activity) => <ResearchActivityCard activity={activity} />}
                          </For>
                        </div>
                      </section>
                    </Show>
                    <Show when={localCount() > 0}>
                      <section class="activity-boundary" data-location="local" aria-label="Local activity">
                        <header class="activity-boundary__header">
                          <strong>Local</strong>
                          <span>This computer</span>
                        </header>
                        <div class="kernel-panel__list">
                          <For each={group().kernels}>
                            {(kernel) => (
                              <KernelCard
                                kernel={kernel}
                                action={view.action}
                                onControl={(action) => void control(kernel, action)}
                              />
                            )}
                          </For>
                          <For each={group().commands}>
                            {(command) => (
                              <CommandCard
                                command={command}
                                stopping={view.action === `${command.id}:stop`}
                                onStop={() => void stop(command)}
                              />
                            )}
                          </For>
                          <For each={recentExecutions(group().executions)}>
                            {(execution) => <ExecutionCard run={execution} />}
                          </For>
                        </div>
                      </section>
                    </Show>
                    <Show when={group().jobs.length > 0}>
                      <section class="activity-boundary" data-location="remote" aria-label="Remote activity">
                        <header class="activity-boundary__header">
                          <strong>Remote</strong>
                          <span>SSH, schedulers, and managed compute</span>
                        </header>
                        <div class="kernel-panel__list">
                          <For each={group().jobs}>
                            {(job) => (
                              <RemoteJobCard
                                job={job}
                                action={view.action}
                                onCancel={() => cancel(job).then(() => undefined)}
                                onRetry={() => recover(job, "retry").then(() => undefined)}
                                onRelease={() => recover(job, "release").then(() => undefined)}
                                onOutput={() => jobApi.log(job.id).then((value) => value.log)}
                              />
                            )}
                          </For>
                        </div>
                      </section>
                    </Show>
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
