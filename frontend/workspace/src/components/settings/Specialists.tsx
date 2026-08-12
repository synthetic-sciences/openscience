import { For, Show, createMemo, createResource, createSignal, type Component, type ParentComponent } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import type { IconProps } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import type { Agent, Config } from "@synsci/sdk/v2/client"
import { settingsApi } from "./api"
import {
  PanelScroll,
  PanelHeader,
  PanelBody,
  Section,
  Card,
  Toolbar,
  SearchInput,
  FilterMenu,
  EmptyState,
  FormField,
  FormButton,
} from "./_shared"
import { SPECIALIST_GROUPS, isVisibleSpecialist, specialistGroupFor } from "./specialist-catalog"
import "./specialists.css"

const LABELS: Record<string, string> = {
  research: "Research",
  ml: "ML",
  biology: "Bio",
  physics: "Physics",
  write: "Scientific writing",
  docs: "Docs",
  task: "General",
  explore: "Explore",
  "literature-review": "Literature review",
  critique: "Scientific critique",
  "physics-critique": "Physics critique",
  reviewer: "Research reviewer",
}
const ICONS = {
  research: "models",
  ml: "cpu",
  biology: "flask",
  physics: "atom",
  write: "pencil-line",
  docs: "file",
  task: "task",
  explore: "magnifying-glass",
  "literature-review": "book-open",
  critique: "shield-alert",
  "physics-critique": "atom",
  reviewer: "glasses",
} as const
type Mode = "primary" | "subagent" | "all"
type ModeFilter = "all" | "primary" | "subagent"
type ReviewPreferences = {
  auto: boolean
  model: { providerID: string; modelID: string } | null
}

