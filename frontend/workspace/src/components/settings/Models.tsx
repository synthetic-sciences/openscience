import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSync } from "@/context/global-sync"
import { useModels, type ModelKey } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { productPreferences } from "@/context/product-preferences"
import {
  displayProviderForModel,
  groupModelRoutes,
  inferenceSource,
  inferenceSourceLabel,
  modelDisplayName,
  modelRouteValue,
  modelSummary,
} from "@/context/model-catalog"
import { CodexConnection } from "./CodexConnection"
import { ManagedInference } from "./ManagedInference"
import { ProviderKeys } from "./ProviderKeys"
import { ProviderLogo } from "./ProviderLogo"
import { modelGroup, modelGroupLabel, modelGroupRank } from "../model-groups"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import { settingsApi } from "./api"
import { type CapabilityPreferences, type DelegationModel, publishCapabilityPreferences } from "../prompt-capabilities"
import "./models.css"

type AvailableModel = ReturnType<ReturnType<typeof useModels>["list"]>[number]

type RouteOption = {
  key: ModelKey
  source: AvailableModel
  access: string
  provider: string
  providerLogo: string
  value: string
}

type Option = {
  key: ModelKey
  logicalKey: string
  label: string
  latest: boolean
  provider: string
  providerLogo: string
  access: string
  routes: RouteOption[]
  sourceRoutes: AvailableModel[]
  group: ReturnType<typeof modelGroup>
  pinned: boolean
  visible: boolean
  reasoning: boolean
  context: number
  local: boolean
  value: string
}

