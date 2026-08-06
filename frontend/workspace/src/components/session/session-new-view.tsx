import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
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

interface NewSessionCanvasProps {
  children: JSX.Element
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function NewSessionCanvas(props: NewSessionCanvasProps) {
  const [internal, setInternal] = createSignal(false)
  const catalogOpen = () => props.open ?? internal()
  const setCatalogOpen = (open: boolean) => {
    if (props.onOpenChange) return props.onOpenChange(open)
    setInternal(open)
  }

  return (
    <main class="atlas-scroll research-launchpad" data-component="research-launchpad">
      <div class="research-launchpad__inner">
        <header class="research-launchpad__bar" aria-label="Research starters">
          <div>
            <button
              type="button"
              class="research-launchpad__catalog-toggle"
              data-action="browse-research"
              aria-expanded={catalogOpen() ? "true" : "false"}
              onClick={() => setCatalogOpen(!catalogOpen())}
            >
              <span>Starters</span>
              <IconChevronDown
                size={12}
                strokeWidth={1.7}
                style={{ transform: catalogOpen() ? "rotate(180deg)" : "rotate(0deg)" }}
              />
            </button>
          </div>
        </header>

        <Show when={catalogOpen()}>{props.children}</Show>
      </div>
    </main>
  )
}

export function NewSessionView() {
  const sdk = useSDK()
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
  const visibleWorkflows = createMemo(() =>
    workflowGroup() === "all"
      ? researchWorkflows
      : researchWorkflows.filter((workflow) => workflow.group === workflowGroup()),
  )

  const start = (workflow: ResearchWorkflow) => {
    uiStore.setPrefill(workflowPrompt(workflow, artifacts.latest?.length ?? 0))
    setCatalogOpen(false)
  }

  const createStarter = async (starter: ResearchStarter) => {
    setCreating(starter.id)
    const response = await sdk
      .request("/file/starters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: starter.id }),
      })
      .catch((error) => {
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
    setCatalogOpen(false)
    uiStore.openFile(sdk.directory, result.notebook)
  }

  return (
    <NewSessionCanvas open={catalogOpen()} onOpenChange={setCatalogOpen}>
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
              {(starter, index) => (
                <button
                  type="button"
                  class="research-launchpad__starter"
                  data-starter={starter.id}
                  style={{ "--starter-accent": starter.accent }}
                  disabled={Boolean(creating())}
                  onClick={() => void createStarter(starter)}
                >
                  <span class="research-launchpad__starter-visual" aria-hidden="true">
                    <span class="research-launchpad__starter-number">0{index() + 1}</span>
                    <span class="research-launchpad__starter-plot">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span class="research-launchpad__starter-copy">
                    <strong>{starter.title}</strong>
                    <span>{starter.description}</span>
                    <small>{starter.files.join(" · ")}</small>
                  </span>
                  <span class="research-launchpad__starter-action">
                    {creating() === starter.id ? "Creating…" : "Use starter"}
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
                  aria-pressed={workflowGroup() === item[0]}
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
    </NewSessionCanvas>
  )
}
