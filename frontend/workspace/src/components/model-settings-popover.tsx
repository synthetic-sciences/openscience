import { Popover as Kobalte } from "@kobalte/core/popover"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { ProviderIcon } from "@synsci/ui/provider-icon"
import { iconNames, type IconName } from "@synsci/ui/icons/provider"
import { useDialog } from "@synsci/ui/context/dialog"
import { Switch } from "@synsci/ui/switch"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component, type JSX } from "solid-js"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import {
  COMPOSER_MODEL_ROSTER,
  displayProviderForModel,
  groupModelRoutes,
  logicalModelKey,
  modelContext,
  modelDisplayName,
  modelSummary,
  parseModelRoute,
  preservedModelRoute,
} from "@/context/model-catalog"
import { DialogSettings } from "./dialog-settings"
import { modelGroup, modelGroupLabel, modelGroupLabelRank } from "./model-groups"
import { exactRouteFastMode } from "./model-fast"
import { modelControl } from "./model-presentation"
import { curateQuickModelRows, curateQuickModels } from "./model-quick"
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

const providerLabels: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  xai: "xAI",
  zai: "Z.AI",
}

const MANAGE_MODELS_HINT = "Choose which models appear here."

const ModelMark: Component<{ id: string; name: string }> = (props) => (
  <span class="model-settings-logo" aria-hidden="true">
    <Show when={providerIcon(props.id)} fallback={<span>{props.name.charAt(0).toUpperCase()}</span>}>
      {(icon) => <ProviderIcon id={icon()} />}
    </Show>
  </span>
)

export { modelSummary } from "@/context/model-catalog"
export { inferenceSource, inferenceSourceLabel, type InferenceSource } from "@/context/model-catalog"

type ModelOptionListProps = {
  id: string
  kind: "effort" | "route" | "context"
  title: string
  current: string
  options: Array<{ id: string; label: string }>
  compact?: boolean
  onSelect: (id: string) => void
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
    item.focus()
    select(value)
  }

  return (
    <div data-model-option-group={props.kind} data-model-options-compact={props.compact ? "" : undefined}>
      <div
        id={props.id}
        role="radiogroup"
        aria-label={props.title}
        class="flex flex-col"
        style={
          props.compact
            ? { "--model-option-columns": props.options.length === 4 ? 2 : Math.min(3, props.options.length) }
            : undefined
        }
        onKeyDown={onKeyDown}
      >
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
                props.onDone?.()
              }}
            >
              <span class="model-settings-setting">
                <span data-model-menu-label>{option.label}</span>
              </span>
              <Show when={!props.compact && selected() === option.id}>
                <Icon name="check" size="small" class="model-settings-check" aria-hidden="true" />
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

type ModelPopoverSurfaceProps = {
  kind: "model" | "effort"
  view: "root" | "models" | "effort"
  title: string
  close: () => void
  onBack?: () => void
  backLabel?: string
  initialFocus?: string
  contentRef?: (element: HTMLElement) => void
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
  notice?: string
  children: JSX.Element
}

const ModelPopoverSurface: Component<ModelPopoverSurfaceProps> = (props) => {
  let content: HTMLElement | undefined

  return (
    <Kobalte.Portal>
      <div data-mobile-model-settings-overlay onPointerDown={props.close} />
      <Kobalte.Content
        ref={(element) => {
          content = element
          props.contentRef?.(element)
        }}
        role="dialog"
        data-model-settings-popover
        data-model-popover-kind={props.kind}
        data-model-settings-view={props.view}
        class="z-50 outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-2"
        onKeyDown={props.onKeyDown}
        onOpenAutoFocus={(event) => {
          if (!props.initialFocus) return
          event.preventDefault()
          queueMicrotask(() => {
            const target = content?.querySelector<HTMLElement>(props.initialFocus!)
            target?.focus()
            target?.scrollIntoView({ block: "nearest" })
          })
        }}
      >
        <header class="model-settings-popover__header" data-model-popover-header>
          <Show when={props.onBack}>
            {(onBack) => (
              <IconButton
                type="button"
                icon="chevron-left"
                variant="ghost"
                class="model-settings-popover__back"
                data-model-menu-back={props.kind}
                aria-label={props.backLabel ?? "Back"}
                onClick={onBack()}
              />
            )}
          </Show>
          <Kobalte.Title>{props.title}</Kobalte.Title>
          <IconButton
            type="button"
            icon="close"
            variant="ghost"
            class="model-settings-popover__close"
            aria-label={`Close ${props.kind === "model" ? "model selector" : "model options"}`}
            onClick={props.close}
          />
        </header>
        <Show when={props.notice}>
          <p class="sr-only" aria-live="polite">
            {props.notice}
          </p>
        </Show>
        <div class="model-settings-popover__body" data-model-settings-layout>
          {props.children}
        </div>
      </Kobalte.Content>
    </Kobalte.Portal>
  )
}

