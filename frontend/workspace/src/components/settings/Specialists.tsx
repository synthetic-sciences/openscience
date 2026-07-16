import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { IconButton } from "@synsci/ui/icon-button"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
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
  Avatar,
  Chip,
} from "./_shared"

// System agents that are implementation details, not user-facing specialists.
const SYSTEM_AGENTS = new Set(["title", "compaction"])
type Mode = "primary" | "subagent" | "all"

export default function Specialists() {
  const lang = useLanguage()
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
    { id: "all", label: lang.t("settings.specialists.filter.all"), count: (agents() ?? []).length },
    {
      id: "primary",
      label: lang.t("settings.specialists.filter.primary"),
      count: (agents() ?? []).filter((a) => a.mode === "primary" || a.mode === "all").length,
    },
    { id: "subagent", label: lang.t("settings.specialists.filter.subagents"), count: (agents() ?? []).filter((a) => a.mode === "subagent").length },
  ])

  async function createAgent(name: string, description: string, prompt: string, mode: Mode) {
    setBusy(true)
    try {
      const agent: Config["agent"] = { [name]: { description, prompt: prompt || undefined, mode } }
      await sync.updateConfig({ agent } as Config)
      await agentsCtl.refetch()
      showToast({ variant: "success", title: lang.t("settings.specialists.toast.created", { name }) })
      setCreating(false)
    } catch (err) {
      showToast({ variant: "error", title: lang.t("settings.specialists.toast.createFailed"), description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteAgent(name: string) {
    if (!window.confirm(lang.t("settings.specialists.confirm.delete", { name }))) return
    setBusy(true)
    try {
      await globalSDK.client.global.configUnset({ path: ["agent", name] })
      await agentsCtl.refetch()
      showToast({ variant: "success", title: lang.t("settings.specialists.toast.deleted", { name }) })
    } catch (err) {
      showToast({ variant: "error", title: "Delete failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelScroll>
      <PanelHeader
        title={lang.t("settings.specialists.heading")}
        description={lang.t("settings.specialists.description")}
        toolbar={
          <Show when={!creating()}>
            <Toolbar>
              <FilterMenu options={modeOptions()} value={modeFilter()} onSelect={setModeFilter} />
              <SearchInput value={search()} onInput={setSearch} placeholder={lang.t("settings.specialists.placeholder.search")} />
              <AddMenu
                label={lang.t("settings.specialists.action.addSpecialist")}
                items={[
                  {
                    icon: "pencil-line",
                    label: lang.t("settings.specialists.action.writeFromScratch"),
                    description: lang.t("settings.specialists.action.writeFromScratch.description"),
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
            fallback={<div class="py-12 text-center text-13-regular text-text-weak">{lang.t("settings.specialists.status.loading")}</div>}
          >
            <Show
              when={visible().length > 0}
              fallback={
                <EmptyState
                  icon="models"
                  title={search() ? lang.t("settings.specialists.empty.noMatching") : lang.t("settings.specialists.empty.noSpecialists")}
                  hint={lang.t("settings.specialists.empty.hint")}
                />
              }
            >
              <Show when={custom().length > 0}>
                <div class="flex flex-col gap-2">
                  <SectionLabel label={lang.t("settings.specialists.section.custom")} count={custom().length} />
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
                  <SectionLabel label={lang.t("settings.specialists.section.builtIn")} count={builtIn().length} />
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
  const lang = useLanguage()
  const modeLabel = () =>
    props.agent.mode === "subagent" ? lang.t("settings.specialists.mode.subagent") : props.agent.mode === "all" ? lang.t("settings.specialists.mode.both") : lang.t("settings.specialists.mode.primary")
  return (
    <Row>
      <Avatar monogram={props.agent.name.slice(0, 1)} tint={props.agent.color ?? undefined} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-14-medium text-text-strong truncate">{props.agent.name}</span>
          <Chip>{modeLabel()}</Chip>
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
  const lang = useLanguage()
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [mode, setMode] = createSignal<Mode>("subagent")
  const valid = () => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name().trim()) && description().trim().length > 0
  return (
    <div class="flex flex-col gap-4">
      <SectionLabel label={lang.t("settings.specialists.form.createHeading")} />
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[4px] bg-surface-base/40">
        <FormField
          label={lang.t("settings.specialists.form.name")}
          value={name()}
          onInput={setName}
          placeholder={lang.t("settings.specialists.form.name.placeholder")}
        />
        <FormField
          label={lang.t("settings.specialists.form.description")}
          value={description()}
          onInput={setDescription}
          placeholder={lang.t("settings.specialists.form.description.placeholder")}
        />
        <label class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-strong">{lang.t("settings.specialists.form.mode")}</span>
          <select
            value={mode()}
            class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong outline-none focus:border-border-strong-base"
            onInput={(e) => setMode(e.currentTarget.value as Mode)}
          >
            <option value="subagent">{lang.t("settings.specialists.form.mode.subagent")}</option>
            <option value="primary">{lang.t("settings.specialists.form.mode.primary")}</option>
            <option value="all">{lang.t("settings.specialists.form.mode.both")}</option>
          </select>
        </label>
        <FormField
          label={lang.t("settings.specialists.form.systemPrompt")}
          value={prompt()}
          onInput={setPrompt}
          multiline
          placeholder={lang.t("settings.specialists.form.systemPrompt.placeholder")}
        />
        <div class="flex items-center gap-2">
          <FormButton
            label={props.busy ? lang.t("settings.specialists.status.creating") : lang.t("settings.specialists.action.createSpecialist")}
            disabled={props.busy || !valid()}
            onClick={() => props.onCreate(name().trim(), description().trim(), prompt(), mode())}
          />
          <FormButton label={lang.t("common.cancel")} variant="ghost" onClick={props.onCancel} disabled={props.busy} />
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
