import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@synsci/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

// The curated "frontier" set shown in the model picker by default. Everything
// else stays in the catalog and is one click away in Manage Models, but the
// default toggle is just these. Matched by canonicalKey() so a BYOK-native id
// and the managed OpenRouter "vendor/model" slug for the same model collapse to
// one entry (folds dots<->dashes and the z-ai/zai/zhipuai alias).
//
// NOTE: two requested entries don't exist in the live catalog yet — they're
// kept here so they light up the moment they ship: `openai/gpt-5-5-mini` (the
// 5.5 tier currently ships only gpt-5.5 + gpt-5.5-pro) and kimi-k2.7 (only the
// coding flagship `kimi-k2.7-code` exists, which is what's listed below).
export const FRONTIER_MODELS = new Set([
  "openai/gpt-5-5", // gpt-5.5
  "openai/gpt-5-5-mini", // gpt-5.5-mini (not shipped yet)
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4-8", // native dashes == OpenRouter anthropic/claude-opus-4.8
  "anthropic/claude-fable-5",
  "zai/glm-5-2", // native zai/zhipuai, OpenRouter z-ai/glm-5.2
  "moonshotai/kimi-k2-7-code", // "kimi k2.7" -> the only k2.7 flagship that exists
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
])

/** Stable key that matches a native id AND an OpenRouter vendor/model slug for
 *  the same model: strips the OpenRouter "~" alias marker, folds the GLM vendor
 *  aliases, lowercases, and normalizes dots to dashes. */
export function canonicalKey(providerID: string, modelID: string): string {
  let vendor = providerID
  let base = modelID
  const slash = modelID.lastIndexOf("/")
  if (slash >= 0) {
    vendor = modelID.slice(0, slash)
    base = modelID.slice(slash + 1)
  }
  vendor = vendor.replace(/^~/, "").toLowerCase()
  if (vendor === "z-ai" || vendor === "zhipuai") vendor = "zai"
  base = base.replace(/^~/, "").toLowerCase().replace(/\./g, "-")
  return `${vendor}/${base}`
}

const isFrontier = (model: ModelKey) => FRONTIER_MODELS.has(canonicalKey(model.providerID, model.modelID))

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