type ModelEffortPanelProps = {
  current: string
  options: Array<{ id: string; label: string }>
  fast?: { active: boolean }
  context?: { current: string; options: Array<{ id: string; label: string }> }
  onEffortSelect: (id: string) => void
  onTierSelect: (id: "standard" | "fast") => void
  onContextSelect?: (id: string) => void
}

export const ModelEffortPanel: Component<ModelEffortPanelProps> = (props) => (
  <div data-model-effort-panel>
    <Show when={props.options.length > 0}>
      <section
        class="model-settings-option-section"
        aria-label={
          props.options.some((option) => option.id.endsWith("-tokens")) ? "Thinking budget" : "Reasoning effort"
        }
      >
        <div class="model-settings-heading">
          {props.options.some((option) => option.id.endsWith("-tokens")) ? "Thinking budget" : "Effort"}
        </div>
        <ModelOptionList
          id="model-effort-options"
          kind="effort"
          title={props.options.some((option) => option.id.endsWith("-tokens")) ? "Thinking budget" : "Reasoning effort"}
          current={props.current}
          options={props.options}
          compact
          onSelect={props.onEffortSelect}
        />
      </section>
    </Show>
    <Show when={props.fast}>
      {(fast) => (
        <section class="model-settings-option-section model-settings-speed-section" aria-label="Fast mode">
          <div data-model-fast-toggle>
            <Switch checked={fast().active} onChange={(checked) => props.onTierSelect(checked ? "fast" : "standard")}>
              <span class="model-settings-fast-label">Fast mode</span>
            </Switch>
          </div>
        </section>
      )}
    </Show>
    <Show when={props.context && props.context.options.length > 1 ? props.context : undefined}>
      {(context) => (
        <section class="model-settings-option-section" aria-label="Context window">
          <div class="model-settings-heading">Context window</div>
          <ModelOptionList
            id="model-context-options"
            kind="context"
            title="Context window"
            current={context().current}
            options={context().options}
            compact
            onSelect={(id) => props.onContextSelect?.(id)}
          />
        </section>
      )}
    </Show>
  </div>
)

type ModelEffortPopoverProps = ModelEffortPanelProps & {
  value: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
}

