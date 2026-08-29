import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useModels, type ModelKey } from "@/context/models"
import { usePlatform } from "@/context/platform"
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
import { resolveModelAccessRoute, type ModelRouteAccess } from "@/context/model-route-resolution"
import { CodexConnection } from "./CodexConnection"
import { ManagedInference } from "./ManagedInference"
import { ProviderKeys } from "./ProviderKeys"
import { ProviderLogo } from "./ProviderLogo"
import { modelGroup, modelGroupLabel, modelGroupRank } from "../model-groups"
import { FilterMenu, PanelBody, PanelHeader, PanelScroll, RowCopy, SearchInput, Section } from "./_shared"
import { settingsApi } from "./api"
import {
  type CapabilityPreferences,
  type DelegationModel,
  publishCapabilityPreferences,
  sameDelegationModel,
} from "../prompt-capabilities"
import "./models.css"

type AvailableModel = ReturnType<ReturnType<typeof useModels>["list"]>[number]

type RouteOption = {
  key: ModelKey
  source: AvailableModel
  routeAccess: ModelRouteAccess
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
type BillingPreference = { llm: "managed" | "byok" | null }
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
  const sdk = useGlobalSDK()
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
  const [billing, billingActions] = createResource(() =>
    settingsApi<BillingPreference>(sdk.url, fetchFn, "/settings/billing"),
  )
  const unsubscribeBilling = sync.onProvidersRefreshed(() => void billingActions.refetch())
  onCleanup(unsubscribeBilling)
  const routeOption = (item: AvailableModel): RouteOption => {
    const display = displayProviderForModel(item.provider, item.id)
    const key = { providerID: item.provider.id, modelID: item.id }
    const routeAccess =
      inferenceSource({
        providerID: item.provider.id,
        credential: item.provider.source,
        billing: sync.data.config.billing?.llm,
      }) ?? (item.provider.source === "managed" || item.provider.id.startsWith("synsci") ? "managed" : "byok")
    return {
      key,
      source: item,
      routeAccess,
      access: inferenceSourceLabel(routeAccess, item.provider.name),
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

  // Keep the catalog intentionally bounded. Search and filters still cover the
  // full set, while explicit expansion avoids silently mounting hundreds of
  // rows into a 25,000px settings page.
  createEffect(() => {
    query()
    scope()
    const total = filtered().length
    setRenderLimit(Math.min(48, total))
  })
  const [notice, setNotice] = createSignal("Pinned models appear first. Hidden models stay out of the picker.")
  const pinnedCount = createMemo(() => options().filter((model) => model.pinned).length)
  const visibleCount = createMemo(() => options().filter((model) => model.visible).length)
  const workerOptions = createMemo<WorkerOption[]>(() => {
    const selected = preferences()?.delegation_worker_model ?? undefined
    const currentBilling = billing.latest?.llm ?? sync.data.config.billing?.llm
    const routes = options()
      .filter(
        (model) =>
          model.visible ||
          model.routes.some(
            (route) => route.key.providerID === selected?.providerID && route.key.modelID === selected?.modelID,
          ),
      )
      .flatMap((model): WorkerOption[] => {
        const resolved = resolveModelAccessRoute({
          routes: model.routes.map((route) => ({ ...route.key, access: route.routeAccess, route })),
          billing: currentBilling,
          current: selected,
        })
        const route = resolved?.route
        if (!route) return []
        return [
          {
            value: model.logicalKey,
            label: model.label,
            provider: route.access,
            providerLogo: route.providerLogo,
            model: route.key,
          },
        ]
      })
      .toSorted((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
    const saved =
      selected &&
      !routes.some(
        (option) => option.model?.providerID === selected.providerID && option.model.modelID === selected.modelID,
      )
        ? ({
            value: `saved:${modelRouteValue(selected)}`,
            label: modelDisplayName(selected.modelID, selected.providerID, selected.modelID),
            provider: `Saved · ${selected.providerID}`,
            providerLogo: selected.providerID,
            model: selected,
          } satisfies WorkerOption)
        : undefined
    return [{ value: "inherit", label: "Same as conversation" }, ...(saved ? [saved] : []), ...routes]
  })
  const workerSelection = createMemo(() => {
    const selected = preferences()?.delegation_worker_model ?? undefined
    if (!selected) return workerOptions()[0]
    return workerOptions().find(
      (option) => option.model?.providerID === selected.providerID && option.model.modelID === selected.modelID,
    )
  })
  const setWorkerModel = async (option: WorkerOption) => {
    const previous = preferences()
    if (!previous) return
    // Kobalte may echo a controlled selection when unrelated Settings state
    // refreshes. Only a logical model change is a persistence operation.
    if (sameDelegationModel(previous.delegation_worker_model, option.model)) return
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
        <PanelHeader title="Models" description="Connect model access and choose what appears while you work." />
        <PanelBody>
          <Show when={error()}>
            <div role="alert" class="settings-alert text-12-regular" data-tone="critical">
              {error()}
            </div>
          </Show>
          <Section id="model-access" title="Model access">
            <div class="settings-card models-access-card">
              <ManagedInference onError={setError} />
            </div>
          </Section>

          <Section
            id="model-connections"
            title="Connections"
            description="Subscriptions and provider keys available on this machine."
          >
            <div class="settings-card models-connections-card">
              <CodexConnection onError={setError} />
              <ProviderKeys onError={setError} />
            </div>
          </Section>

          <Section id="model-preferences" title="Model preferences">
            <div class="settings-card settings-defaults-card models-preferences-card">
              <div class="settings-row models-preference-row">
                <RowCopy title="Worker model" description="Used for delegated research." />
                <div class="models-worker-control">
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
                              {(provider) => (
                                <span class="shrink-0 text-10-regular text-text-weaker">· {provider()}</span>
                              )}
                            </Show>
                          </span>
                        )}
                      </Show>
                    )}
                  </Select>
                </div>
              </div>
              <div class="settings-row models-preference-row">
                <RowCopy
                  title="Composer models"
                  description={`${visibleCount()} visible · ${pinnedCount()}/3 pinned for quick access`}
                />
                <Button
                  class="settings-panel-action models-secondary-action"
                  size="small"
                  variant="secondary"
                  aria-expanded={catalogOpen()}
                  aria-controls="composer-model-catalog"
                  onClick={() => setCatalogOpen((open) => !open)}
                >
                  {catalogOpen() ? "Done" : "Edit"}
                </Button>
              </div>
            </div>
            <Show when={catalogOpen()}>
              <div id="composer-model-catalog" class="models-catalog-disclosure">
                <p class="models-catalog-notice text-11-regular text-text-weak" aria-live="polite">
                  {notice()}
                </p>
                <div class="models-catalog-toolbar">
                  <SearchInput
                    value={query()}
                    onInput={setQuery}
                    placeholder="Search models"
                    ariaLabel="Filter models"
                  />
                  <FilterMenu
                    options={scopes}
                    value={scope()}
                    onSelect={(value) => setScope(value as Scope)}
                    ariaLabel="Model filter"
                  />
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
                    <div class="models-catalog-progress" role="status">
                      <span>
                        Showing {renderLimit()} of {filtered().length}
                      </span>
                      <Button
                        class="settings-panel-action models-secondary-action"
                        size="small"
                        variant="secondary"
                        onClick={() => setRenderLimit((current) => Math.min(filtered().length, current + 48))}
                      >
                        Show more
                      </Button>
                    </div>
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
