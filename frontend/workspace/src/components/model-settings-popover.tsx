import { Popover as Kobalte } from "@kobalte/core/popover"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { ProviderIcon } from "@synsci/ui/provider-icon"
import { iconNames, type IconName } from "@synsci/ui/icons/provider"
import { useDialog } from "@synsci/ui/context/dialog"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type Component } from "solid-js"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import {
  displayProviderForModel,
  groupModelRoutes,
  inferenceSource,
  inferenceSourceLabel,
  logicalModelKey,
  modelContext,
  modelDisplayName,
  modelSummary,
} from "@/context/model-catalog"
import { DialogSettings } from "./dialog-settings"
import { modelGroup, modelGroupLabel, modelGroupLabelRank } from "./model-groups"
import { modelControl } from "./model-presentation"
import { curateQuickModels } from "./model-quick"
import "./model-settings-popover.css"

const row = "model-settings-row flex w-full min-w-0 items-center justify-between text-left transition-colors"
const CATALOG_FIRST_CHUNK = 24
const CATALOG_CHUNK = 32

export function takeCatalogGroups<T>(groups: Array<[string, T[]]>, limit: number): Array<[string, T[]]> {
  let remaining = Math.max(0, limit)
  const result: Array<[string, T[]]> = []
  for (const [label, models] of groups) {
    if (remaining <= 0) break
    const visible = models.slice(0, remaining)
    if (visible.length > 0) result.push([label, visible])
    remaining -= visible.length
  }
  return result
}

const MODEL_RADIO_KEYS = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"] as const

export function modelRadioTabKey(keys: string[], selected?: string, focused?: string) {
  if (focused && keys.includes(focused)) return focused
  if (selected && keys.includes(selected)) return selected
  return keys[0]
}

export function modelRadioNavigationTarget(scope: HTMLElement, target: EventTarget | null, key: string) {
  if (!MODEL_RADIO_KEYS.includes(key as (typeof MODEL_RADIO_KEYS)[number])) return undefined
  if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "radio") return undefined
  const items = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')).filter(
    (item) => item.closest('[role="radiogroup"]') === scope,
  )
  const index = items.indexOf(target as HTMLButtonElement)
  if (index < 0 || items.length === 0) return undefined
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : key === "ArrowDown" || key === "ArrowRight"
          ? (index + 1) % items.length
          : (index <= 0 ? items.length : index) - 1
  return items[next]
}

export function focusModelRadio(event: KeyboardEvent) {
  const scope = event.currentTarget
  if (!(scope instanceof HTMLElement)) return
  const item = modelRadioNavigationTarget(scope, event.target, event.key)
  if (!item) return
  event.preventDefault()
  event.stopPropagation()
  item.focus()
}

const providerIcon = (id: string) => {
  const alias = id === "meta" ? "llama" : id === "openai-codex" ? "openai" : id
  return iconNames.includes(alias as IconName) ? (alias as IconName) : undefined
}

export { modelSummary } from "@/context/model-catalog"
export { inferenceSource, inferenceSourceLabel, type InferenceSource } from "@/context/model-catalog"

type ModelOptionListProps = {
  id: string
  kind: "effort" | "speed" | "route"
  title: string
  current: string
  options: Array<{ id: string; label: string }>
  onSelect: (id: string) => void
  onBack: () => void
  onDone?: () => void
}