export default function Specialists() {
  const sdk = useGlobalSDK()
  const globalSDK = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const dialog = useDialog()

  // Reviewer preference — GET/PUT /settings/review (backend/cli/src/settings/
  // review.ts). Manual review stays always available from the session header;
  // this only opts into an automatic pass after a durable artifact save.
  const fetchFn = platform.fetch ?? fetch
  const reviewApi = (init?: RequestInit) => settingsApi<ReviewPreferences>(sdk.url, fetchFn, "/settings/review", init)
  const [reviewPrefs, reviewCtl] = createResource(() => reviewApi())
  const [reviewSaving, setReviewSaving] = createSignal(false)
  let reviewVersion = 0
  async function toggleAutoReview(auto: boolean) {
    const before = reviewPrefs()
    const version = ++reviewVersion
    reviewCtl.mutate({ auto, model: before?.model ?? null })
    setReviewSaving(true)
    try {
      const saved = await reviewApi({
        method: "PUT",
        body: JSON.stringify({ auto, model: before?.model ?? null }),
      })
      if (version === reviewVersion) reviewCtl.mutate(saved)
    } catch (err) {
      if (version === reviewVersion && before) reviewCtl.mutate(before)
      showToast({ variant: "error", title: "Could not update reviewer preference", description: message(err) })
    } finally {
      if (version === reviewVersion) setReviewSaving(false)
    }
  }

  const [agents, agentsCtl] = createResource(async () => {
    const res = await sdk.client.app.agents()
    // This screen is the catalog, so show every real non-hidden specialist,
    // including built-in subagents. Planning remains adaptive in Research and
    // the title/compaction implementation agents stay out of product UI.
    return ((res.data ?? []) as Agent[]).filter(isVisibleSpecialist)
  })

  const [search, setSearch] = createSignal("")
  const [modeFilter, setModeFilter] = createSignal<ModeFilter>("all")
  const [creating, setCreating] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [delegationPending, setDelegationPending] = createSignal<Record<string, number>>({})
  const delegationVersions = new Map<string, number>()
  let delegationWrites = Promise.resolve()

  const visible = createMemo(() => {
    const q = search().trim().toLowerCase()
    const m = modeFilter()
    return (agents() ?? [])
      .filter((a) => matchesModeFilter(a.mode as Mode, m))
      .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q))
  })
  const builtInGroups = createMemo(() =>
    SPECIALIST_GROUPS.map((group) => ({
      ...group,
      agents: visible()
        .filter((agent) => agent.native && specialistGroupFor(agent) === group.id)
        .sort(byName),
    })).filter((group) => group.agents.length > 0),
  )
  const custom = createMemo(() =>
    visible()
      .filter((a) => !a.native)
      .sort(byName),
  )
  const delegated = (name: string) => taskAction(sync.data.config.permission, name) !== "deny"

  const modeOptions = createMemo(
    () =>
      [
        { id: "all", label: "All", count: (agents() ?? []).length },
        {
          id: "primary",
          label: "Session",
          count: (agents() ?? []).filter((a) => a.mode === "primary" || a.mode === "all").length,
        },
        {
          id: "subagent",
          label: "Delegated",
          count: (agents() ?? []).filter((a) => a.mode === "subagent" || a.mode === "all").length,
        },
      ] satisfies Array<{ id: ModeFilter; label: string; count: number }>,
  )

  async function createAgent(name: string, description: string, prompt: string, mode: Mode) {
    if ((agents() ?? []).some((agent) => agent.name === name)) {
      showToast({
        variant: "error",
        title: "Specialist already exists",
        description: `Choose a name other than "${name}".`,
      })
      return
    }
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
    const confirmed = await confirmDialog(dialog, {
      title: `Delete "${name}"?`,
      message: "This removes the custom specialist from your global OpenScience configuration. This cannot be undone.",
      confirmLabel: "Delete specialist",
      danger: true,
    })
    if (!confirmed) return
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

  function markDelegationPending(name: string, delta: number) {
    setDelegationPending((current) => {
      const next = { ...current }
      const count = (next[name] ?? 0) + delta
      if (count > 0) next[name] = count
      else delete next[name]
      return next
    })
  }

  function toggleDelegation(name: string, enabled: boolean) {
    const before = sync.data.config.permission
    const change = taskPermissionChange(before, name, enabled)
    const version = (delegationVersions.get(name) ?? 0) + 1
    delegationVersions.set(name, version)
    sync.set("config", "permission", change.optimistic as Config["permission"])
    markDelegationPending(name, 1)

    const persist = async () => {
      try {
        const latest = taskPermissionChange(sync.data.config.permission, name, enabled)
        await sync.updateConfig({ permission: latest.patch } as Config)
      } catch (err) {
        if (delegationVersions.get(name) === version) {
          sync.set(
            "config",
            "permission",
            restoreExactTaskPermission(sync.data.config.permission, before, name) as Config["permission"],
          )
        }
        showToast({ variant: "error", title: "Could not update specialist", description: message(err) })
      } finally {
        markDelegationPending(name, -1)
      }
    }
    delegationWrites = delegationWrites.then(persist, persist)
  }

  return (
    <div class="specialists-panel">
      <PanelScroll>
        <PanelHeader
          title="Specialists"
          description="Choose who can join a session or be delegated focused research work."
          toolbar={
            <Show when={!creating()}>
              <Toolbar>
                <SearchInput
                  value={search()}
                  onInput={setSearch}
                  placeholder="Search specialists"
                  ariaLabel="Search specialists"
                />
                <FilterMenu
                  options={modeOptions()}
                  value={modeFilter()}
                  onSelect={(mode) => setModeFilter(mode as ModeFilter)}
                  ariaLabel="Filter specialists by mode"
                />
                <button
                  type="button"
                  class="settings-control settings-control--primary specialists-panel__add"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" size="small" aria-hidden="true" />
                  <span>Add specialist</span>
                </button>
              </Toolbar>
            </Show>
          }
        />

        <PanelBody>
          <Show when={creating()}>
            <CreateForm busy={busy()} onCancel={() => setCreating(false)} onCreate={createAgent} />
          </Show>

          <Show when={!creating()}>
            <Show when={reviewPrefs.error}>
              <div class="settings-alert" data-tone="critical" role="alert">
                <span>Reviewer settings could not be loaded. {message(reviewPrefs.error)}</span>
                <button
                  type="button"
                  class="settings-inline-action"
                  disabled={reviewPrefs.loading || reviewSaving()}
                  onClick={() => void reviewCtl.refetch()}
                >
                  Retry
                </button>
              </div>
            </Show>
            <Section
              id="specialists-reviewer-heading"
              title="Review automation"
              description="Run an independent review after a significant result is saved."
            >
              <Card>
                <div
                  class="settings-row specialists-agent specialists-agent--reviewer"
                  data-loading={reviewPrefs.loading ? "true" : undefined}
                  aria-busy={reviewPrefs.loading || reviewSaving() ? "true" : undefined}
                >
                  <div class="specialists-agent__copy">
                    <strong>Automatic result review</strong>
                    <p>Checks durable results without interrupting the active research session.</p>
                  </div>
                  <div class="specialists-agent__availability">
                    <span class="specialists-agent__mode">{reviewPrefs.loading ? "Loading…" : "After save"}</span>
                    <div class="specialists-agent__control">
                      <Switch
                        data-action="specialist-reviewer"
                        hideLabel
                        checked={reviewPrefs()?.auto ?? false}
                        disabled={reviewSaving() || reviewPrefs.loading || !!reviewPrefs.error}
                        onChange={(auto) => void toggleAutoReview(auto)}
                      >
                        Automatically review significant results
                      </Switch>
                    </div>
                  </div>
                </div>
              </Card>
            </Section>

            <Show
              when={!agents.loading}
              fallback={<div class="py-12 text-center text-13-regular text-text-weak">Loading specialists…</div>}
            >
              <Show
                when={!agents.error}
                fallback={
                  <div class="settings-alert" data-tone="critical" role="alert">
                    <span>Specialists could not be loaded. {message(agents.error)}</span>
                    <button type="button" class="settings-inline-action" onClick={() => void agentsCtl.refetch()}>
                      Retry
                    </button>
                  </div>
                }
              >
                <Show
                  when={visible().length > 0}
                  fallback={
                    <EmptyState
                      icon="task"
                      title={search() ? "No matching specialists" : "No specialists"}
                      hint="Create a custom specialist to tailor an agent to your workflow."
                    />
                  }
                >
                  <Section
                    id="specialists-catalog-heading"
                    title="Specialist catalog"
                    description="Roles are grouped by the work they handle. Delegation switches control automatic use."
                    count={visible().length}
                  >
                    <div class="specialists-catalog">
                      <Show when={custom().length > 0}>
                        <SpecialistGroup
                          title="Custom roles"
                          description="Roles defined in your OpenScience configuration."
                          count={custom().length}
                          id="specialists-custom-heading"
                        >
                          <For each={custom()}>
                            {(agent) => (
                              <AgentRow
                                agent={agent}
                                delegated={delegated(agent.name)}
                                onDelegation={(enabled) => toggleDelegation(agent.name, enabled)}
                                onDelete={() => void deleteAgent(agent.name)}
                                busy={busy()}
                                saving={Boolean(delegationPending()[agent.name])}
                              />
                            )}
                          </For>
                        </SpecialistGroup>
                      </Show>

                      <For each={builtInGroups()}>
                        {(group) => (
                          <SpecialistGroup
                            title={group.title}
                            description={group.description}
                            count={group.agents.length}
                            id={`specialists-${group.id}-heading`}
                          >
                            <For each={group.agents}>
                              {(agent) => (
                                <AgentRow
                                  agent={agent}
                                  delegated={delegated(agent.name)}
                                  onDelegation={(enabled) => toggleDelegation(agent.name, enabled)}
                                  busy={busy()}
                                  saving={Boolean(delegationPending()[agent.name])}
                                />
                              )}
                            </For>
                          </SpecialistGroup>
                        )}
                      </For>
                    </div>
                  </Section>
                </Show>
              </Show>
            </Show>
          </Show>
        </PanelBody>
      </PanelScroll>
    </div>
  )
}

