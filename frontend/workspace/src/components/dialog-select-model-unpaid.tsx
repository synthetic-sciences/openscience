import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { List, type ListRef } from "@synsci/ui/list"
import { Tag } from "@synsci/ui/tag"
import { Tooltip } from "@synsci/ui/tooltip"
import { type Component, createMemo, onCleanup, onMount, Show } from "solid-js"
import { useLocal } from "@/context/local"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { isFreeCost } from "@/utils/model-cost"

export const DialogSelectModelUnpaid: Component = () => {
  const local = useLocal()
  const dialog = useDialog()
  const language = useLanguage()

  // Genuinely free ($0 in + $0 out) models across every connected provider —
  // OpenRouter `:free`, local/Ollama, and any zero-cost model. No brand gating.
  const freeModels = createMemo(() => local.model.list().filter((m) => isFreeCost(m.cost)))

  let listRef: ListRef | undefined
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  onMount(() => {
    document.addEventListener("keydown", handleKey)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKey)
    })
  })

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="overflow-y-auto [&_[data-slot=dialog-body]]:overflow-visible [&_[data-slot=dialog-body]]:flex-none"
    >
      <div class="flex flex-col gap-3 px-2.5">
        <div class="text-14-medium text-text-base px-2.5">{language.t("dialog.model.unpaid.freeModels.title")}</div>
        <Show
          when={freeModels().length > 0}
          fallback={
            <div class="text-12-regular text-text-weaker px-2.5">{language.t("dialog.model.unpaid.empty")}</div>
          }
        >
          <List
            class="[&_[data-slot=list-scroll]]:overflow-visible"
            ref={(ref) => (listRef = ref)}
            items={freeModels}
            current={local.model.current()}
            key={(x) => `${x.provider.id}:${x.id}`}
            itemWrapper={(item, node) => (
              <Tooltip
                class="w-full"
                placement="right-start"
                gutter={12}
                value={<ModelTooltip model={item} latest={item.latest} free={isFreeCost(item.cost)} />}
              >
                {node}
              </Tooltip>
            )}
            onSelect={(x) => {
              local.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
                recent: true,
              })
              dialog.close()
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-2 text-13-regular">
                <span class="truncate min-w-0">{i.name}</span>
                <Show when={i.latest}>
                  <Tag>{language.t("model.tag.latest")}</Tag>
                </Show>
                <span class="ml-auto shrink-0 pl-2">
                  <Tag>{language.t("model.tag.free")}</Tag>
                </span>
              </div>
            )}
          </List>
        </Show>
      </div>
    </Dialog>
  )
}
