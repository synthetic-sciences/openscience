import { Popover as Kobalte } from "@kobalte/core/popover"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { useDialog } from "@synsci/ui/context/dialog"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch, type Component } from "solid-js"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import { displayProviderForModel } from "@/context/model-catalog"
import { DialogSelectModel } from "./dialog-select-model"
import { modelControl } from "./model-presentation"
import "./model-settings-popover.css"

const row = "model-settings-row flex w-full min-w-0 items-center justify-between text-left transition-colors"

export type InferenceSource = "managed" | "byok" | "chatgpt"

const SOURCE_LABELS: Record<InferenceSource, string> = {
  managed: "Atlas credits",
  byok: "BYOK",
  chatgpt: "Codex subscription",
}

export function modelSummary(input: { reasoning: boolean; context: number; provider: string }) {
  const context =
    input.context >= 1_000_000
      ? `${(input.context / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}m context`
      : input.context >= 1_000
        ? `${Math.round(input.context / 1_000).toLocaleString()}k context`
        : `${input.context.toLocaleString()} context`
  return `${input.reasoning ? "Reasoning" : "General"} · ${context} · ${input.provider}`
}

/**
 * How the current model is billed and routed: Atlas credits (managed), the
 * user's own key (byok), or a ChatGPT subscription (chatgpt). Uses only signals
 * that are decisive client-side; anything ambiguous returns undefined so the
 * trigger never claims a source it cannot prove.
 *
 * - `synsci*` providers exist only behind the managed Atlas seam.
 * - `openai-codex` exists only through a ChatGPT sign-in.
 * - credential "managed" is `provider.source` reported straight from the
 *   backend, which only sets it once a route is genuinely wallet-billed
 *   (the gateway's managed-proxy branch, or a synced token with no own key
 *   under auto-detect) — trust it outright, ahead of the gateway's
 *   billing-only guess below, which predates that guarantee.
 * - credential "api" is a key the user stored in the local auth store, and the
 *   backend resolves an own key ahead of any managed route.
 * - every provider except the aggregated gateway is BYOK-only for env/config
 *   credentials — the sync policy drops managed per-provider credentials.
 * - the gateway ("openrouter") env credential can be either the user's own key
 *   or the synced managed token; only the explicit byok billing toggle (which
 *   drops managed credentials server-side) resolves it. "custom" covers OAuth
 *   subscriptions (e.g. Copilot) and config-defined providers — also omitted.
 */
export function inferenceSource(input: {
  providerID: string
  credential: "env" | "config" | "custom" | "api" | "managed"
  billing?: "managed" | "byok" | null
}): InferenceSource | undefined {
  if (input.providerID.startsWith("synsci")) return "managed"
  if (input.providerID === "openai-codex") return "chatgpt"
  if (input.credential === "managed") return "managed"
  if (input.credential === "api") return "byok"
  if (input.providerID === "openrouter") return input.billing === "byok" ? "byok" : undefined
  if (input.credential === "env" || input.credential === "config") return "byok"
  return undefined
}

type ModelOptionListProps = {
  id: string
  kind: "effort" | "speed"
  title: string
  current: string
  options: Array<{ id: string; label: string }>
  onSelect: (id: string) => void
  onBack: () => void
}