const SpecialistGroup: ParentComponent<{ title: string; description: string; count: number; id: string }> = (props) => (
  <section class="specialists-group" aria-labelledby={props.id}>
    <header class="specialists-group__header">
      <div>
        <h4 id={props.id}>{props.title}</h4>
        <p>{props.description}</p>
      </div>
      <span aria-label={`${props.count} specialists`}>{props.count}</span>
    </header>
    <div class="settings-card specialists-group__list" role="list">
      {props.children}
    </div>
  </section>
)

const SpecialistIcon: Component<{ icon: IconProps["name"] }> = (props) => (
  <div class="specialists-agent__icon" aria-hidden="true">
    <Icon name={props.icon} size="small" />
  </div>
)

function AgentRow(props: {
  agent: Agent
  delegated: boolean
  onDelegation: (enabled: boolean) => void
  onDelete?: () => void
  busy: boolean
  saving: boolean
}) {
  const label = () => LABELS[props.agent.name] ?? props.agent.name
  const icon = () => specialistIconFor(props.agent)
  const mode = () => specialistModeMeta(props.agent.mode as Mode)
  return (
    <div
      class="settings-row specialists-agent"
      role="listitem"
      data-delegated={props.delegated ? "true" : "false"}
      data-saving={props.saving ? "true" : undefined}
      aria-busy={props.saving ? "true" : undefined}
    >
      <SpecialistIcon icon={icon()} />
      <div class="specialists-agent__copy">
        <strong>{label()}</strong>
        <Show when={props.agent.description}>
          <p>{props.agent.description}</p>
        </Show>
      </div>
      <div class="specialists-agent__availability">
        <span class="specialists-agent__mode" data-mode={props.agent.mode}>
          {mode().label}
        </span>
        <Show
          when={mode().canDelegate}
          fallback={<span class="specialists-agent__session-only">Always available</span>}
        >
          <div class="specialists-agent__control">
            <Switch
              data-action="specialist-delegation"
              hideLabel
              checked={props.delegated}
              disabled={props.busy}
              onChange={props.onDelegation}
            >
              {props.delegated ? `Stop automatic delegation to ${label()}` : `Allow automatic delegation to ${label()}`}
            </Switch>
          </div>
        </Show>
      </div>
      <Show when={props.onDelete}>
        <IconButton
          icon="trash"
          variant="ghost"
          disabled={props.busy}
          aria-label={`Delete ${label()}`}
          onClick={props.onDelete}
        />
      </Show>
    </div>
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
    <Section
      id="specialists-create-heading"
      title="Create a custom specialist"
      description="Describe a focused role and where it should be available."
    >
      <div class="specialists-panel__form">
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
        <label class="specialists-panel__field">
          <span>Availability</span>
          <select value={mode()} class="settings-field" onInput={(e) => setMode(e.currentTarget.value as Mode)}>
            <option value="subagent">Delegated by other agents</option>
            <option value="primary">Session model</option>
            <option value="all">Session and delegated</option>
          </select>
        </label>
        <FormField
          label="System prompt"
          value={prompt()}
          onInput={setPrompt}
          multiline
          placeholder="Instructions that define this specialist's behavior…"
        />
        <div class="specialists-panel__form-actions">
          <FormButton
            label={props.busy ? "Creating…" : "Create specialist"}
            disabled={props.busy || !valid()}
            onClick={() => props.onCreate(name().trim(), description().trim(), prompt(), mode())}
          />
          <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </Section>
  )
}

