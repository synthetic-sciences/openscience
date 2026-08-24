import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  JSX,
  onCleanup,
  Show,
  ValidComponent,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@synsci/ui/context/dialog"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { Tag } from "@synsci/ui/tag"
import { Dialog } from "@synsci/ui/dialog"
import { List } from "@synsci/ui/list"
import { Tooltip } from "@synsci/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { DialogSettings } from "./dialog-settings"
import { modelGroup, modelGroupLabel, modelGroupLabelRank } from "./model-groups"
import { useLanguage } from "@/context/language"
import { displayProviderForModel } from "@/context/model-catalog"
import type { ModelKey } from "@/context/local"
import { isFreeCost } from "@/utils/model-cost"
import "./dialog-select-model.css"

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  onPinLimit?: () => void
  current?: ModelKey | null
  onPick?: (model: ModelKey) => void
}> = (props) => {
  const local = useLocal()
  const language = useLanguage()

  const models = createMemo(() =>
    (() => {
      local.model.pinned()
      return local.model.list()
    })()
      .filter(
        (m) =>
          local.model.pin.has({ modelID: m.id, providerID: m.provider.id }) ||
          local.model.visible({ modelID: m.id, providerID: m.provider.id }),
      )
      .filter((m) => {
        if (!props.provider) return true
        return m.provider.id === props.provider
      }),
  )
  const category = (model: ReturnType<typeof models>[number]) =>
    modelGroupLabel(modelGroup(model, local.model.pin.has({ providerID: model.provider.id, modelID: model.id })))
  const context = (limit: number) => {
    if (limit >= 1_000_000) return `${(limit / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}m`
    if (limit >= 1_000) return `${Math.round(limit / 1_000).toLocaleString()}k`
    return limit.toLocaleString()
  }

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 [&_[data-slot=list-search-input]]:!text-[13px] [&_[data-slot=list-header]]:!text-[11px] [&_[data-slot=list-header]]:!font-medium [&_[data-slot=list-item]]:focus-visible:!outline [&_[data-slot=list-item]]:focus-visible:!outline-1 [&_[data-slot=list-item]]:focus-visible:!outline-border-strong ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={
        props.onPick
          ? local.model
              .list()
              .find((model) => model.provider.id === props.current?.providerID && model.id === props.current?.modelID)
          : local.model.current()
      }
      filterKeys={["name", "id"]}
      groupBy={category}
      sortGroupsBy={(a, b) => modelGroupLabelRank(a.category) - modelGroupLabelRank(b.category)}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          forceMount={false}
          value={<ModelTooltip model={item} latest={item.latest} free={isFreeCost(item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        if (x && props.onPick) props.onPick({ modelID: x.id, providerID: x.provider.id })
        if (!props.onPick) {
          local.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
            recent: true,
          })
        }
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full min-w-0 flex items-center gap-x-3 text-13-regular">
          <span class="min-w-0 flex flex-1 flex-col text-left">
            <span class="truncate text-13-medium text-text-strong">{i.name}</span>
            <span class="flex items-center gap-1.5 truncate text-11-regular text-text-weak">
              <span>{i.capabilities.reasoning ? "reasoning" : "standard"}</span>
              <span aria-hidden="true">·</span>
              <span>{context(i.limit.context)} context</span>
            </span>
          </span>
          <span class="flex items-center gap-x-1 ml-auto shrink-0">
            <Tag>{displayProviderForModel(i.provider, i.id).name}</Tag>
            <Show when={isFreeCost(i.cost)}>
              <Tag>{language.t("model.tag.free")}</Tag>
            </Show>
            <Show when={i.latest}>
              <Tag>{language.t("model.tag.latest")}</Tag>
            </Show>
            <span
              role="button"
              tabindex="0"
              class="model-picker-sheet__pin"
              data-pinned={local.model.pin.has({ providerID: i.provider.id, modelID: i.id }) ? "true" : undefined}
              aria-pressed={local.model.pin.has({ providerID: i.provider.id, modelID: i.id })}
              aria-label={`${local.model.pin.has({ providerID: i.provider.id, modelID: i.id }) ? "Unpin" : "Pin"} ${i.name}`}
              title={
                local.model.pin.has({ providerID: i.provider.id, modelID: i.id })
                  ? "Remove from quick models"
                  : "Pin to quick models"
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const result = local.model.pin.toggle({ providerID: i.provider.id, modelID: i.id })
                if (result.limited) props.onPinLimit?.()
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                event.stopPropagation()
                const result = local.model.pin.toggle({ providerID: i.provider.id, modelID: i.id })
                if (result.limited) props.onPinLimit?.()
              }}
            >
              <Icon
                name={local.model.pin.has({ providerID: i.provider.id, modelID: i.id }) ? "pin-filled" : "pin"}
                size="small"
                aria-hidden="true"
              />
              <span>{local.model.pin.has({ providerID: i.provider.id, modelID: i.id }) ? "Pinned" : "Pin"}</span>
            </span>
          </span>
        </div>
      )}
    </List>
  )
}