export const ModelOptionList: Component<ModelOptionListProps> = (props) => {
  const [selected, setSelected] = createSignal(props.current)

  createEffect(() => setSelected(props.current))

  const select = (id: string) => {
    setSelected(id)
    props.onSelect(id)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const target = event.target
    const scope = event.currentTarget
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "radio") return
    if (!(scope instanceof HTMLElement)) return
    const items = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'))
    const index = items.indexOf(target as HTMLButtonElement)
    if (index < 0 || items.length === 0) return
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? (index + 1) % items.length
            : (index <= 0 ? items.length : index) - 1
    const item = items[next]
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
                props.onBack()
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

export const ModelSettingsPopover: Component<{ trigger?: "label" | "icon" }> = (props) => {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const mobile = createMediaQuery("(max-width: 719px)")
  const [open, setOpen] = createSignal(false)
  const [view, setView] = createSignal<"root" | "effort" | "speed">("root")
  const [notice, setNotice] = createSignal("")
  const refs = { content: undefined as HTMLElement | undefined }
  const current = createMemo(() => local.model.current())
  const quick = createMemo(() => {
    // Keep every pin at the top, but leave room for the current selection when
    // it is not pinned so choosing from More models never makes it disappear.
    const models = [
      ...local.model.pinned(),
      current(),
      ...local.model.recent(),
      ...local.model
        .list()
        .filter((model) => local.model.visible({ providerID: model.provider.id, modelID: model.id })),
    ].filter((model): model is NonNullable<typeof model> => Boolean(model))
    const seen = new Set<string>()
    return models
      .filter((model) => {
        const key = `${model.provider.id}/${model.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 5)
  })
  const control = createMemo(() =>
    modelControl({
      name: current()?.name ?? "Select model",
      variants: local.model.variant.list(),
      modes: local.model.tier.list(),
      currentEffort: local.model.variant.current(),
      currentSpeed: local.model.tier.current(),
      advanced: [],
    }),
  )
  const source = createMemo(() => {
    const m = current()
    if (!m) return undefined
    return inferenceSource({
      providerID: m.provider.id,
      credential: m.provider.source,
      billing: sync.data.config.billing?.llm,
    })
  })
  // The inline chip surfaces only a non-default effort; "standard" is the
  // default and stays silent so the strip carries no redundant state.
  const chip = createMemo(() => {
    const effort = control().effort
    if (!effort || effort.current.id === "standard") return undefined
    return effort.current
  })

  createEffect(() => {
    const value = control()
    const updates = [
      value.reset.effort ? `Effort reset to ${value.effort?.value ?? "Auto"}.` : undefined,
      value.reset.speed ? `Speed reset to ${value.speed?.value ?? "Standard"}.` : undefined,
    ].filter((message): message is string => Boolean(message))

    if (updates.length > 0) setNotice(updates.join(" "))
    if (value.reset.effort) local.model.variant.set(value.reset.effort)
    if (value.reset.speed) local.model.tier.set(value.reset.speed)
    if (view() === "effort" && !value.effort) setView("root")
    if (view() === "speed" && !value.speed) setView("root")
  })

  const focus = (selector: string) => queueMicrotask(() => refs.content?.querySelector<HTMLElement>(selector)?.focus())

  const show = (next: "effort" | "speed") => {
    setView(next)
    focus(`[data-model-option="${next}"][aria-checked="true"]`)
  }

  const root = (next: "effort" | "speed") => {
    setView("root")
    focus(`[data-model-menu-row="${next}"]`)
  }

  const choose = () => {
    setOpen(false)
    queueMicrotask(() => dialog.show(() => <DialogSelectModel />))
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
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
        if (!next) setView("root")
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
              <span class="truncate">{control().trigger}</span>
              <Show when={source()}>
                {(value) => (
                  <span data-model-source-label class="shrink-0">
                    · {SOURCE_LABELS[value()]}
                  </span>
                )}
              </Show>
              <span aria-hidden="true" class="shrink-0 text-text-weak">
                ⌄
              </span>
            </>
          }
        >
          <Icon name="sliders" />
        </Show>
      </Kobalte.Trigger>
      <Show when={props.trigger !== "icon" && chip()}>
        {(effort) => (
          <button
            type="button"
            data-model-effort-chip
            aria-label={`Effort ${effort().label} — open effort options`}
            onClick={() => {
              setOpen(true)
              show("effort")
            }}
          >
            {effort().label}
          </button>
        )}
      </Show>
      <Kobalte.Portal>
        <div data-mobile-model-settings-overlay onPointerDown={() => setOpen(false)} />
        <Kobalte.Content
          ref={(element) => (refs.content = element)}
          data-model-settings-popover
          class="z-50 max-h-[min(72dvh,440px)] overflow-y-auto outline-none"
          onKeyDown={onMenuKeyDown}
        >
          <header class="mobile-model-settings__header">
            <Kobalte.Title>Options</Kobalte.Title>
            <IconButton
              type="button"
              icon="close"
              variant="ghost"
              aria-label="Close model options"
              onClick={() => setOpen(false)}
            />
          </header>
          <p aria-live="polite" class="sr-only">
            {notice()}
          </p>

          <div class="mobile-model-settings__body">
            <Switch>
              <Match when={view() === "root"}>
                <div data-model-menu-scope class="flex flex-col">
                  <div class="model-settings-models" role="radiogroup" aria-label="Model">
                    <p class="model-settings-heading">Pinned and recent</p>
                    <For each={quick()}>
                      {(model) => {
                        const selected = () =>
                          current()?.provider.id === model.provider.id && current()?.id === model.id
                        const provider = () => displayProviderForModel(model.provider, model.id).name
                        return (
                          <button
                            type="button"
                            role="radio"
                            data-model-menu-item
                            data-model-quick
                            aria-checked={selected()}
                            class={row}
                            onClick={() => {
                              local.model.set(
                                {
                                  providerID: model.provider.id,
                                  modelID: model.id,
                                },
                                { recent: true },
                              )
                              setOpen(false)
                            }}
                          >
                            <span class="model-settings-model">
                              <strong>{model.name}</strong>
                              <small>
                                {modelSummary({
                                  reasoning: model.capabilities.reasoning,
                                  context: model.limit.context,
                                  provider: provider(),
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
                  </div>
                  <div class="model-settings-divider" />
                  <button
                    type="button"
                    data-model-menu-item
                    data-model-menu-row="model"
                    class={`${row} model-settings-more`}
                    onClick={choose}
                  >
                    <span data-model-menu-label>More models</span>
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
                        <span data-model-menu-label>{effort().label}</span>
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
                        <span data-model-menu-label>{speed().label}</span>
                        <span data-model-menu-value class="flex min-w-0 items-center">
                          <span class="truncate">{speed().value}</span>
                          <span aria-hidden="true">›</span>
                        </span>
                      </button>
                    )}
                  </Show>
                </div>
              </Match>

              <Match when={view() === "effort" && control().effort}>
                {(effort) => (
                  <ModelOptionList
                    id="model-effort-options"
                    kind="effort"
                    title="Effort"
                    current={effort().current.id}
                    options={effort().options}
                    onSelect={local.model.variant.set}
                    onBack={() => root("effort")}
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
