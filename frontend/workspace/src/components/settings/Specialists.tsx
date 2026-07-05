import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import type { Agent, Config } from "@synsci/sdk/v2/client"
import {
  PanelScroll,
  PanelHeader,
  PanelBody,
  Toolbar,
  SearchInput,
  FilterMenu,
  AddMenu,
  Card,
  Row,
  SectionLabel,
  EmptyState,
  FormField,
  FormButton,
} from "./_shared"

// System agents that are implementation details, not user-facing specialists.
const SYSTEM_AGENTS = new Set(["title", "compaction"])
type Mode = "primary" | "subagent" | "all"

export default function Specialists() {
  const sdk = useGlobalSDK()
  const globalSDK = useGlobalSDK()
  const sync = useGlobalSync()

  const [agents, agentsCtl] = createResource(async () => {
    const res = await sdk.client.app.agents()
    // Show only user-facing specialists: the default harness + domain modes. Internal
    // subagents and hidden model-backends are excluded; custom agents are always shown so
    // they remain manageable here.
    return ((res.data ?? []) as Agent[]).filter(
      (a) => !SYSTEM_AGENTS.has(a.name) && (!a.native || (a.mode !== "subagent" && !a.hidden)),
    )
  })

  const [search, setSearch] = createSignal("")
  const [modeFilter, setModeFilter] = createSignal("all")
  const [creating, setCreating] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const visible = createMemo(() => {
    const q = search().trim().toLowerCase()
    const m = modeFilter()
    return (agents() ?? [])
      .filter((a) => m === "all" || a.mode === m || (m === "primary" && a.mode === "all"))
      .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q))
  })
  const builtIn = createMemo(() =>
    visible()
      .filter((a) => a.native)
      .sort(byName),
  )
  const custom = createMemo(() =>
    visible()
      .filter((a) => !a.native)
      .sort(byName),
  )

  const modeOptions = createMemo(() => [
    { id: "all", label: "All", count: (agents() ?? []).length },
    {
      id: "primary",
      label: "Primary",
      count: (agents() ?? []).filter((a) => a.mode === "primary" || a.mode === "all").length,
    },
    { id: "subagent", label: "Subagents", count: (agents() ?? []).filter((a) => a.mode === "subagent").length },
  ])

  async function createAgent(name: string, description: string, prompt: string, mode: Mode) {
    setBusy(true)
    try {
      const agent: Config["agent"] = { [name]: { description, prompt: prompt || undefined, mode } }
      await sync.updateConfig({ agent } as Config)
      await agentsCtl.refetch()
      showToast({ variant: "success", title: `Specialist "${name}" created` })
      setCreating(false)
    } catch (err) {
      showToast({ variant: "error", title: "Could not create specialist", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteAgent(name: string) {
    if (!window.confirm(`Delete custom specialist "${name}"? This removes it from your config.`)) return
    setBusy(true)
    try {
      await globalSDK.client.global.configUnset({ path: ["agent", name] })
      await agentsCtl.refetch()
      showToast({ variant: "success", title: `Deleted "${name}"` })
    } catch (err) {
      showToast({ variant: "error", title: "Delete failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelScroll>
      <PanelHeader
        title="Specialists"
        description="The specialist modes you can switch between while you work. Built-in specialists ship with OpenScience; custom ones are defined in your config."
        toolbar={
          <Show when={!creating()}>
            <Toolbar>
              <FilterMenu options={modeOptions()} value={modeFilter()} onSelect={setModeFilter} />
              <SearchInput value={search()} onInput={setSearch} placeholder="Search specialists" />
              <AddMenu
                label="add specialist"
                items={[
                  {
                    icon: "pencil-line",
                    label: "write from scratch",
                    description: "Define a custom agent persisted to config",
                    onSelect: () => setCreating(true),
                  },
                ]}
              />
            </Toolbar>
          </Show>
        }
      />

      <PanelBody>
        <Show when={creating()}>
          <CreateForm busy={busy()} onCancel={() => setCreating(false)} onCreate={createAgent} />
        </Show>

        <Show when={!creating()}>
          <Show
            when={!agents.loading}
            fallback={<div class="py-12 text-center text-13-regular text-text-weak">Loading specialists…</div>}
          >
            <Show
              when={visible().length > 0}
              fallback={
                <EmptyState
                  icon="models"
                  title={search() ? "No matching specialists" : "No specialists"}
                  hint="Create a custom specialist to tailor an agent to your workflow."
                />
              }
            >
              <Show when={custom().length > 0}>
                <div class="flex flex-col gap-2">
                  <SectionLabel label="Custom" count={custom().length} />
                  <Card>
                    <For each={custom()}>
                      {(agent) => (
                        <AgentRow agent={agent} onDelete={() => void deleteAgent(agent.name)} busy={busy()} />
                      )}
                    </For>
                  </Card>
                </div>
              </Show>

              <Show when={builtIn().length > 0}>
                <div class="flex flex-col gap-2">
                  <SectionLabel label="Built-in" count={builtIn().length} />
                  <Card>
                    <For each={builtIn()}>{(agent) => <AgentRow agent={agent} busy={busy()} />}</For>
                  </Card>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </PanelBody>
    </PanelScroll>
  )
}

function AgentRow(props: { agent: Agent; onDelete?: () => void; busy: boolean }) {
  const modeLabel = () =>
    props.agent.mode === "subagent" ? "subagent" : props.agent.mode === "all" ? "primary · subagent" : "primary"
  return (
    <Row>
      <div
        class="flex items-center justify-center size-8 rounded-xs flex-shrink-0 text-icon-strong-base"
        style={{ background: props.agent.color ? `${props.agent.color}22` : "var(--color-surface-raised-base)" }}
      >
        <Icon name="models" size="small" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-14-medium text-text-strong truncate">{props.agent.name}</span>
          <span class="text-11-medium text-text-weak/70 px-1.5 py-0.5 rounded-md bg-surface-raised-base/60">
            {modeLabel()}
          </span>
        </div>
        <Show when={props.agent.description}>
          <p class="text-12-regular text-text-weak truncate mt-0.5">{props.agent.description}</p>
        </Show>
      </div>
      <Show when={props.onDelete}>
        <IconButton icon="trash" variant="ghost" disabled={props.busy} aria-label="Delete" onClick={props.onDelete} />
      </Show>
    </Row>
  )
}

function CreateForm(props: {
  busy: boolean
  onCancel: () => void
  onCreate: (name: string, description: string, prompt: string, mode: Mode) => void
}) {
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [mode, setMode] = createSignal<Mode>("subagent")
  const valid = () => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name().trim()) && description().trim().length > 0
  return (
    <div class="flex flex-col gap-4">
      <SectionLabel label="Create a custom specialist" />
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[4px] bg-surface-base/40">
        <FormField
          label="Name"
          value={name()}
          onInput={setName}
          placeholder="my-specialist (letters, digits, - and _)"
        />
        <FormField
          label="Description"
          value={description()}
          onInput={setDescription}
          placeholder="When should this specialist be used?"
        />
        <label class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-strong">Mode</span>
          <select
            value={mode()}
            class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong outline-none focus:border-border-strong-base"
            onInput={(e) => setMode(e.currentTarget.value as Mode)}
          >
            <option value="subagent">Subagent (invoked by other agents)</option>
            <option value="primary">Primary (user-selectable)</option>
            <option value="all">Both</option>
          </select>
        </label>
        <FormField
          label="System prompt"
          value={prompt()}
          onInput={setPrompt}
          multiline
          placeholder="Instructions that define this specialist's behavior…"
        />
        <div class="flex items-center gap-2">
          <FormButton
            label={props.busy ? "creating…" : "create specialist"}
            disabled={props.busy || !valid()}
            onClick={() => props.onCreate(name().trim(), description().trim(), prompt(), mode())}
          />
          <FormButton label="cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </div>
  )
}

function byName(a: Agent, b: Agent) {
  return a.name.localeCompare(b.name)
}
function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