export function ModelSelectorPopover<T extends ValidComponent = "div">(props: {
  provider?: string
  children?: JSX.Element
  triggerAs?: T
  triggerProps?: ComponentProps<T>
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: "escape" | "outside" | null
    trigger?: HTMLElement
    content?: HTMLElement
  }>({
    open: false,
    dismiss: null,
    trigger: undefined,
    content: undefined,
  })
  const dialog = useDialog()

  const handleManage = () => {
    setStore("open", false)
    dialog.show(() => <DialogSettings initial="models" />)
  }

  const language = useLanguage()

  createEffect(() => {
    if (!store.open) return

    const inside = (node: Node | null | undefined) => {
      if (!node) return false
      const el = store.content
      if (el && el.contains(node)) return true
      const anchor = store.trigger
      if (anchor && anchor.contains(node)) return true
      return false
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setStore("dismiss", "escape")
      setStore("open", false)
      event.preventDefault()
      event.stopPropagation()
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (inside(target)) return
      setStore("dismiss", "outside")
      setStore("open", false)
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!store.content) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (inside(target)) return
      setStore("dismiss", "outside")
      setStore("open", false)
    }

    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("focusin", onFocusIn, true)

    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("focusin", onFocusIn, true)
    })
  })

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={8}
    >
      <Kobalte.Trigger
        ref={(el) => setStore("trigger", el)}
        as={props.triggerAs ?? "div"}
        {...(props.triggerProps as any)}
      >
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          ref={(el) => setStore("content", el)}
          class="w-[min(390px,calc(100vw-24px))] h-[min(64vh,430px)] flex flex-col rounded-lg border border-border-strong bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            setStore("dismiss", "escape")
            setStore("open", false)
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => {
            setStore("dismiss", "outside")
            setStore("open", false)
          }}
          onFocusOutside={() => {
            setStore("dismiss", "outside")
            setStore("open", false)
          }}
          onCloseAutoFocus={(event) => {
            if (store.dismiss === "outside") event.preventDefault()
            setStore("dismiss", null)
          }}
        >
          <div class="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
            <div class="min-w-0">
              <Kobalte.Title class="text-13-medium text-text-strong">
                {language.t("dialog.model.select.title")}
              </Kobalte.Title>
              <p class="mt-0.5 text-11-regular text-text-weak">Choose the model for this research session.</p>
            </div>
            <span class="shrink-0 font-mono text-[10px] text-text-weak">↑↓ select · enter</span>
          </div>
          <ModelList
            provider={props.provider}
            onSelect={() => setStore("open", false)}
            class="px-1 pb-2"
            action={
              <Tooltip placement="top" forceMount={false} value={language.t("dialog.model.manage")}>
                <IconButton
                  icon="sliders"
                  variant="ghost"
                  iconSize="normal"
                  class="size-6"
                  aria-label={language.t("dialog.model.manage")}
                  onClick={handleManage}
                />
              </Tooltip>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{
  provider?: string
  current?: ModelKey | null
  onSelect?: (model: ModelKey) => void
  title?: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [notice, setNotice] = createSignal("Pin up to three models for the quick selector.")
  const manage = () => dialog.show(() => <DialogSettings initial="models" />)

  return (
    <Dialog title={props.title ?? language.t("dialog.model.select.title")} class="model-picker-sheet" transition>
      <div class="model-picker-sheet__intro">
        <p class="model-picker-sheet__pin-note" aria-live="polite">
          {notice()}
        </p>
      </div>
      <ModelList
        provider={props.provider}
        current={props.current}
        onPick={props.onSelect}
        onSelect={() => dialog.close()}
        onPinLimit={() => setNotice("Three models are already pinned. Unpin one before adding another.")}
        class="model-picker-sheet__list"
      />
      <Button variant="ghost" icon="sliders" class="model-picker-sheet__manage" onClick={manage}>
        <span class="model-picker-sheet__manage-copy">
          <strong>{language.t("dialog.model.manage")}</strong>
          <span>Open Customize for access and composer models</span>
        </span>
        <span class="model-picker-sheet__manage-arrow" aria-hidden="true">
          ›
        </span>
      </Button>
    </Dialog>
  )
}