export const ModelEffortPopover: Component<ModelEffortPopoverProps> = (props) => {
  const [internalOpen, setInternalOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let content: HTMLElement | undefined
  const open = () => props.open ?? internalOpen()
  const setOpen = (next: boolean) => {
    setInternalOpen(next)
    props.onOpenChange?.(next)
    if (!next)
      queueMicrotask(() => {
        const active = document.activeElement
        if (active !== document.body && active instanceof HTMLElement && !content?.contains(active)) return
        trigger?.focus({ preventScroll: true })
      })
  }

  return (
    <Kobalte open={open()} onOpenChange={setOpen} modal={props.modal} placement="top-end" gutter={12}>
      <Kobalte.Trigger
        ref={trigger}
        type="button"
        data-model-effort-chip
        aria-label={
          props.options.length > 0
            ? `Reasoning effort: ${props.value}.${props.fast?.active ? " Fast mode on." : ""} Reasoning options`
            : props.fast
              ? `Fast mode: ${props.fast.active ? "on" : "off"}. Model options`
              : `Context window: ${props.context?.options.find((option) => option.id === props.context?.current)?.label ?? "Default"}. Model options`
        }
      >
        <strong>{props.options.length > 0 ? props.value : props.fast ? "Fast" : "Context"}</strong>
        <Show when={props.fast?.active && props.options.length > 0}>
          <span data-model-fast-indicator aria-hidden="true">
            Fast
          </span>
        </Show>
        <Icon name="chevron-down" size="small" aria-hidden="true" />
      </Kobalte.Trigger>
      <ModelPopoverSurface
        kind="effort"
        view="effort"
        title="Model options"
        close={() => setOpen(false)}
        initialFocus={
          props.options.length > 0
            ? '[data-model-option="effort"][aria-checked="true"]'
            : props.fast
              ? '[data-model-fast-toggle] [data-slot="switch-input"]'
              : '[data-model-option="context"][aria-checked="true"]'
        }
        contentRef={(element) => (content = element)}
      >
        <ModelEffortPanel
          current={props.current}
          options={props.options}
          fast={props.fast}
          context={props.context}
          onEffortSelect={props.onEffortSelect}
          onTierSelect={props.onTierSelect}
          onContextSelect={props.onContextSelect}
        />
      </ModelPopoverSurface>
    </Kobalte>
  )
}

export const ModelSettingsPopover: Component<{ trigger?: "label" | "icon" }> = (props) => {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const mobile = createMediaQuery("(max-width: 719px)")
  const [open, setOpen] = createSignal(false)
  const [effortOpen, setEffortOpen] = createSignal(false)
  const [view, setView] = createSignal<"root" | "models">("root")
  const [query, setQuery] = createSignal("")
  const [catalogQuery, setCatalogQuery] = createSignal("")
  const [catalogReady, setCatalogReady] = createSignal(false)
  const [catalogLimit, setCatalogLimit] = createSignal(CATALOG_FIRST_CHUNK)
  const [quickFocus, setQuickFocus] = createSignal("")
  const [catalogFocus, setCatalogFocus] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const refs = { content: undefined as HTMLElement | undefined }
  const current = createMemo(() => local.model.current())
  const exact = (model: NonNullable<ReturnType<typeof current>>) => `${model.provider.id}/${model.id}`
  const recent = createMemo(() =>
    local.model.recent().filter((model): model is NonNullable<typeof model> => Boolean(model)),
  )
  const available = createMemo(() =>
    local.model.list().filter((model) => local.model.visible({ providerID: model.provider.id, modelID: model.id })),
  )
  const allChoices = createMemo(() =>
    groupModelRoutes({
      models: local.model.list(),
      current: current() ? { providerID: current()!.provider.id, modelID: current()!.id } : undefined,
      recent: recent().map((model) => ({ providerID: model.provider.id, modelID: model.id })),
    }),
  )
  const choices = createMemo(() => {
    const visible = new Set(available().map((model) => exact(model)))
    return allChoices().filter((choice) => choice.routes.some((model) => visible.has(exact(model))))
  })
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
    const models = curateQuickModels({
      pinned,
      current: selected,
      available: choices().map((choice) => choice.model),
    })
    return models.flatMap((model) => choiceFor(model) ?? [])
  })
  const hiddenChoiceKeys = createMemo(
    () =>
      new Set(
        allChoices()
          .filter((choice) =>
            choice.routes.every((model) => !local.model.visible({ providerID: model.provider.id, modelID: model.id })),
          )
          .map((choice) => choice.key),
      ),
  )
  const pinnedChoiceKeys = createMemo(() =>
    local.model
      .pinned()
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .flatMap((model) => choiceFor(model)?.key ?? []),
  )
  const quickRows = createMemo(() =>
    curateQuickModelRows(quick(), { pinned: pinnedChoiceKeys(), hidden: hiddenChoiceKeys() }),
  )
  const catalog = createMemo(() => {
    const value = catalogQuery().trim().toLowerCase()
    return choices()
      .filter((choice) => {
        if (!value) return true
        return choice.routes.some((model) => {
          const provider = displayProviderForModel(model.provider, model.id).name
          return `${model.name} ${model.id} ${provider}`.toLowerCase().includes(value)
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
      COMPOSER_MODEL_ROSTER.some((model) => model.key === currentChoiceKey()) ? currentChoiceKey() : undefined,
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
    setQuickFocus("")
    setCatalogFocus("")
  }

  const close = () => {
    setOpen(false)
    resetMenu()
  }

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
  const fast = createMemo(() => {
    return exactRouteFastMode(current(), local.model.tier.current())
  })

  createEffect(() => {
    const value = control()
    const updates = [
      value.reset.effort ? `Effort reset to ${value.effort?.value ?? "Standard"}.` : undefined,
      value.reset.speed ? `Speed reset to ${value.speed?.value ?? "Standard"}.` : undefined,
    ].filter((message): message is string => Boolean(message))
    if (updates.length > 0) setNotice(updates.join(" "))
    if (value.reset.effort) local.model.variant.set(value.reset.effort)
    if (value.reset.speed) local.model.tier.set(value.reset.speed)
  })

  const focus = (selector: string, reset = false) =>
    queueMicrotask(() => {
      if (reset && refs.content) refs.content.scrollTop = 0
      refs.content?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
    })

  const selectChoice = (choice: ReturnType<typeof choices>[number]) => {
    const selected = current()
    const configured = parseModelRoute(sync.data.config.model)
    const billing = sync.data.config.billing?.llm
    const model =
      preservedModelRoute(
        choice.routes,
        selected ? { providerID: selected.provider.id, modelID: selected.id } : undefined,
      ) ??
      preservedModelRoute(choice.routes, configured) ??
      (billing === "managed"
        ? choice.routes.find((route) => route.provider.id === "openrouter" || route.provider.id.startsWith("synsci"))
        : billing === "byok"
          ? choice.routes.find((route) => route.provider.id !== "openrouter" && !route.provider.id.startsWith("synsci"))
          : undefined) ??
      choice.routes.find((route) => route.provider.id === "openai-codex") ??
      choice.model
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
    <div data-model-control-group={props.trigger ?? "label"}>
      <Kobalte
        open={open()}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) setEffortOpen(false)
          if (!next) resetMenu()
        }}
        modal={mobile()}
        placement="top-end"
        gutter={12}
      >
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
                <Show when={current()}>
                  {(model) => {
                    const provider = () => displayProviderForModel(model().provider, model().id)
                    return <ModelMark id={provider().id} name={provider().name} />
                  }}
                </Show>
                <span class="truncate">{control().trigger}</span>
                <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
              </>
            }
          >
            <Icon name="sliders" />
          </Show>
        </Kobalte.Trigger>
        <ModelPopoverSurface
          kind="model"
          view={view()}
          title={view() === "models" ? "All models" : "Models"}
          close={close}
          onBack={
            view() === "models"
              ? () => {
                  setView("root")
                  focus('[data-model-quick][role="radio"][aria-checked="true"], [data-model-menu-row="model"]', true)
                }
              : undefined
          }
          backLabel="Back to model shortcuts"
          initialFocus='[data-model-quick][role="radio"][aria-checked="true"], [data-model-menu-row="model"]'
          contentRef={(element) => (refs.content = element)}
          onKeyDown={onMenuKeyDown}
          notice={notice()}
        >
          <Show when={view() === "root"}>
            <div class="model-settings-primary">
              <div data-model-menu-scope class="flex flex-col">
                <div
                  class="model-settings-models"
                  role="radiogroup"
                  aria-label="Model"
                  aria-orientation="vertical"
                  onKeyDown={focusModelRadio}
                >
                  <For each={quickRows()}>
                    {(entry) => {
                      if (entry.kind === "unavailable") {
                        const model = entry.model
                        const provider = () => ({
                          id: model.provider,
                          name: providerLabels[model.provider] ?? model.provider,
                        })
                        return (
                          <div
                            data-model-quick
                            data-model-unavailable
                            class={`${row} model-settings-unavailable`}
                            aria-label={`${model.label}, unavailable`}
                          >
                            <ModelMark id={provider().id} name={provider().name} />
                            <span class="model-settings-model">
                              <strong>{model.label}</strong>
                              <small>{`${provider().name} · Unavailable`}</small>
                            </span>
                          </div>
                        )
                      }

                      const choice = entry.choice
                      const model = choice.model
                      const provider = () => displayProviderForModel(model.provider, model.id)
                      const selected = () =>
                        choice.routes.some((route) => current() && exact(route) === exact(current()!))
                      return (
                        <button
                          type="button"
                          role="radio"
                          data-model-menu-item
                          data-model-quick
                          data-model-choice={choice.key}
                          data-model-routes={choice.routes.length}
                          aria-checked={selected()}
                          tabindex={quickTab() === choice.key ? 0 : -1}
                          aria-label={`${choiceName(choice)}, ${provider().name}`}
                          class={row}
                          onFocus={() => setQuickFocus(choice.key)}
                          onClick={() => selectChoice(choice)}
                        >
                          <ModelMark id={provider().id} name={provider().name} />
                          <span class="model-settings-model">
                            <strong>{choiceName(choice)}</strong>
                            <small>{`${provider().name} · ${modelContext(model.limit.context)} context`}</small>
                          </span>
                          <Show when={selected()}>
                            <Icon name="check" size="small" class="model-settings-check" aria-hidden="true" />
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
                  <Icon
                    name="chevron-right"
                    size="small"
                    aria-hidden="true"
                    data-model-menu-value
                    class="model-settings-chevron"
                  />
                </button>
                <button type="button" data-model-menu-item class={`${row} model-settings-manage`} onClick={manage}>
                  <span class="model-settings-setting">
                    <span data-model-menu-label>Manage models</span>
                    <small>{MANAGE_MODELS_HINT}</small>
                  </span>
                  <Icon
                    name="chevron-right"
                    size="small"
                    aria-hidden="true"
                    data-model-menu-value
                    class="model-settings-chevron"
                  />
                </button>
              </div>
            </div>
          </Show>

          <Show when={view() === "models"}>
            <div class="model-settings-secondary">
              <div data-model-menu-scope class="model-settings-browser">
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
                              const provider = () => displayProviderForModel(model.provider, model.id)
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
                                  tabindex={catalogTab() === choice.key ? 0 : -1}
                                  aria-label={`${choiceName(choice)}, ${provider().name}, ${modelContext(
                                    model.limit.context,
                                  )} context`}
                                  class={row}
                                  onFocus={() => setCatalogFocus(choice.key)}
                                  onClick={() => selectChoice(choice)}
                                >
                                  <ModelMark id={provider().id} name={provider().name} />
                                  <span class="model-settings-model">
                                    <strong>{choiceName(choice)}</strong>
                                    <small>
                                      {modelSummary({
                                        reasoning: model.capabilities.reasoning,
                                        context: model.limit.context,
                                        provider: provider().name,
                                      })}
                                    </small>
                                  </span>
                                  <Show when={selected()}>
                                    <Icon name="check" size="small" class="model-settings-check" aria-hidden="true" />
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
                      <div class="model-settings-catalog-progress">
                        <span>
                          Showing {catalogLimit()} of {catalog().length}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setCatalogLimit((current) => Math.min(catalog().length, current + CATALOG_CHUNK))
                          }
                        >
                          Show more
                        </button>
                      </div>
                    </Show>
                  </Show>
                </div>
                <div class="model-settings-divider" />
                <button type="button" data-model-menu-item class={`${row} model-settings-manage`} onClick={manage}>
                  <span class="model-settings-setting">
                    <span data-model-menu-label>Manage models</span>
                    <small>{MANAGE_MODELS_HINT}</small>
                  </span>
                  <Icon
                    name="chevron-right"
                    size="small"
                    aria-hidden="true"
                    data-model-menu-value
                    class="model-settings-chevron"
                  />
                </button>
              </div>
            </div>
          </Show>
        </ModelPopoverSurface>
      </Kobalte>
      <Show when={props.trigger !== "icon" && (control().effort || fast() || local.model.context.list().length > 1)}>
        <ModelEffortPopover
          value={control().effort?.value ?? "Fast"}
          current={control().effort?.current.id ?? "standard"}
          options={control().effort?.options ?? []}
          fast={fast()}
          context={{
            current: String(local.model.context.current()),
            options: local.model.context.list().map((value) => ({
              id: String(value),
              label:
                value === current()?.limit.context ? `Full · ${modelContext(value)}` : `${modelContext(value)} cap`,
            })),
          }}
          open={effortOpen()}
          onOpenChange={(next) => {
            setEffortOpen(next)
            if (!next) return
            setOpen(false)
            resetMenu()
          }}
          modal={mobile()}
          onEffortSelect={(id) => local.model.variant.set(id)}
          onTierSelect={(id) => local.model.tier.set(id)}
          onContextSelect={(id) => local.model.context.set(Number(id))}
        />
      </Show>
    </div>
  )
}
