import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSync } from "@/context/global-sync"
import { useModels, type ModelKey } from "@/context/models"
import { displayProviderForModel, modelSummary } from "@/context/model-catalog"
import { CodexConnection } from "./CodexConnection"
import { ManagedInference } from "./ManagedInference"
import { ProviderKeys } from "./ProviderKeys"
import { ProviderLogo } from "./ProviderLogo"
import { commitPreference } from "./preference-write"
import { modelGroup, modelGroupLabel, modelGroupRank } from "../model-groups"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./models.css"

type Option = {
  key: ModelKey
  label: string
  latest: boolean
  provider: string
  providerLogo: string
  group: ReturnType<typeof modelGroup>
  pinned: boolean
  reasoning: boolean
  context: number
  value: string
}

type Scope = "all" | "reasoning" | "latest" | "long"
type OptionGroup<T> = { id: string; label: string; models: T[] }

export function takeModelGroups<T>(groups: OptionGroup<T>[], limit: number): OptionGroup<T>[] {
  let remaining = Math.max(0, limit)
  const result: OptionGroup<T>[] = []
  for (const group of groups) {
    if (remaining <= 0) break
    const models = group.models.slice(0, remaining)
    if (models.length > 0) result.push({ ...group, models })
    remaining -= models.length
  }
  return result
}

const scopes: Array<{ id: Scope; label: string }> = [
  { id: "all", label: "All" },
  { id: "reasoning", label: "Reasoning" },
  { id: "latest", label: "Latest" },
  { id: "long", label: "Long context" },
]

