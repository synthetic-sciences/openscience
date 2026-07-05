import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@synsci/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    // "latest" = the newest model per (provider, family), decided by release_date
    // rather than a catalog "(latest)" name string. That string goes stale the
    // moment a newer model ships — e.g. Opus 4.8 lands but 4.5 keeps the tag — so
    // it mislabelled superseded models as latest across every provider.
    const list = createMemo(() => {
      const items = available()
      const newestByFamily = new Map<string, string>()
      for (const m of items) {
        const family = m.family?.trim()
        const released = m.release_date?.trim()
        if (!family || !released) continue
        const key = `${m.provider.id}:${family}`
        const current = newestByFamily.get(key)
        if (!current || released > current) newestByFamily.set(key, released)
      }
      return items.map((m) => {
        const family = m.family?.trim()
        const released = m.release_date?.trim()
        const latest = !!family && !!released && newestByFamily.get(`${m.provider.id}:${family}`) === released
        return {
          ...m,
          name: m.name.replace("(latest)", "").trim(),
          latest,
        }
      })
    })

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, { visibility: state })
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = `${model.providerID}:${model.modelID}`
      const state = visibility().get(key)
      if (state === "hide") return false
      // Default to visible: any available model surfaces in the picker
      // unless the user has explicitly hidden it. The picker is grouped
      // by provider and scrolls, so a long list is fine — having useful
      // dated/legacy models silently filtered out was the worse failure
      // mode.
      return true
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => x.providerID + x.modelID)
      if (uniq.length > 5) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
