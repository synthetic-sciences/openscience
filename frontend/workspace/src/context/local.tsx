import { createStore } from "solid-js/store"
import { batch, createMemo } from "solid-js"
import { createSimpleContext } from "@synsci/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { foldedRouteMode, routableModelKey } from "@/context/model-catalog"
import { modelTierOptions, normalizedTier, promptTier, resolvedTier } from "@/context/model-tier"
import { resolveModelAccessRoute, type ModelAccessRoute, type ModelRouteAccess } from "@/context/model-route-resolution"
import { modelVariantOptions, normalizedVariant, promptVariant } from "@/context/model-variant"

export type ModelKey = { providerID: string; modelID: string }

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const providers = useProviders()
    const models = useModels()

    function isExactModelValid(model: ModelKey) {
      const provider = providers.all().find((x) => x.id === model.providerID)
      return (
        !!provider?.models[model.modelID] &&
        providers
          .connected()
          .map((p) => p.id)
          .includes(model.providerID)
      )
    }

    function resolveModel(model: ModelKey) {
      const routed = routableModelKey(model, isExactModelValid)
      if (isExactModelValid(routed)) return routed
    }

    function isModelValid(model: ModelKey) {
      return !!resolveModel(model)
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        const resolved = resolveModel(model)
        if (resolved) return resolved
      }
    }

    const agent = (() => {
      // Planning is adaptive in the research agent, so the legacy read-only
      // plan agent is not exposed as a picker entry.
      const agents = () => (Array.isArray(sync.data.agent) ? sync.data.agent : [])
      const list = createMemo(() => agents().filter((x) => x.name === "research"), [])
      const all = createMemo(() => agents().filter((x) => x.mode !== "subagent"), [])
      const [store, setStore] = createStore<{
        current?: string
      }>({
        current: list()[0]?.name,
      })
      return {
        list,
        all,
        current() {
          const allAgents = all()
          const visible = list()
          if (allAgents.length === 0) return undefined
          return allAgents.find((x) => x.name === store.current) ?? visible[0]
        },
        set(name: string | undefined) {
          const allAgents = all()
          const visible = list()
          if (allAgents.length === 0) {
            setStore("current", undefined)
            return
          }
          if (name && allAgents.some((x) => x.name === name)) {
            setStore("current", name)
            return
          }
          setStore("current", visible[0]?.name)
        },
        move(direction: 1 | -1) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          let next = available.findIndex((x) => x.name === store.current) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("current", value.name)
          if (value.model)
            model.set({
              providerID: value.model.providerID,
              modelID: value.model.modelID,
            })
        },
      }
    })()

    const model = (() => {
      const [ephemeral, setEphemeral] = createStore<{
        model: Record<string, ModelKey | undefined>
      }>({
        model: {},
      })

      const fallbackModel = createMemo<ModelKey | undefined>(() => {
        if (sync.data.config.model) {
          const [providerID, ...parts] = sync.data.config.model.split("/")
          const modelID = parts.join("/")
          const configured = { providerID, modelID }
          // Settings owns the exact default route. Never silently replace it
          // with a managed/native route for the same logical model.
          return isExactModelValid(configured) ? configured : undefined
        }

        // Resolve one connected Sol route without treating provider identities
        // as interchangeable. Automatic prefers ChatGPT (and therefore its
        // advertised Fast tier), while explicit Credits and Accounts remain on
        // the access surface the user selected.
        const connected = new Map(providers.connected().map((provider) => [provider.id, provider]))
        const candidates = [
          { providerID: "openai", modelID: "gpt-5.6-sol" },
          { providerID: "openai-codex", modelID: "gpt-5.6-sol" },
          { providerID: "openrouter", modelID: "openai/gpt-5.6-sol" },
        ].flatMap((route): ModelAccessRoute[] => {
          const provider = connected.get(route.providerID)
          if (!provider?.models[route.modelID]) return []
          const access: ModelRouteAccess =
            provider.id === "openai-codex"
              ? "chatgpt"
              : provider.source === "managed" || provider.id.startsWith("synsci")
                ? "managed"
                : "byok"
          return [{ ...route, access }]
        })
        const initial = resolveModelAccessRoute({
          routes: candidates,
          billing: sync.data.config.billing?.llm,
        })
        if (initial) return initial

        for (const item of models.recent.list()) {
          const resolved = resolveModel(item)
          if (resolved) return resolved
        }

        const defaults = providers.default()
        for (const p of providers.connected()) {
          const configured = defaults[p.id]
          if (configured) {
            const key = { providerID: p.id, modelID: configured }
            if (isModelValid(key)) return key
          }

          const first = Object.values(p.models)[0]
          if (!first) continue
          const key = { providerID: p.id, modelID: first.id }
          if (isModelValid(key)) return key
        }

        return undefined
      })

      const selected = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        const explicit = ephemeral.model[a.name]
        // A composer selection is an exact provider contract, even if a
        // provider refresh temporarily makes that route unavailable.
        if (explicit) return isExactModelValid(explicit) ? explicit : undefined
        return getFirstValidModel(() => a.model, fallbackModel)
      })

      const current = createMemo(() => {
        const key = selected()
        if (!key) return undefined
        return models.find(key)
      })

      const recent = createMemo(() =>
        models.recent
          .list()
          .map((item) => models.find(resolveModel(item) ?? item))
          .filter(Boolean),
      )

      const pinned = createMemo(() =>
        models.pinned
          .list()
          .map((item) => models.find(resolveModel(item) ?? item))
          .filter(Boolean),
      )

      const cycle = (direction: 1 | -1) => {
        const recentList = recent()
        const currentModel = current()
        if (!currentModel) return

        const index = recentList.findIndex(
          (x) => x?.provider.id === currentModel.provider.id && x?.id === currentModel.id,
        )
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = recentList.length - 1
        if (next >= recentList.length) next = 0

        const val = recentList[next]
        if (!val) return

        model.set({
          providerID: val.provider.id,
          modelID: val.id,
        })
      }

      return {
        ready: models.ready,
        current,
        recent,
        pinned,
        list: models.list,
        cycle,
        set(model: ModelKey | undefined, options?: { recent?: boolean }) {
          batch(() => {
            const currentAgent = agent.current()
            const selected = model
            const next = selected ?? fallbackModel()
            if (currentAgent) setEphemeral("model", currentAgent.name, next)
            if (selected) models.setVisibility(selected, true)
            if (options?.recent && selected) models.recent.push(selected)
          })
        },
        visible(model: ModelKey) {
          return models.visible(model)
        },
        setVisibility(model: ModelKey, visible: boolean) {
          models.setVisibility(model, visible)
        },
        pin: {
          has(model: ModelKey) {
            return models.pinned.has(resolveModel(model) ?? model)
          },
          toggle(model: ModelKey) {
            const selected = resolveModel(model) ?? model
            models.setVisibility(selected, true)
            return models.pinned.toggle(selected)
          },
        },
        variant: {
          current() {
            const m = current()
            if (!m) return "standard"
            return normalizedVariant(
              models.variant.get({ providerID: m.provider.id, modelID: m.id }),
              Object.keys(m.variants ?? {}),
            )
          },
          list() {
            const m = current()
            if (!m) return []
            return modelVariantOptions(Object.keys(m.variants ?? {}))
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            const variants = Object.keys(m.variants ?? {})
            models.variant.set({ providerID: m.provider.id, modelID: m.id }, promptVariant(value, variants))
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const index = variants.indexOf(this.current())
            this.set(variants[index === -1 || index === variants.length - 1 ? 0 : index + 1])
          },
          prompt() {
            const m = current()
            if (!m) return undefined
            return promptVariant(this.current(), Object.keys(m.variants ?? {}))
          },
        },
        tier: {
          current() {
            const m = current()
            if (!m) return "standard"
            const saved = models.tier.get({ providerID: m.provider.id, modelID: m.id })
            const legacy = selected()
            const migrated = legacy ? foldedRouteMode(legacy, m) : undefined
            return resolvedTier(saved, Object.keys(m.modes ?? {}), migrated)
          },
          list() {
            const m = current()
            if (!m) return []
            return modelTierOptions(Object.keys(m.modes ?? {})).map((option) => option.id)
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            const modes = Object.keys(m.modes ?? {})
            models.tier.set({ providerID: m.provider.id, modelID: m.id }, normalizedTier(value, modes))
          },
          cycle() {
            const tiers = this.list()
            if (tiers.length <= 1) return
            const index = tiers.indexOf(this.current())
            this.set(tiers[index === -1 || index === tiers.length - 1 ? 0 : index + 1])
          },
          prompt() {
            const m = current()
            if (!m) return undefined
            return promptTier(this.current(), Object.keys(m.modes ?? {}))
          },
        },
        context: {
          list() {
            const m = current()
            if (!m) return []
            const thresholds = (m.cost.tiers ?? []).map((tier) => tier.threshold)
            const defaults = m.limit.context > 272_000 ? [272_000] : []
            return [...new Set([...thresholds, ...defaults, m.limit.context])]
              .filter((value) => value > 0 && value <= m.limit.context)
              .sort((a, b) => a - b)
          },
          current() {
            const m = current()
            if (!m) return 0
            const value = models.context.get({ providerID: m.provider.id, modelID: m.id })
            return value && this.list().includes(value) ? value : m.limit.context
          },
          set(value: number | undefined) {
            const m = current()
            if (!m) return
            const selected = value && this.list().includes(value) && value < m.limit.context ? value : undefined
            models.context.set({ providerID: m.provider.id, modelID: m.id }, selected)
          },
          prompt() {
            const m = current()
            if (!m) return undefined
            const value = this.current()
            return value < m.limit.context ? value : undefined
          },
        },
      }
    })()

    const result = {
      slug: createMemo(() => sdk.scope),
      model,
      agent,
    }
    return result
  },
})
