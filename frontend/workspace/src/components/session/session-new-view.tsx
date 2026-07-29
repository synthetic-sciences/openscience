import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useModels } from "@/context/models"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@synsci/ui/context/dialog"
import { getFilename } from "@synsci/util/path"
import { DialogSettings } from "@/components/dialog-settings"
import { centerTabs } from "@/atlas/store/centerTabs"
import { uiStore } from "@/atlas/store/ui"
import { toast } from "@/atlas/Toast"
import {
  IconActivity,
  IconArrowRight,
  IconAtom,
  IconBraces,
  IconChevronDown,
  IconFile,
  IconLayoutGrid,
  IconNetwork,
  IconRefresh,
  IconSearch,
} from "@/atlas/shared/Icon"
import {
  researchStarters,
  researchWorkflows,
  workflowPrompt,
  type ResearchStarter,
  type ResearchWorkflow,
} from "@/components/session/research-launchpad"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
const FEATURED_WORKFLOWS = [
  "analyze-data",
  "run-notebook",
  "survey-literature",
  "inspect-structure",
  "reproduce-result",
  "write-report",
] as const

interface NewSessionViewProps {
  worktree: string
  onWorktreeChange: (value: string) => void
}

const icons: Record<ResearchWorkflow["icon"], (props: { size?: number; strokeWidth?: number }) => JSX.Element> = {
  table: IconLayoutGrid,
  notebook: IconBraces,
  atom: IconAtom,
  sequence: IconActivity,
  search: IconSearch,
  reproduce: IconRefresh,
  compare: IconNetwork,
  report: IconFile,
  activity: IconActivity,
  network: IconNetwork,
}

