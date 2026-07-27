import { Dialog } from "@synsci/ui/dialog"
import { List } from "@synsci/ui/list"
import { Switch } from "@synsci/ui/switch"
import type { Component } from "solid-js"
import { useLocal } from "@/context/local"
import { displayProviderForModel } from "@/context/model-catalog"
import { popularProviders } from "@/hooks/use-providers"
import { useLanguage } from "@/context/language"

export const DialogManageModels: Component = () => {
  const local = useLocal()
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.model.manage")} description={language.t("dialog.model.manage.description")}>
      <List
        search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.model.empty")}
        key={(x) => `${x?.provider?.id}:${x?.id}`}
        items={local.model.list()}
        filterKeys={["provider.name", "name", "id"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => displayProviderForModel(x.provider, x.id).name}
        sortGroupsBy={(a, b) => {
          const aProvider = displayProviderForModel(a.items[0].provider, a.items[0].id).id
          const bProvider = displayProviderForModel(b.items[0].provider, b.items[0].id).id
          if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
          if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
          return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
        }}
        onSelect={(x) => {
          if (!x) return
          const visible = local.model.visible({
            modelID: x.id,
            providerID: x.provider.id,
          })
          local.model.setVisibility({ modelID: x.id, providerID: x.provider.id }, !visible)
        }}
      >
        {(i) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <span>{i.name}</span>
            <div onClick={(e) => e.stopPropagation()}>
              <Switch
                checked={
                  !!local.model.visible({
                    modelID: i.id,
                    providerID: i.provider.id,
                  })
                }
                onChange={(checked) => {
                  local.model.setVisibility({ modelID: i.id, providerID: i.provider.id }, checked)
                }}
              />
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