type Scope = "all" | "reasoning" | "latest" | "long"
type OptionGroup<T> = { id: string; label: string; models: T[] }
type WorkerOption = {
  value: string
  label: string
  provider?: string
  providerLogo?: string
  model?: DelegationModel
}

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
  const sdk = useSDK()
  const models = useModels()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const [query, setQuery] = createSignal("")
  const [scope, setScope] = createSignal<Scope>("all")
  const [catalogOpen, setCatalogOpen] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [preferences, preferenceActions] = createResource(() =>
    settingsApi<CapabilityPreferences>(sdk.url, fetchFn, "/settings/preferences"),
  )
  const routeAccess = (item: AvailableModel) =>
    inferenceSourceLabel(
      inferenceSource({
        providerID: item.provider.id,
        credential: item.provider.source,
        billing: sync.data.config.billing?.llm,
      }),
      item.provider.name,
    )
  const routeOption = (item: AvailableModel): RouteOption => {
    const display = displayProviderForModel(item.provider, item.id)
    const key = { providerID: item.provider.id, modelID: item.id }
    return {
      key,
      source: item,
      access: routeAccess(item),
      provider: display.name,
      providerLogo: display.id,
      value: modelRouteValue(key),
    }
  }

  const options = createMemo<Option[]>(() => {
    models.pinned.list()
    return groupModelRoutes({
      models: models.list(),
      recent: models.recent.list(),
    })
      .map((choice) => {
        const item = choice.model
        const key = { providerID: item.provider.id, modelID: item.id }
        const pinned = choice.routes.some((route) =>
          models.pinned.has({ providerID: route.provider.id, modelID: route.id }),
        )
        const display = displayProviderForModel(item.provider, item.id)
        const routes = choice.routes.map(routeOption)
        const access = [...new Set(routes.map((route) => route.access))].join(" + ")
        const local = choice.routes.some((route) => modelGroup(route) === "provider:Local models")
        return {
          group: modelGroup(item, pinned),
          key,
          logicalKey: choice.key,
          label: modelDisplayName(item.name, item.provider.id, item.id),
          latest: choice.routes.some((route) => route.latest),
          pinned,
          visible: choice.routes.some((route) => models.visible({ providerID: route.provider.id, modelID: route.id })),
          reasoning: item.capabilities.reasoning,
          context: item.limit.context,
          local,
          provider: display.name,
          providerLogo: display.id,
          access,
          routes,
          sourceRoutes: choice.routes,
          value: choice.key,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.logicalKey.localeCompare(b.logicalKey))
  })
  const filtered = createMemo(() => {
    const terms = query().trim().toLowerCase().split(/\s+/).filter(Boolean)
    return options().filter((model) => {
      if (!productPreferences.localModels() && model.local) return false
      if (scope() === "reasoning" && !model.reasoning) return false
      if (scope() === "latest" && !model.latest) return false
      if (scope() === "long" && model.context < 500_000) return false

      const label = modelGroupLabel(model.group).toLowerCase()
      const haystack =
        `${model.label} ${model.provider} ${model.access} ${model.value} ${model.routes.map((route) => route.value).join(" ")} ${label}`.toLowerCase()
      return terms.every((term) => {
        if (term === "is:reasoning") return model.reasoning
        if (term === "is:latest") return model.latest
        if (term === "is:long") return model.context >= 500_000
        if (term.startsWith("provider:")) return `${model.provider} ${label}`.toLowerCase().includes(term.slice(9))
        return haystack.includes(term)
      })
    })
  })
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
  const [notice, setNotice] = createSignal("Pinned models appear first. Hidden models stay out of the picker.")
  const pinnedCount = createMemo(() => options().filter((model) => model.pinned).length)
  const visibleCount = createMemo(() => options().filter((model) => model.visible).length)
  const workerOptions = createMemo<WorkerOption[]>(() => {
    const selected = preferences()?.delegation_worker_model
    const routes = models
      .list()
      .filter(
        (model) =>
          models.visible({ providerID: model.provider.id, modelID: model.id }) ||
          (selected?.providerID === model.provider.id && selected.modelID === model.id),
      )
      .map((model) => {
        const display = displayProviderForModel(model.provider, model.id)
        const key = { providerID: model.provider.id, modelID: model.id }
        return {
          value: modelRouteValue(key),
          label: modelDisplayName(model.name, model.provider.id, model.id),
          provider: display.name,
          providerLogo: display.id,
          model: key,
        }
      })
      .toSorted((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
    return [{ value: "inherit", label: "Same as conversation" }, ...routes]
  })
  const workerSelection = createMemo(() => {
    const selected = preferences()?.delegation_worker_model
    if (!selected) return workerOptions()[0]
    return workerOptions().find(
      (option) => option.model?.providerID === selected.providerID && option.model.modelID === selected.modelID,
    )
  })
  const setWorkerModel = async (option: WorkerOption) => {
    const previous = preferences()
    if (!previous) return
    const next = { ...previous, delegation_worker_model: option.model ?? null }
    preferenceActions.mutate(next)
    setError(undefined)
    try {
      const saved = await settingsApi<CapabilityPreferences>(sdk.url, fetchFn, "/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ delegation_worker_model: option.model ?? null }),
      })
      preferenceActions.mutate(saved)
      publishCapabilityPreferences(saved)
    } catch (cause) {
      preferenceActions.mutate(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const togglePin = (model: Option) => {
    if (model.pinned) {
      models.pinned.toggle(model.key)
      setNotice(`${model.label} unpinned.`)
      return
    }
    const result = models.pinned.toggle(model.key)
    if (result.limited) {
      setNotice("Three models are already pinned. Unpin one before adding another.")
      return
    }
    if (result.pinned) models.setVisibility(model.key, true)
    setNotice(`${model.label} pinned.`)
  }

  const setComposerVisibility = (model: Option, checked: boolean) => {
    if (!checked && model.pinned) models.pinned.toggle(model.key)
    models.setVisibility(model.key, checked)
    setNotice(
      checked
        ? `${model.label} shown in the composer.`
        : `${model.label} hidden${model.pinned ? " and unpinned" : ""}.`,
    )
  }

  return (
    <div class="settings-models-panel h-full min-h-0">
      <PanelScroll>
        <PanelHeader title="Models" description="Manage model access and the choices shown in the composer." />
        <PanelBody>
          <Show when={error()}>
            <div role="alert" class="settings-alert text-12-regular" data-tone="critical">
              {error()}
            </div>
          </Show>
          <Section
            id="model-access"
            title="Access and routing"
            description="Choose how model calls use credits, keys, or subscriptions."
          >
            <div class="settings-card models-access-card">
              <ManagedInference onError={setError} />
            </div>
          </Section>

          <Section
            id="provider-keys"
            title="Provider keys"
            description="Connect provider keys and subscriptions. Credentials stay in the owner-only local auth file."
          >
            <div class="settings-card models-access-card">
              <CodexConnection onError={setError} />
            </div>
            <ProviderKeys onError={setError} />
          </Section>

          <Section id="worker-model" title="Worker model">
            <div class="settings-card settings-defaults-card models-worker-card">
              <Select
                aria-label="Worker model"
                options={workerOptions()}
                current={workerSelection()}
                value={(option) => option.value}
                label={(option) => option.label}
                disabled={!preferences()}
                onSelect={(option) => option && void setWorkerModel(option)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              >
                {(option) => (
                  <Show when={option}>
                    {(entry) => (
                      <span class="models-default-option">
                        <Show when={entry().providerLogo}>
                          {(logo) => (
                            <ProviderLogo id={logo()} label={entry().provider ?? "Model provider"} size="small" />
                          )}
                        </Show>
                        <span class="min-w-0 truncate">{entry().label}</span>
                        <Show when={entry().provider}>
                          <span class="models-default-option__provider">{entry().provider}</span>
                        </Show>
                      </span>
                    )}
                  </Show>
                )}
              </Select>
            </div>
          </Section>

          <Section
            id="model-visibility"
            title="Composer models"
            description="Keep the composer focused. Open the full catalog only when you want to change its model list."
          >
            <div class="models-catalog-summary">
              <div class="models-catalog-summary__copy">
                <strong class="text-13-medium text-text-strong">Model picker</strong>
                <span class="text-11-regular text-text-weak">
                  {visibleCount()} shown · {pinnedCount()}/3 pinned
                </span>
              </div>
              <Button
                class="settings-panel-action models-secondary-action"
                size="small"
                variant="secondary"
                aria-expanded={catalogOpen()}
                aria-controls="composer-model-catalog"
                onClick={() => setCatalogOpen((open) => !open)}
              >
                {catalogOpen() ? "Done" : "Customize models"}
              </Button>
            </div>
            <Show when={catalogOpen()}>
              <div id="composer-model-catalog" class="models-catalog-disclosure">
                <p class="models-catalog-notice text-11-regular text-text-weak" aria-live="polite">
                  {notice()}
                </p>
                <div class="models-catalog-toolbar">
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
                  <div class="models-filter-group" aria-label="Model filters">
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
                                      provider:
                                        model.routes.length > 1
                                          ? `${model.provider} · ${model.access}`
                                          : `${model.provider} · ${model.routes[0]?.access ?? model.access}`,
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
                                  checked={model.visible}
                                  onChange={(checked) => setComposerVisibility(model, checked)}
                                >
                                  {`Show ${model.label} in composer`}
                                </Switch>
                              </div>
                            </div>
                          )}
                        </For>
                      </section>
                    )}
                  </For>
                  <Show when={options().length === 0}>
                    <p class="models-catalog-empty" role="status">
                      No models are available yet. Connect an access route or refresh your providers.
                    </p>
                  </Show>
                  <Show when={options().length > 0 && filtered().length === 0}>
                    <p class="px-4 py-6 text-center text-12-regular text-text-weak">No models match this filter.</p>
                  </Show>
                  <Show when={renderLimit() < filtered().length}>
                    <p class="models-catalog-progress" role="status">
                      Loading more models…
                    </p>
                  </Show>
                </div>
              </div>
            </Show>
          </Section>
        </PanelBody>
      </PanelScroll>
    </div>
  )
}
