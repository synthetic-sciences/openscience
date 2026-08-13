import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSync } from "@/context/global-sync"
import { useModels, type ModelKey } from "@/context/models"
import {
  displayProviderForModel,
  groupModelRoutes,
  inferenceSource,
  inferenceSourceLabel,
  logicalModelKey,
  modelDisplayName,
  modelRouteValue,
  modelSummary,
  parseModelRoute,
  preservedModelRoute,
} from "@/context/model-catalog"
import { CodexConnection } from "./CodexConnection"
import { ManagedInference } from "./ManagedInference"
import { ProviderKeys } from "./ProviderKeys"
import { ProviderLogo } from "./ProviderLogo"
import { commitPreference } from "./preference-write"
import { modelGroup, modelGroupLabel, modelGroupRank } from "../model-groups"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
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
  value: string
}

type DefaultField = "model" | "small_model"

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
  const [pendingDefaults, setPendingDefaults] = createSignal<Partial<Record<DefaultField, string>>>({})

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

  const defaultValue = (field: DefaultField) => optimisticDefaults()[field] ?? sync.data.config[field]
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
    const current = parseModelRoute(defaultValue("model"))
    return groupModelRoutes({
      models: models.list(),
      current,
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
  const choiceFor = (field: DefaultField) => {
    const pending = pendingDefaults()[field]
    if (pending) return options().find((option) => option.logicalKey === pending)
    const route = parseModelRoute(defaultValue(field))
    return route
      ? options().find((option) => option.logicalKey === logicalModelKey(route.providerID, route.modelID))
      : undefined
  }
  const routesFor = (field: DefaultField) => {
    const choice = choiceFor(field)
    if (!choice) return []
    const configured = parseModelRoute(defaultValue(field))
    if (!configured || logicalModelKey(configured.providerID, configured.modelID) !== choice.logicalKey) {
      return choice.routes
    }
    const exact = models
      .list()
      .find((model) => model.provider.id === configured.providerID && model.id === configured.modelID)
    if (!exact) return choice.routes
    const current = routeOption(exact)
    return choice.routes.map((route) => (route.key.providerID === current.key.providerID ? current : route))
  }
  const currentRoute = (field: DefaultField) => {
    if (pendingDefaults()[field]) return undefined
    const value = defaultValue(field)
    return routesFor(field).find((route) => route.value === value)
  }
  const clearPending = (field: DefaultField) => setPendingDefaults((current) => ({ ...current, [field]: undefined }))
  const selectDefaultModel = (field: DefaultField, choice: Option) => {
    const current = parseModelRoute(defaultValue(field))
    if (current && logicalModelKey(current.providerID, current.modelID) === choice.logicalKey) {
      clearPending(field)
      return
    }
    const route = preservedModelRoute(choice.sourceRoutes, current)
    if (!route) {
      setPendingDefaults((value) => ({ ...value, [field]: choice.logicalKey }))
      return
    }
    clearPending(field)
    void updateDefault({ [field]: modelRouteValue({ providerID: route.provider.id, modelID: route.id }) })
  }
  const selectDefaultRoute = (field: DefaultField, route: RouteOption) => {
    clearPending(field)
    void updateDefault({ [field]: route.value })
  }
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
    if (result.pinned) model.routes.forEach((route) => models.setVisibility(route.key, true))
    setNotice(`${model.label} pinned.`)
  }

  return (
    <div class="settings-models-panel h-full min-h-0">
      <PanelScroll>
        <PanelHeader
          title="Models"
          description="Manage model access, defaults, and the choices shown in the composer."
        />
        <PanelBody>
          <Show when={error()}>
            <div role="alert" class="settings-alert text-12-regular" data-tone="critical">
              {error()}
            </div>
          </Show>
          <Section
            id="model-access"
            title="Access and routing"
            description="Choose how model requests are paid for and connect the exact access routes you use."
          >
            <div class="settings-card models-access-card">
              <ManagedInference onError={setError} />
              <CodexConnection onError={setError} />
            </div>
          </Section>

          <Section
            id="model-defaults"
            title="Defaults"
            description="Choose the starting model for research and lightweight background work."
          >
            <div class="settings-card settings-defaults-card">
              <Row title="Research model" detail="Used when a new session starts.">
                <DefaultModelControl
                  label="Research model"
                  options={options()}
                  current={choiceFor("model")}
                  routes={routesFor("model")}
                  currentRoute={currentRoute("model")}
                  disabled={defaultsBusy()}
                  onModel={(choice) => selectDefaultModel("model", choice)}
                  onRoute={(route) => selectDefaultRoute("model", route)}
                />
              </Row>
              <Row title="Background model" detail="Used for titles and compact background work.">
                <DefaultModelControl
                  label="Background model"
                  options={options()}
                  current={choiceFor("small_model")}
                  routes={routesFor("small_model")}
                  currentRoute={currentRoute("small_model")}
                  disabled={defaultsBusy()}
                  onModel={(choice) => selectDefaultModel("small_model", choice)}
                  onRoute={(route) => selectDefaultRoute("small_model", route)}
                />
              </Row>
            </div>
          </Section>

          <Section
            id="provider-keys"
            title="Provider keys"
            description="Connect a provider account directly. Keys stay in the owner-only local auth file."
          >
            <ProviderKeys onError={setError} />
          </Section>

          <Section
            id="model-visibility"
            title="Composer models"
            description="Pin quick choices and hide models you do not want in the composer."
          >
            <div class="models-catalog-summary">
              <p class="min-w-0 flex-1 break-words text-11-regular text-text-weak" aria-live="polite">
                {notice()}
              </p>
              <span class="models-pin-count">{models.pinned.list().length}/3 pinned</span>
            </div>
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
                              onChange={(checked) =>
                                model.routes.forEach((route) => models.setVisibility(route.key, checked))
                              }
                            >
                              {`${model.visible ? "Hide" : "Show"} ${model.label}`}
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
          </Section>
        </PanelBody>
      </PanelScroll>
    </div>
  )
}