export default function Models() {
  const sync = useGlobalSync()
  const models = useModels()
  const [query, setQuery] = createSignal("")
  const [scope, setScope] = createSignal<Scope>("all")
  const [error, setError] = createSignal<string>()
  const [defaultsBusy, setDefaultsBusy] = createSignal(false)
  const [optimisticDefaults, setOptimisticDefaults] = createSignal<{ model?: string; small_model?: string }>({})

  const updateDefault = async (patch: { model?: string; small_model?: string }) => {
    if (defaultsBusy()) return
    const previous = optimisticDefaults()
    setOptimisticDefaults((current) => ({ ...current, ...patch }))
    setDefaultsBusy(true)
    setError(undefined)
    const result = await commitPreference(
      async () => {
        await sync.updateConfig(patch)
        return undefined
      },
      () => undefined,
    )
    if (!result.ok) {
      setOptimisticDefaults(previous)
      setError(result.error)
    }
    setDefaultsBusy(false)
  }

  const options = createMemo<Option[]>(() => {
    models.pinned.list()
    return models
      .list()
      .map((item) => {
        const key = { providerID: item.provider.id, modelID: item.id }
        const pinned = models.pinned.has(key)
        const display = displayProviderForModel(item.provider, item.id)
        return {
          group: modelGroup(item, pinned),
          key,
          label: item.name,
          latest: item.latest,
          pinned,
          reasoning: item.capabilities.reasoning,
          context: item.limit.context,
          provider: display.name,
          providerLogo: display.id,
          value: `${item.provider.id}/${item.id}`,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  })
  const filtered = createMemo(() => {
    const terms = query().trim().toLowerCase().split(/\s+/).filter(Boolean)
    return options().filter((model) => {
      if (scope() === "reasoning" && !model.reasoning) return false
      if (scope() === "latest" && !model.latest) return false
      if (scope() === "long" && model.context < 500_000) return false

      const label = modelGroupLabel(model.group).toLowerCase()
      const haystack = `${model.label} ${model.provider} ${model.value} ${label}`.toLowerCase()
      return terms.every((term) => {
        if (term === "is:reasoning") return model.reasoning
        if (term === "is:latest") return model.latest
        if (term === "is:long") return model.context >= 500_000
        if (term.startsWith("provider:")) return `${model.provider} ${label}`.toLowerCase().includes(term.slice(9))
        return haystack.includes(term)
      })
    })
  })
  const primary = () =>
    options().find((model) => model.value === (optimisticDefaults().model ?? sync.data.config.model))
  const background = () =>
    options().find((model) => model.value === (optimisticDefaults().small_model ?? sync.data.config.small_model))
  const groups = createMemo(() => {
    const map = new Map<ReturnType<typeof modelGroup>, Option[]>()
    for (const model of filtered()) map.set(model.group, [...(map.get(model.group) ?? []), model])
    return [...map.entries()]
      .map(([id, items]) => ({ id, label: modelGroupLabel(id), models: items }))
      .sort((a, b) => modelGroupRank(a.id) - modelGroupRank(b.id) || a.label.localeCompare(b.label))
  })
  const [renderLimit, setRenderLimit] = createSignal(48)
  const visibleGroups = createMemo(() => takeModelGroups(groups(), renderLimit()))

  // Mount the long catalog in bounded chunks. The first viewport is useful
  // immediately; the rest fills over subsequent frames instead of forcing one
  // click to synchronously create hundreds of rows.
  createEffect(() => {
    query()
    scope()
    const total = filtered().length
    setRenderLimit(Math.min(48, total))
    if (total <= 48) return
    let frame = requestAnimationFrame(function load() {
      setRenderLimit((current) => Math.min(total, current + 48))
      if (renderLimit() < total) frame = requestAnimationFrame(load)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  const [notice, setNotice] = createSignal("New installations start unpinned. Choose up to three quick models.")

  const togglePin = (model: Option) => {
    const result = models.pinned.toggle(model.key)
    if (result.limited) {
      setNotice("Three models are already pinned. Unpin one before adding another.")
      return
    }
    if (result.pinned) models.setVisibility(model.key, true)
    setNotice(result.pinned ? `${model.label} pinned.` : `${model.label} unpinned.`)
  }

  return (
    <div class="settings-models-panel h-full min-h-0">
      <PanelScroll>
        <PanelHeader
          title="Models"
          description="Choose how OpenScience runs models and keep your everyday options close at hand."
        />
        <PanelBody>
          <Show when={error()}>
            <div role="alert" class="settings-alert text-12-regular" data-tone="critical">
              {error()}
            </div>
          </Show>
          <Section
            id="managed-inference"
            title="Managed inference"
            description="Use OpenScience credits, bring your own key, or use a provider that is already configured."
          >
            <ManagedInference onError={setError} />
          </Section>

          <Section
            id="model-access"
            title="ChatGPT and Codex"
            description="Connect once to use supported OpenAI models. OAuth tokens stay on this machine."
          >
            <CodexConnection onError={setError} />
          </Section>

          <Section
            id="provider-keys"
            title="Provider keys"
            description="Use your own provider account. Keys stay in the owner-only local auth file."
          >
            <ProviderKeys onError={setError} />
          </Section>

          <Section
            id="model-defaults"
            title="Defaults"
            description="Choose the starting model for research and lightweight background work."
          >
            <div class="settings-card settings-defaults-card">
              <Row title="Research model" detail="Used when a new session starts.">
                <Select
                  options={options()}
                  current={primary()}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  disabled={defaultsBusy()}
                  onSelect={(option) => option && void updateDefault({ model: option.value })}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                  placeholder="Auto"
                >
                  {(option) => (
                    <Show when={option}>
                      {(item) => (
                        <span class="models-default-option">
                          <ProviderLogo id={item().providerLogo} label={item().provider} size="small" />
                          <span class="truncate">{item().label}</span>
                          <span class="models-default-option__provider">{item().provider}</span>
                        </span>
                      )}
                    </Show>
                  )}
                </Select>
              </Row>
              <Row title="Background model" detail="Used for titles and compact background work.">
                <Select
                  options={options()}
                  current={background()}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  disabled={defaultsBusy()}
                  onSelect={(option) => option && void updateDefault({ small_model: option.value })}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                  placeholder="Auto"
                >
                  {(option) => (
                    <Show when={option}>
                      {(item) => (
                        <span class="models-default-option">
                          <ProviderLogo id={item().providerLogo} label={item().provider} size="small" />
                          <span class="truncate">{item().label}</span>
                          <span class="models-default-option__provider">{item().provider}</span>
                        </span>
                      )}
                    </Show>
                  )}
                </Select>
              </Row>
            </div>
          </Section>

          <Section
            id="model-visibility"
            title="Composer models"
            description="Pin quick choices and hide models you do not want in the composer."
          >
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <p class="min-w-0 flex-1 break-words text-11-regular text-text-weak" aria-live="polite">
                {notice()}
              </p>
              <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-weak">
                {models.pinned.list().length}/3 pinned
              </span>
            </div>
            <div class="flex flex-col gap-2">
              <label class="settings-control settings-control--search text-text-weak">
                <Icon name="magnifying-glass" size="small" />
                <input
                  type="search"
                  aria-label="Filter models"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search name, provider, or try is:reasoning"
                  class="min-w-0 flex-1 bg-transparent text-13-regular text-text-strong outline-none placeholder:text-text-weaker"
                />
              </label>
              <div class="flex flex-wrap items-center gap-1.5" aria-label="Model filters">
                <For each={scopes}>
                  {(item) => (
                    <button
                      type="button"
                      aria-pressed={scope() === item.id}
                      onClick={() => setScope(item.id)}
                      class="settings-filter-pill"
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div class="settings-card settings-model-catalog">
              <For each={visibleGroups()}>
                {(group) => (
                  <section aria-labelledby={`composer-models-${group.id.replace(/[^a-z0-9-]/gi, "-")}`}>
                    <div class="settings-list-header">
                      <h4
                        id={`composer-models-${group.id.replace(/[^a-z0-9-]/gi, "-")}`}
                        class="text-11-medium text-text-weak"
                      >
                        {group.label}
                      </h4>
                    </div>
                    <For each={group.models}>
                      {(model) => (
                        <div class="settings-row settings-model-row models-compact-row">
                          <div class="models-model-identity">
                            <ProviderLogo id={model.providerLogo} label={model.provider} size="small" />
                            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span class="flex min-w-0 items-center gap-2">
                                <strong class="truncate text-13-medium text-text-strong">{model.label}</strong>
                                <Show when={model.latest}>
                                  <span class="shrink-0 text-10-medium text-text-weaker">Latest</span>
                                </Show>
                              </span>
                              <span class="truncate text-11-regular text-text-weak">
                                {modelSummary({
                                  reasoning: model.reasoning,
                                  context: model.context,
                                  provider: model.provider,
                                })}
                              </span>
                            </div>
                          </div>
                          <div class="ml-auto flex max-w-full shrink-0 items-center gap-2">
                            <button
                              type="button"
                              class="settings-icon-action"
                              data-pinned={model.pinned ? "true" : undefined}
                              aria-pressed={model.pinned}
                              aria-label={`${model.pinned ? "Unpin" : "Pin"} ${model.label}`}
                              title={model.pinned ? "Remove from quick models" : "Pin to quick models"}
                              onClick={() => togglePin(model)}
                            >
                              <Icon name={model.pinned ? "pin-filled" : "pin"} size="small" />
                            </button>
                            <Switch
                              hideLabel
                              checked={models.visible(model.key)}
                              onChange={(checked) => models.setVisibility(model.key, checked)}
                            >
                              {`${models.visible(model.key) ? "Hide" : "Show"} ${model.label}`}
                            </Switch>
                          </div>
                        </div>
                      )}
                    </For>
                  </section>
                )}
              </For>
              <Show when={filtered().length === 0}>
                <p class="px-4 py-6 text-center text-12-regular text-text-weak">No models match this filter.</p>
              </Show>
              <Show when={renderLimit() < filtered().length}>
                <p class="models-catalog-progress" role="status">
                  Loading more models…
                </p>
              </Show>
            </div>
          </Section>
        </PanelBody>
      </PanelScroll>
    </div>
  )
}

function Row(props: { title: string; detail: string; children: JSX.Element }) {
  return (
    <div class="settings-row justify-between">
      <div class="flex min-w-0 flex-1 basis-[220px] items-center">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-13-medium text-text-strong">{props.title}</span>
          <span class="text-12-regular text-text-weak">{props.detail}</span>
        </div>
      </div>
      <div class="ml-auto max-w-full flex-shrink-0">{props.children}</div>
    </div>
  )
}