export function NewSessionView(props: NewSessionViewProps) {
  const sync = useSync()
  const models = useModels()
  const sdk = useSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const noModel = createMemo(() => models.list().length === 0)
  const sandboxes = createMemo(() => sync.project?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => (options().includes(props.worktree) ? props.worktree : MAIN_WORKTREE))
  const branch = createMemo(() => sync.data.vcs?.branch || "working tree")
  const [artifacts] = createResource(
    () => sdk.directory,
    () =>
      sdk.client.file
        .artifacts()
        .then((response) => response.data ?? [])
        .catch(() => []),
  )
  const [workflowGroup, setWorkflowGroup] = createSignal<ResearchWorkflow["group"] | "all">("all")
  const [creating, setCreating] = createSignal<ResearchStarter["id"]>()
  const [catalogOpen, setCatalogOpen] = createSignal(false)
  const featuredWorkflows = createMemo(() =>
    FEATURED_WORKFLOWS.map((id) => researchWorkflows.find((workflow) => workflow.id === id)).filter(
      (workflow): workflow is ResearchWorkflow => Boolean(workflow),
    ),
  )
  const visibleWorkflows = createMemo(() =>
    workflowGroup() === "all"
      ? researchWorkflows
      : researchWorkflows.filter((workflow) => workflow.group === workflowGroup()),
  )
  const local = createMemo(() => {
    try {
      const host = new URL(sdk.url).hostname
      return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
    } catch {
      return false
    }
  })

  const worktreeLabel = (value: string) => {
    if (value === MAIN_WORKTREE) return branch()
    if (value === CREATE_WORKTREE) return "new isolated worktree"
    return getFilename(value)
  }

  const start = (workflow: ResearchWorkflow) => {
    uiStore.setPrefill(workflowPrompt(workflow, artifacts.latest?.length ?? 0))
    centerTabs.showChat()
  }

  const createStarter = async (starter: ResearchStarter) => {
    setCreating(starter.id)
    const request = platform.fetch ?? fetch
    const endpoint = new URL(`${sdk.url.replace(/\/+$/, "")}/file/starters`)
    endpoint.searchParams.set("directory", sdk.directory)
    const response = await request(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: starter.id }),
    }).catch((error) => {
      toast.error("starter could not be created", error instanceof Error ? error.message : String(error))
      return undefined
    })
    setCreating(undefined)
    if (!response) return
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      toast.error("starter could not be created", detail || `${response.status}`)
      return
    }
    const result = (await response.json()) as { notebook: string; files: string[] }
    toast.success("starter project ready", `${result.files.length} local files created`)
    centerTabs.openFile(sdk.directory, result.notebook)
  }

  return (
    <main class="atlas-scroll research-launchpad" data-component="research-launchpad">
      <div class="research-launchpad__inner">
        <section class="research-launchpad__intro" aria-labelledby="research-launchpad-title">
          <div class="research-launchpad__eyebrow">New research</div>
          <h1 id="research-launchpad-title">What are we trying to find out?</h1>
          <p>
            Ask a question below or choose a starting point. OpenScience can inspect the project, run code and
            notebooks, and keep the evidence beside the result.
          </p>
        </section>

        <Show when={noModel()}>
          <button type="button" class="research-launchpad__setup" onClick={() => dialog.show(() => <DialogSettings />)}>
            <span>
              <strong>Connect a model</strong>
              <small>Required before the first run</small>
            </span>
            <IconArrowRight size={13} strokeWidth={1.7} />
          </button>
        </Show>

        <section class="research-launchpad__quick" aria-labelledby="research-quick-title">
          <div class="research-launchpad__section-heading">
            <div>
              <h2 id="research-quick-title">Start here</h2>
              <p>These open as editable prompts in the composer.</p>
            </div>
            <button type="button" class="research-launchpad__artifacts" onClick={() => centerTabs.setActive("files")}>
              <Show when={!artifacts.loading} fallback="Scanning research files">
                {(artifacts.latest?.length ?? 0).toLocaleString()} research files
              </Show>
            </button>
          </div>
          <div class="research-launchpad__quick-list">
            <For each={featuredWorkflows()}>
              {(workflow) => {
                const Icon = icons[workflow.icon]
                return (
                  <button type="button" class="research-launchpad__quick-action" onClick={() => start(workflow)}>
                    <span class="research-launchpad__quick-icon">
                      <Icon size={15} strokeWidth={1.45} />
                    </span>
                    <span>
                      <strong>{workflow.title}</strong>
                      <small>{workflow.description}</small>
                    </span>
                    <IconArrowRight size={13} strokeWidth={1.7} />
                  </button>
                )
              }}
            </For>
          </div>
        </section>

        <div class="research-launchpad__controls">
          <button
            type="button"
            class="research-launchpad__catalog-toggle"
            aria-expanded={catalogOpen() ? "true" : "false"}
            onClick={() => setCatalogOpen((open) => !open)}
          >
            <span>Browse all workflows</span>
            <small>{researchWorkflows.length + researchStarters.length}</small>
            <IconChevronDown
              size={13}
              strokeWidth={1.7}
              style={{ transform: catalogOpen() ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
          <label class="research-launchpad__worktree">
            <span>Run on</span>
            <select value={current()} onChange={(event) => props.onWorktreeChange(event.currentTarget.value)}>
              <For each={options()}>{(option) => <option value={option}>{worktreeLabel(option)}</option>}</For>
            </select>
          </label>
        </div>

        <Show when={catalogOpen()}>
          <div class="research-launchpad__catalog">
            <section class="research-launchpad__starters" aria-labelledby="research-starters-title">
              <div class="research-launchpad__section-heading">
                <div>
                  <h2 id="research-starters-title">Starter projects</h2>
                  <p>Create a valid local notebook and sample data.</p>
                </div>
              </div>
              <div class="research-launchpad__starter-list">
                <For each={researchStarters}>
                  {(starter) => (
                    <button
                      type="button"
                      class="research-launchpad__starter"
                      data-starter={starter.id}
                      disabled={Boolean(creating())}
                      onClick={() => void createStarter(starter)}
                    >
                      <span class="research-launchpad__starter-copy">
                        <strong>{starter.title}</strong>
                        <span>{starter.description}</span>
                        <small>{starter.files.join(" · ")}</small>
                      </span>
                      <span class="research-launchpad__starter-action">
                        {creating() === starter.id ? "Creating…" : "Create"}
                        <IconArrowRight size={12} strokeWidth={1.7} />
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section class="research-launchpad__workflows" aria-labelledby="research-workflows-title">
              <div class="research-launchpad__section-heading">
                <div>
                  <h2 id="research-workflows-title">All workflows</h2>
                  <p>Choose a detailed brief, then edit it before sending.</p>
                </div>
              </div>

              <nav class="research-launchpad__workflow-filters" aria-label="Workflow categories">
                <For
                  each={
                    [
                      ["all", "All"],
                      ["analyze", "Analyze"],
                      ["compute", "Compute"],
                      ["discover", "Discover"],
                      ["communicate", "Communicate"],
                    ] as const
                  }
                >
                  {(item) => (
                    <button
                      type="button"
                      data-active={workflowGroup() === item[0] ? "true" : "false"}
                      onClick={() => setWorkflowGroup(item[0])}
                    >
                      {item[1]}
                      <span>
                        {item[0] === "all"
                          ? researchWorkflows.length
                          : researchWorkflows.filter((workflow) => workflow.group === item[0]).length}
                      </span>
                    </button>
                  )}
                </For>
              </nav>

              <div class="research-launchpad__grid">
                <For each={visibleWorkflows()}>
                  {(workflow) => {
                    const Icon = icons[workflow.icon]
                    return (
                      <button
                        type="button"
                        class="research-launchpad__workflow"
                        data-workflow={workflow.id}
                        onClick={() => start(workflow)}
                      >
                        <span class="research-launchpad__workflow-icon">
                          <Icon size={15} strokeWidth={1.45} />
                        </span>
                        <span class="research-launchpad__workflow-copy">
                          <strong>{workflow.title}</strong>
                          <span>{workflow.description}</span>
                          <small>{workflow.shortcut}</small>
                        </span>
                        <IconArrowRight class="research-launchpad__workflow-arrow" size={13} strokeWidth={1.7} />
                      </button>
                    )
                  }}
                </For>
              </div>
            </section>
          </div>
        </Show>

        <footer class="research-launchpad__footer">
          <span>{branch()}</span>
          <span>{local() ? "Local compute" : "Remote compute"}</span>
          <span>{models.list().length.toLocaleString()} models</span>
          <Show when={sync.project}>
            {(project) => (
              <span>
                Updated{" "}
                {DateTime.fromMillis(project().time.updated ?? project().time.created)
                  .setLocale("en")
                  .toRelative()}
              </span>
            )}
          </Show>
        </footer>
      </div>
    </main>
  )
}