function DefaultModelControl(props: {
  label: string
  options: Option[]
  current?: Option
  routes: RouteOption[]
  currentRoute?: RouteOption
  disabled: boolean
  onModel: (option: Option) => void
  onRoute: (route: RouteOption) => void
}) {
  return (
    <div class="models-default-controls">
      <Select
        aria-label={props.label}
        options={props.options}
        current={props.current}
        value={(option) => option.value}
        label={(option) => option.label}
        disabled={props.disabled || props.options.length === 0}
        onSelect={(option) => option && props.onModel(option)}
        variant="secondary"
        size="small"
        triggerVariant="settings"
        placeholder={props.options.length === 0 ? "No models available" : "Auto"}
      >
        {(option) => (
          <Show when={option}>
            {(item) => (
              <span class="models-default-option">
                <ProviderLogo id={item().providerLogo} label={item().provider} size="small" />
                <span class="truncate">{item().label}</span>
                <span class="models-default-option__provider">
                  {item().routes.length > 1 ? `${item().routes.length} access routes` : item().provider}
                </span>
              </span>
            )}
          </Show>
        )}
      </Select>
      <Show when={props.routes.length > 1}>
        <Select
          aria-label={`${props.label} access`}
          class="models-default-route-select"
          options={props.routes}
          current={props.currentRoute}
          value={(route) => route.value}
          label={(route) => route.access}
          disabled={props.disabled}
          onSelect={(route) => route && props.onRoute(route)}
          variant="secondary"
          size="small"
          triggerVariant="settings"
          placeholder="Choose access"
        >
          {(route) => (
            <Show when={route}>
              {(item) => (
                <span class="models-default-option">
                  <ProviderLogo id={item().providerLogo} label={item().provider} size="small" />
                  <span class="truncate">{item().access}</span>
                  <span class="models-default-option__provider">{item().provider}</span>
                </span>
              )}
            </Show>
          )}
        </Select>
      </Show>
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
