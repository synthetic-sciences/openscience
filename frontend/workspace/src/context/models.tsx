import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@synsci/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import {
  isChatModel,
  isFrontier,
  logicalModelKey,
  preferredModel,
  preferredModels,
  type ModelKey,
} from "./model-catalog"

export { canonicalKey, FRONTIER_MODELS, type ModelKey } from "./model-catalog"

export const RECOMMENDED_MODELS: ModelKey[] = [
  { providerID: "openai", modelID: "gpt-5.6-sol" },
  { providerID: "anthropic", modelID: "claude-opus-5" },
  { providerID: "moonshotai", modelID: "kimi-k3" },
]

export const DEFAULT_PINNED_MODELS: ModelKey[] = []

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  pinned?: ModelKey[]
  variant?: Record<string, string | undefined>
  tier?: Record<string, string | undefined>
}

export const togglePinned = (current: ModelKey[], model: ModelKey) => {
  const models = uniqueBy(current, (item) => logicalModelKey(item.providerID, item.modelID)).slice(0, 3)
  const key = logicalModelKey(model.providerID, model.modelID)
  const pinned = models.some((item) => logicalModelKey(item.providerID, item.modelID) === key)
  if (pinned) {
    return {
      models: models.filter((item) => logicalModelKey(item.providerID, item.modelID) !== key),
      pinned: false,
      limited: false,
    }
  }
  if (models.length >= 3) return { models, pinned: false, limited: true }
  return { models: [...models, model], pinned: true, limited: false }
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
        pinned: [],
        variant: {},
        tier: {},
      }),
    )

    const available = createMemo(() =>
      preferredModels(
        providers.connected().flatMap((p) =>
          Object.values(p.models)
            .map((m) => ({
              ...m,
              provider: p,
            }))
            .filter(isChatModel),
        ),
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

    const find = (key: ModelKey) => preferredModel(list(), key)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, { visibility: state })
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    // Are any of the connected providers exposing a frontier model at all? If
    // not (e.g. a lone local model, or a BYOK key with no frontier tier), the
    // frontier-only default would empty the picker — so fall back to show-all.
    const frontierAvailable = createMemo(() =>
      available().some((m) => isFrontier({ providerID: m.provider.id, modelID: m.id })),
    )

    const visible = (model: ModelKey) => {
      const key = `${model.providerID}:${model.modelID}`
      const state = visibility().get(key)
      // Explicit user choice always wins (set via Manage Models, or implicitly
      // when a model is selected — see local.set()).
      if (state === "hide") return false
      if (state === "show") return true
      // Default: only the curated frontier set surfaces in the picker. The full
      // catalog stays one click away in Manage Models. If no frontier model is
      // connected, show everything so the picker is never empty.
      if (!frontierAvailable()) return true
      return isFrontier(model)
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => x.providerID + x.modelID)
      if (uniq.length > 5) uniq.pop()
      setStore("recent", uniq)
    }

    // New installations start unpinned. The composer derives its suggested set
    // from available models, so pinning is always an explicit user choice.
    const pinned = createMemo(() =>
      uniqueBy(store.pinned ?? [], (item) => logicalModelKey(item.providerID, item.modelID)).slice(0, 3),
    )
    const isPinned = (model: ModelKey) => {
      const key = logicalModelKey(model.providerID, model.modelID)
      return pinned().some((item) => logicalModelKey(item.providerID, item.modelID) === key)
    }
    const togglePin = (model: ModelKey) => {
      const result = togglePinned(pinned(), model)
      if (!result.limited) setStore("pinned", result.models)
      return { pinned: result.pinned, limited: result.limited }
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

    const getTier = (model: ModelKey) => store.tier?.[variantKey(model)]

    const setTier = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.tier) {
        setStore("tier", { [key]: value })
        return
      }
      setStore("tier", key, value)
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
      pinned: {
        list: pinned,
        has: isPinned,
        toggle: togglePin,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
      tier: {
        get: getTier,
        set: setTier,
      },
    }
  },
})
