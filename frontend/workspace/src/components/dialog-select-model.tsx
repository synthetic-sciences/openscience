import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createEffect, createMemo, JSX, onCleanup, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@synsci/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@synsci/ui/button"
import { IconButton } from "@synsci/ui/icon-button"
import { Tag } from "@synsci/ui/tag"
import { Dialog } from "@synsci/ui/dialog"
import { List } from "@synsci/ui/list"
import { Tooltip } from "@synsci/ui/tooltip"
import { DialogManageModels } from "./dialog-manage-models"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { isFreeCost, pricingLines } from "@/utils/model-cost"

// ── Reasoning-effort variants ────────────────────────────────────────────────
// models.dev exposes optional per-model `variants` (low/medium/high/…) that map
// to provider reasoning-effort options. Surface them inline so an open-weight
// reasoning model reads the same as a proprietary one.
const VARIANT_LABEL: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
}

type VariantModel = { variants?: Record<string, { disabled?: boolean } | undefined> }

function variantKeys(model: VariantModel): string[] {
  const v = model.variants
  if (!v) return []
  return Object.keys(v).filter((k) => !v[k]?.disabled)
}

function variantHint(model: VariantModel): string | undefined {
  const keys = variantKeys(model)
  if (keys.length === 0) return undefined
  return keys.map((k) => VARIANT_LABEL[k] ?? k).join(" · ")
}

// ── Credential source badge ──────────────────────────────────────────────────
// Honest, provider-derived source for the composer's model rows. BYOK is the
// first-class path for the OSS client, so anything with a raw key reads "Key".
const SIGNED_IN = new Set(["github-copilot"])

function sourceBadge(providerID: string): { label: string; tone: "managed" | "signin" | "byok" } {
  if (providerID === "synsci") return { label: "Managed", tone: "managed" }
  if (SIGNED_IN.has(providerID)) return { label: "Sign-in", tone: "signin" }
  return { label: "Key", tone: "byok" }
}

const SOURCE_CLASS: Record<"managed" | "signin" | "byok", string> = {
  managed: "text-text-strong",
  signin: "text-text-weak",
  byok: "text-text-weaker",
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
}> = (props) => {
  const local = useLocal()
  const language = useLanguage()

  const models = createMemo(() =>
    local.model
      .list()
      .filter((m) => local.model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={local.model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
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
        local.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => {
        const free = isFreeCost(i.cost)
        const price = pricingLines(i.cost)
        const source = sourceBadge(i.provider.id)
        const hint = variantHint(i as unknown as VariantModel)
        return (
          <div class="w-full flex items-center gap-3 py-0.5">
            <div class="flex flex-col min-w-0 gap-0.5">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="truncate text-13-regular text-text-strong">{i.name}</span>
                <Show when={i.latest}>
                  <Tag>{language.t("model.tag.latest")}</Tag>
                </Show>
              </div>
              <div class="flex items-center gap-1.5 text-11-regular text-text-weaker min-w-0">
                <span class={`shrink-0 ${SOURCE_CLASS[source.tone]}`}>{source.label}</span>
                <Show when={hint}>
                  <span class="shrink-0 text-text-weaker/70">·</span>
                  <span class="truncate">{hint}</span>
                </Show>
              </div>
            </div>
            <span class="ml-auto shrink-0 flex items-center pl-2">
              <Show when={!free} fallback={<Tag>{language.t("model.tag.free")}</Tag>}>
                <span class="text-11-regular text-text-weaker tabular-nums">
                  {language.t("model.tag.pricing", {
                    input: price.input!,
                    output: price.output!,
                  })}
                </span>
              </Show>
            </span>
          </div>
        )
      }}
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
    dialog.show(() => <DialogManageModels />)
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
          class="w-[360px] h-[min(70vh,440px)] flex flex-col p-1.5 rounded-lg border border-border-weak-base bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden"
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
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            onSelect={() => setStore("open", false)}
            class="p-0.5"
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

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.model.select.title")}>
      <div class="flex flex-col h-[min(68vh,540px)] min-h-0">
        <ModelList provider={props.provider} onSelect={() => dialog.close()} class="px-1" />
        <Button
          variant="ghost"
          class="mt-3 mb-1 ml-1 text-text-base self-start"
          onClick={() => dialog.show(() => <DialogManageModels />)}
        >
          {language.t("dialog.model.manage")}
        </Button>
      </div>
    </Dialog>
  )
}