export const ModelOptionList: Component<ModelOptionListProps> = (props) => {
  const [selected, setSelected] = createSignal(props.current)

  createEffect(() => setSelected(props.current))

  const select = (id: string) => {
    setSelected(id)
    props.onSelect(id)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const scope = event.currentTarget
    if (!(scope instanceof HTMLElement)) return
    const item = modelRadioNavigationTarget(scope, event.target, event.key)
    const value = item?.dataset.modelOptionId
    if (!item || !value) return
    event.preventDefault()
    event.stopPropagation()
    select(value)
    item.focus()
  }

  return (
    <div data-model-menu-scope class="flex flex-col">
      <button type="button" data-model-menu-back={props.kind} class={`${row} justify-start`} onClick={props.onBack}>
        <span aria-hidden="true">‹</span>
        <span data-model-menu-label>{props.title}</span>
      </button>
      <div class="model-settings-divider" />
      <div id={props.id} role="radiogroup" aria-label={props.title} class="flex flex-col" onKeyDown={onKeyDown}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="radio"
              data-model-option={props.kind}
              data-model-option-id={option.id}
              aria-checked={selected() === option.id}
              tabindex={selected() === option.id ? 0 : -1}
              class={row}
              onClick={() => {
                select(option.id)
                ;(props.onDone ?? props.onBack)()
              }}
            >
              <span data-model-menu-label>{option.label}</span>
              <Show when={selected() === option.id}>
                <Icon name="check" size="small" class="model-settings-check" aria-hidden="true" />
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

export const ModelEffortTrigger: Component<{ value: string; expanded?: boolean; onOpen: () => void }> = (props) => (
  <button
    type="button"
    data-model-effort-chip
    aria-label={`Thinking effort: ${props.value}`}
    aria-haspopup="menu"
    aria-expanded={props.expanded ?? false}
    onClick={props.onOpen}
  >
    <strong>{props.value}</strong>
    <Icon name="chevron-down" size="small" aria-hidden="true" />
  </button>
)

export const ModelSettingsPopover: Component<{ trigger?: "label" | "icon" }> = (props) => {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const mobile = createMediaQuery("(max-width: 719px)")
  const [open, setOpen] = createSignal(false)
  const [view, setView] = createSignal<"root" | "models" | "effort" | "speed" | "route">("root")
  const [routeTarget, setRouteTarget] = createSignal("")
  const [routeReturn, setRouteReturn] = createSignal<"root" | "models">("root")
  const [query, setQuery] = createSignal("")
  const [catalogQuery, setCatalogQuery] = createSignal("")
  const [catalogReady, setCatalogReady] = createSignal(false)
  const [catalogLimit, setCatalogLimit] = createSignal(CATALOG_FIRST_CHUNK)
  const [quickFocus, setQuickFocus] = createSignal("")
  const [catalogFocus, setCatalogFocus] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const refs = { content: undefined as HTMLElement | undefined }
  const current = createMemo(() => local.model.current())
  const routeAccess = (model: NonNullable<ReturnType<typeof current>>) =>
    inferenceSourceLabel(
      inferenceSource({
        providerID: model.provider.id,
        credential: model.provider.source,
        billing: sync.data.config.billing?.llm,
      }),
      model.provider.name,
    )
  const recent = createMemo(() =>
    local.model.recent().filter((model): model is NonNullable<typeof model> => Boolean(model)),
  )
  const available = createMemo(() =>
    local.model
      .list()
      .filter(
        (model) =>
          local.model.pin.has({ providerID: model.provider.id, modelID: model.id }) ||
          local.model.visible({ providerID: model.provider.id, modelID: model.id }),
      ),
  )
  const choices = createMemo(() =>
    groupModelRoutes({
      models: available(),
      current: current() ? { providerID: current()!.provider.id, modelID: current()!.id } : undefined,
      recent: recent().map((model) => ({ providerID: model.provider.id, modelID: model.id })),
    }),
  )
  const choiceFor = (model: NonNullable<ReturnType<typeof current>>) =>
    choices().find((choice) => choice.key === logicalModelKey(model.provider.id, model.id))
  const pinnedChoice = (choice: ReturnType<typeof choices>[number]) =>
    choice.routes.some((model) => local.model.pin.has({ providerID: model.provider.id, modelID: model.id }))
  const quick = createMemo(() => {
    const pinned = local.model
      .pinned()
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .flatMap((model) => choiceFor(model)?.model ?? [])
    const selected = current() ? choiceFor(current()!)?.model : undefined
    const recentModels = recent().flatMap((model) => choiceFor(model)?.model ?? [])
    const models = curateQuickModels({
      pinned,
      current: selected,
      recent: recentModels,
      available: choices().map((choice) => choice.model),
    })
    return models.flatMap((model) => choiceFor(model) ?? [])
  })
  const catalog = createMemo(() => {
    const value = catalogQuery().trim().toLowerCase()
    return choices()
      .filter((choice) => {
        if (!value) return true
        return choice.routes.some((model) => {
          const provider = displayProviderForModel(model.provider, model.id).name
          return `${model.name} ${model.id} ${provider} ${routeAccess(model)}`.toLowerCase().includes(value)
        })
      })
      .sort((a, b) => a.model.name.localeCompare(b.model.name))
  })
  const groups = createMemo(() => {
    const map = new Map<string, ReturnType<typeof catalog>>()
    for (const choice of catalog()) {
      const label = modelGroupLabel(
        choice.key.startsWith("openai/") ? "openai" : modelGroup(choice.model, pinnedChoice(choice)),
      )
      map.set(label, [...(map.get(label) ?? []), choice])
    }
    return [...map.entries()].sort(
      ([left], [right]) => modelGroupLabelRank(left) - modelGroupLabelRank(right) || left.localeCompare(right),
    )
  })
  const routeChoice = createMemo(() => choices().find((choice) => choice.key === routeTarget()))
  const choiceName = (choice: ReturnType<typeof choices>[number]) =>
    modelDisplayName(choice.model.name, choice.model.provider.id, choice.model.id)
  const visibleGroups = createMemo(() => (catalogReady() ? takeCatalogGroups(groups(), catalogLimit()) : []))
  const currentChoiceKey = createMemo(() => {
    const model = current()
    return model ? logicalModelKey(model.provider.id, model.id) : undefined
  })
  const quickTab = createMemo(() =>
    modelRadioTabKey(
      quick().map((choice) => choice.key),
      currentChoiceKey(),
      quickFocus(),
    ),
  )
  const catalogTab = createMemo(() =>
    modelRadioTabKey(
      visibleGroups().flatMap((group) => group[1].map((choice) => choice.key)),
      currentChoiceKey(),
      catalogFocus(),
    ),
  )

  let prepareFrame = 0
  let searchTimer = 0

  const finishCatalog = () => {
    catalog()
    groups()
    setCatalogReady(true)
  }

  const prepareCatalog = () => {
    if (catalogReady() || prepareFrame) return
    // Warm the derived catalog immediately after the lightweight menu paints.
    // Opening More models then becomes an instant view change, not a second
    // loading interaction.
    prepareFrame = requestAnimationFrame(() => {
      prepareFrame = 0
      finishCatalog()
    })
  }

  createEffect(() => {
    if (open()) {
      prepareCatalog()
      return
    }
    window.clearTimeout(searchTimer)
    if (prepareFrame) cancelAnimationFrame(prepareFrame)
    prepareFrame = 0
  })

  createEffect(() => {
    if (view() !== "models" || !catalogReady()) return
    catalogQuery()
    const total = catalog().length
    setCatalogLimit(Math.min(CATALOG_FIRST_CHUNK, total))
    if (total <= CATALOG_FIRST_CHUNK) return
    let frame = requestAnimationFrame(function load() {
      setCatalogLimit((current) => Math.min(total, current + CATALOG_CHUNK))
      if (catalogLimit() < total) frame = requestAnimationFrame(load)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const searchCatalog = (value: string) => {
    setQuery(value)
    window.clearTimeout(searchTimer)
    // Keep keystrokes immediate, then do the catalog-wide filter once the
    // short burst settles. This is state deferral, not visible animation.
    searchTimer = window.setTimeout(() => setCatalogQuery(value), 70)
  }

  onCleanup(() => {
    if (prepareFrame) cancelAnimationFrame(prepareFrame)
    window.clearTimeout(searchTimer)
  })

  const resetMenu = () => {
    window.clearTimeout(searchTimer)
    if (prepareFrame) cancelAnimationFrame(prepareFrame)
    prepareFrame = 0
    setView("root")
    setQuery("")
    setCatalogQuery("")
    setRouteTarget("")
  }

  const close = () => {
    setOpen(false)
    resetMenu()
  }

  createEffect(() => {
    if (!open()) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener("keydown", dismiss, true)
    onCleanup(() => window.removeEventListener("keydown", dismiss, true))
  })

  const control = createMemo(() =>
    modelControl({
      name: current() ? modelDisplayName(current()!.name, current()!.provider.id, current()!.id) : "Select model",
      variants: local.model.variant.list(),
      modes: local.model.tier.list(),
      currentEffort: local.model.variant.current(),
      currentSpeed: local.model.tier.current(),
      advanced: [],
    }),
  )
  createEffect(() => {
    const value = control()
    const updates = [
      value.reset.effort ? `Effort reset to ${value.effort?.value ?? "Standard"}.` : undefined,
      value.reset.speed ? `Speed reset to ${value.speed?.value ?? "Standard"}.` : undefined,
    ].filter((message): message is string => Boolean(message))

    if (updates.length > 0) setNotice(updates.join(" "))
    if (value.reset.effort) local.model.variant.set(value.reset.effort)
    if (value.reset.speed) local.model.tier.set(value.reset.speed)
    if (view() === "effort" && !value.effort) setView("root")
    if (view() === "speed" && !value.speed) setView("root")
  })

  const focus = (selector: string, reset = false) =>
    queueMicrotask(() => {
      if (reset && refs.content) refs.content.scrollTop = 0
      refs.content?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
    })

  const show = (next: "effort" | "speed") => {
    setView(next)
    focus(`[data-model-option="${next}"][aria-checked="true"]`)
  }

  const root = (next: "effort" | "speed") => {
    setView("root")
    focus(`[data-model-menu-row="${next}"]`, true)
  }

  const exact = (model: NonNullable<ReturnType<typeof current>>) => `${model.provider.id}/${model.id}`
  const routeLabel = (model: NonNullable<ReturnType<typeof current>>) => {
    const provider = displayProviderForModel(model.provider, model.id).name
    return `${provider} · ${routeAccess(model)}`
  }
  const showRoutes = (choice: ReturnType<typeof choices>[number], back: "root" | "models") => {
    setRouteTarget(choice.key)
    setRouteReturn(back)
    setView("route")
    focus('[data-model-option="route"][aria-checked="true"]', true)
  }
  const selectChoice = (choice: ReturnType<typeof choices>[number], back: "root" | "models") => {
    if (choice.routes.length > 1) {
      showRoutes(choice, back)
      return
    }
    const model = choice.model
    local.model.set({ providerID: model.provider.id, modelID: model.id }, { recent: true })
    close()
  }

  const choose = () => {
    window.clearTimeout(searchTimer)
    setQuery("")
    setCatalogQuery("")
    setCatalogLimit(CATALOG_FIRST_CHUNK)
    if (!catalogReady()) {
      if (prepareFrame) cancelAnimationFrame(prepareFrame)
      prepareFrame = 0
      finishCatalog()
    }
    setView("models")
    focus("[data-model-catalog-search]", true)
  }

  const manage = () => {
    close()
    queueMicrotask(() => dialog.show(() => <DialogSettings initial="models" />))
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close()
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLInputElement) return
    if (target.matches("[data-model-menu-back]") || target.closest('[role="radiogroup"]')) return
    const scope = target.closest<HTMLElement>("[data-model-menu-scope]") ?? refs.content
    if (!scope) return
    const items = Array.from(scope.querySelectorAll<HTMLElement>("[data-model-menu-item]:not([disabled])"))
    if (items.length === 0) return
    const index = items.indexOf(target)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (Math.max(index, -1) + 1) % items.length
            : (index <= 0 ? items.length : index) - 1
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <Kobalte
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetMenu()
      }}
      modal={mobile()}
      placement="top-end"
      gutter={12}
    >
      <div data-model-control-group={props.trigger ?? "label"}>
        <Kobalte.Trigger
          as={Button}
          type="button"
          data-model-settings-trigger
          data-model-settings-trigger-style={props.trigger ?? "label"}
          variant="ghost"
          class={
            props.trigger === "icon"
              ? "model-settings-trigger--icon size-9 shrink-0"
              : "model-settings-trigger--label min-w-0"
          }
          aria-label={`Model: ${control().trigger}`}
        >
          <Show
            when={props.trigger === "icon"}
            fallback={
              <>
                <span class="truncate">{control().trigger}</span>
                <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
              </>
            }
          >
            <Icon name="sliders" />
          </Show>
        </Kobalte.Trigger>
        <Show when={props.trigger !== "icon" && control().effort}>
          {(effort) => (
            <ModelEffortTrigger
              value={effort().value}
              expanded={open() && view() === "effort"}
              onOpen={() => {
                setOpen(true)
                show("effort")
              }}
            />
          )}
        </Show>
      </div>
      <Kobalte.Portal>
        <div data-mobile-model-settings-overlay onPointerDown={close} />
        <Kobalte.Content
          ref={(element) => (refs.content = element)}
          data-model-settings-popover
          data-model-settings-view={view()}
          class="z-50 outline-none"
          onEscapeKeyDown={(event) => {
            close()
            event.preventDefault()
            event.stopPropagation()
          }}
          onKeyDown={onMenuKeyDown}
        >
          <header class="mobile-model-settings__header">
            <Kobalte.Title>Options</Kobalte.Title>
            <IconButton type="button" icon="close" variant="ghost" aria-label="Close model options" onClick={close} />
          </header>
          <p aria-live="polite" class="sr-only">
            {notice()}
          </p>

          <div class="mobile-model-settings__body">
            <Switch>
              <Match when={view() === "root"}>
                <div data-model-menu-scope class="flex flex-col">
                  <div
                    class="model-settings-models"
                    role="radiogroup"
                    aria-label="Model"
                    aria-orientation="vertical"
                    onKeyDown={focusModelRadio}
                  >
                    <p class="model-settings-heading">Suggested models</p>
                    <For each={quick()}>
                      {(choice) => {
                        const model = choice.model
                        const selected = () =>
                          choice.routes.some((route) => current() && exact(route) === exact(current()!))
                        const provider = () => displayProviderForModel(model.provider, model.id).name
                        return (
                          <button
                            type="button"
                            role="radio"
                            data-model-menu-item
                            data-model-quick
                            data-model-choice={choice.key}
                            data-model-routes={choice.routes.length}
                            aria-checked={selected()}
                            aria-haspopup={choice.routes.length > 1 ? "menu" : undefined}
                            tabindex={quickTab() === choice.key ? 0 : -1}
                            aria-label={`${choiceName(choice)}, ${routeLabel(model)}${
                              choice.routes.length > 1 ? `, ${choice.routes.length} access options` : ""
                            }`}
                            class={row}
                            onFocus={() => setQuickFocus(choice.key)}
                            onClick={() => selectChoice(choice, "root")}
                          >
                            <span class="model-settings-model">
                              <span class="model-settings-model-heading">
                                <strong>{choiceName(choice)}</strong>
                                <span class="model-settings-provider">
                                  <Show
                                    when={providerIcon(displayProviderForModel(model.provider, model.id).id)}
                                    fallback={<span aria-hidden="true">{provider().charAt(0).toUpperCase()}</span>}
                                  >
                                    {(icon) => <ProviderIcon id={icon()} aria-hidden="true" />}
                                  </Show>
                                  {provider()} · {routeAccess(model)}
                                  {choice.routes.length > 1 ? ` · ${choice.routes.length} access` : ""}
                                </span>
                              </span>
                              <small>
                                {model.capabilities.reasoning ? "Reasoning · " : ""}
                                {modelContext(model.limit.context)} context
                              </small>
                            </span>
                            <Show
                              when={choice.routes.length > 1}
                              fallback={
                                <Show when={selected()}>
                                  <Icon name="check" size="small" class="model-settings-check" aria-hidden="true" />
                                </Show>
                              }
                            >
                              <span aria-hidden="true" data-model-menu-value>
                                ›
                              </span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                  <div class="model-settings-divider" />
                  <button
                    type="button"
                    data-model-menu-item
                    data-model-menu-row="model"
                    class={`${row} model-settings-more`}
                    onClick={choose}
                  >
                    <span class="model-settings-setting">
                      <span data-model-menu-label>More models</span>
                      <small>Browse models from your connected providers.</small>
                    </span>
                    <span aria-hidden="true" data-model-menu-value>
                      ›
                    </span>
                  </button>
                  <div class="model-settings-divider" />

                  <Show when={control().effort}>
                    {(effort) => (
                      <button
                        type="button"
                        data-model-menu-item
                        data-model-menu-row="effort"
                        class={row}
                        aria-controls="model-effort-options"
                        aria-expanded={view() === "effort"}
                        onClick={() => show("effort")}
                      >
                        <span class="model-settings-setting">
                          <span data-model-menu-label>Thinking effort</span>
                          <small>Choose how deeply the model reasons.</small>
                        </span>
                        <span data-model-menu-value class="flex min-w-0 items-center">
                          <span class="truncate">{effort().value}</span>
                          <span aria-hidden="true">›</span>
                        </span>
                      </button>
                    )}
                  </Show>

                  <Show when={control().speed}>
                    {(speed) => (
                      <button
                        type="button"
                        data-model-menu-item
                        data-model-menu-row="speed"
                        class={row}
                        aria-controls="model-speed-options"
                        aria-expanded={view() === "speed"}
                        onClick={() => show("speed")}
                      >
                        <span class="model-settings-setting">
                          <span data-model-menu-label>{speed().label}</span>
                          <small>Choose the provider's latency tier.</small>
                        </span>
                        <span data-model-menu-value class="flex min-w-0 items-center">
                          <span class="truncate">{speed().value}</span>
                          <span aria-hidden="true">›</span>
                        </span>
                      </button>
                    )}
                  </Show>
                </div>
              </Match>

              <Match when={view() === "models"}>
                <div data-model-menu-scope class="model-settings-browser">
                  <button
                    type="button"
                    data-model-menu-back="models"
                    class={`${row} justify-start`}
                    onClick={() => setView("root")}
                  >
                    <span aria-hidden="true">‹</span>
                    <span data-model-menu-label>Models</span>
                  </button>
                  <div class="model-settings-divider" />
                  <label class="model-settings-search">
                    <Icon name="magnifying-glass" size="small" aria-hidden="true" />
                    <input
                      data-model-catalog-search
                      type="search"
                      value={query()}
                      onInput={(event) => searchCatalog(event.currentTarget.value)}
                      placeholder="Find a model or provider"
                      aria-label="Find a model or provider"
                    />
                  </label>
                  <div
                    class="model-settings-catalog"
                    role="radiogroup"
                    aria-label="Available models"
                    aria-orientation="vertical"
                    onKeyDown={focusModelRadio}
                  >
                    <Show when={catalogReady()} fallback={<p class="model-settings-empty">Loading models…</p>}>
                      <For each={visibleGroups()}>
                        {(group) => (
                          <section class="model-settings-group" aria-label={group[0]}>
                            <p class="model-settings-heading">{group[0]}</p>
                            <For each={group[1]}>
                              {(choice) => {
                                const model = choice.model
                                const selected = () =>
                                  choice.routes.some((route) => current() && exact(route) === exact(current()!))
                                return (
                                  <button
                                    type="button"
                                    role="radio"
                                    data-model-menu-item
                                    data-model-catalog-item
                                    data-model-choice={choice.key}
                                    data-model-routes={choice.routes.length}
                                    aria-checked={selected()}
                                    aria-haspopup={choice.routes.length > 1 ? "menu" : undefined}
                                    tabindex={catalogTab() === choice.key ? 0 : -1}
                                    aria-label={`${choiceName(choice)}, ${routeLabel(model)}${
                                      choice.routes.length > 1 ? `, ${choice.routes.length} access options` : ""
                                    }`}
                                    class={row}
                                    onFocus={() => setCatalogFocus(choice.key)}
                                    onClick={() => selectChoice(choice, "models")}
                                  >
                                    <span class="model-settings-model">
                                      <strong>{choiceName(choice)}</strong>
                                      <small>
                                        {modelSummary({
                                          reasoning: model.capabilities.reasoning,
                                          context: model.limit.context,
                                          provider: routeLabel(model),
                                        })}
                                        {choice.routes.length > 1 ? ` · ${choice.routes.length} access options` : ""}
                                      </small>
                                    </span>
                                    <Show
                                      when={choice.routes.length > 1}
                                      fallback={
                                        <Show when={selected()}>
                                          <Icon
                                            name="check"
                                            size="small"
                                            class="model-settings-check"
                                            aria-hidden="true"
                                          />
                                        </Show>
                                      }
                                    >
                                      <span aria-hidden="true" data-model-menu-value>
                                        ›
                                      </span>
                                    </Show>
                                  </button>
                                )
                              }}
                            </For>
                          </section>
                        )}
                      </For>
                      <Show when={catalog().length === 0}>
                        <p class="model-settings-empty">No models match “{query()}”.</p>
                      </Show>
                      <Show when={catalogLimit() < catalog().length}>
                        <p class="model-settings-catalog-progress" role="status">
                          Loading more models…
                        </p>
                      </Show>
                    </Show>
                  </div>
                  <div class="model-settings-divider" />
                  <button type="button" data-model-menu-item class={`${row} model-settings-manage`} onClick={manage}>
                    <span class="model-settings-setting">
                      <span data-model-menu-label>Manage models</span>
                      <small>Choose which connected models appear here.</small>
                    </span>
                    <span aria-hidden="true" data-model-menu-value>
                      ›
                    </span>
                  </button>
                </div>
              </Match>

              <Match when={view() === "route" && routeChoice()}>
                {(choice) => {
                  const selected = () => {
                    const model = current()
                    if (!model || logicalModelKey(model.provider.id, model.id) !== choice().key) {
                      return exact(choice().model)
                    }
                    return exact(model)
                  }
                  return (
                    <ModelOptionList
                      id="model-route-options"
                      kind="route"
                      title={`${choiceName(choice())} access`}
                      current={selected()}
                      options={choice().routes.map((model) => ({ id: exact(model), label: routeLabel(model) }))}
                      onSelect={(id) => {
                        const model = choice().routes.find((route) => exact(route) === id)
                        if (!model) return
                        local.model.set({ providerID: model.provider.id, modelID: model.id }, { recent: true })
                      }}
                      onBack={() => {
                        setView(routeReturn())
                        focus(`[data-model-choice="${choice().key}"]`, true)
                      }}
                      onDone={close}
                    />
                  )
                }}
              </Match>

              <Match when={view() === "effort" && control().effort}>
                {(effort) => (
                  <ModelOptionList
                    id="model-effort-options"
                    kind="effort"
                    title="Thinking effort"
                    current={effort().current.id}
                    options={effort().options}
                    onSelect={local.model.variant.set}
                    onBack={() => root("effort")}
                    onDone={close}
                  />
                )}
              </Match>

              <Match when={view() === "speed" && control().speed}>
                {(speed) => (
                  <ModelOptionList
                    id="model-speed-options"
                    kind="speed"
                    title="Speed"
                    current={speed().current.id}
                    options={speed().options}
                    onSelect={local.model.tier.set}
                    onBack={() => root("speed")}
                    onDone={close}
                  />
                )}
              </Match>
            </Switch>
          </div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