export function matchesModeFilter(mode: Mode, filter: ModeFilter) {
  if (filter === "all") return true
  if (filter === "primary") return mode === "primary" || mode === "all"
  return mode === "subagent" || mode === "all"
}

export function specialistModeMeta(mode: Mode): {
  label: string
  canDelegate: boolean
} {
  if (mode === "primary") return { label: "Session", canDelegate: false }
  if (mode === "all") return { label: "Session + delegated", canDelegate: true }
  return { label: "Delegated", canDelegate: true }
}

export function specialistIconFor(agent: Pick<Agent, "name" | "description">): IconProps["name"] {
  const known = ICONS[agent.name as keyof typeof ICONS]
  if (known) return known

  const signature = `${agent.name} ${agent.description ?? ""}`.toLowerCase()
  if (/bio|protein|gene|cell|medical/.test(signature)) return "flask"
  if (/physics|quantum|math/.test(signature)) return "atom"
  if (/write|document|paper|literature|citation/.test(signature)) return "book-open"
  if (/code|software|repo|develop|debug/.test(signature)) return "code"
  if (/review|critique|verify|audit/.test(signature)) return "shield-alert"
  if (/data|model|machine learning|compute/.test(signature)) return "cpu"

  return "task"
}

function byName(a: Agent, b: Agent) {
  return a.name.localeCompare(b.name)
}
function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

type Action = "allow" | "ask" | "deny"

function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny"
}

export function taskAction(permission: unknown, name: string): Action {
  if (isAction(permission)) return permission
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return "allow"
  const task = (permission as Record<string, unknown>).task
  if (isAction(task)) return task
  if (!task || typeof task !== "object" || Array.isArray(task)) return "allow"
  const rules = task as Record<string, unknown>
  return (
    Object.entries(rules).reduce<Action | undefined>(
      (current, [pattern, action]) => (matches(name, pattern) && isAction(action) ? action : current),
      undefined,
    ) ?? "allow"
  )
}

export function taskPermissionChange(permission: unknown, name: string, enabled: boolean) {
  const base = isAction(permission)
    ? { "*": permission }
    : permission && typeof permission === "object" && !Array.isArray(permission)
      ? permission
      : {}
  const existing = (base as Record<string, unknown>).task
  const rules =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, Action>)
      : isAction(existing)
        ? { "*": existing }
        : {}
  const clean = Object.fromEntries(Object.entries(rules).filter(([pattern]) => pattern !== name))
  const task = { ...clean, [name]: enabled ? ("allow" as const) : ("deny" as const) }
  return {
    optimistic: { ...(base as Record<string, unknown>), task },
    patch: { task },
  }
}

export function restoreExactTaskPermission(current: unknown, before: unknown, name: string) {
  const base = isAction(current)
    ? { "*": current }
    : current && typeof current === "object" && !Array.isArray(current)
      ? current
      : {}
  const currentTask = (base as Record<string, unknown>).task
  const rules: Record<string, Action> =
    currentTask && typeof currentTask === "object" && !Array.isArray(currentTask)
      ? { ...(currentTask as Record<string, Action>) }
      : isAction(currentTask)
        ? { "*": currentTask }
        : {}

  const previousTask =
    before && typeof before === "object" && !Array.isArray(before)
      ? (before as Record<string, unknown>).task
      : undefined
  const previousRules =
    previousTask && typeof previousTask === "object" && !Array.isArray(previousTask)
      ? (previousTask as Record<string, unknown>)
      : undefined
  const previousExact = previousRules?.[name]

  if (isAction(previousExact)) rules[name] = previousExact
  else delete rules[name]
  return { ...(base as Record<string, unknown>), task: rules }
}

function matches(value: string, pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(value)
}
