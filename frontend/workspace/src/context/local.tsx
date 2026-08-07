import { createStore } from "solid-js/store"
import { batch, createMemo } from "solid-js"
import { createSimpleContext } from "@synsci/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { foldedRouteMode, routableModelKey } from "@/context/model-catalog"
import { modelTierOptions, normalizedTier, promptTier, resolvedTier } from "@/context/model-tier"
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

    const RESEARCH_AGENTS = ["research"] as const
    const BIOLOGY_AGENTS = ["biology"] as const
    const ALL_CYCLABLE = ["research", "biology", "physics", "ml"] as const

    const agent = (() => {
      // Planning is adaptive in the research agent, so the legacy read-only
      // plan agent is not exposed as a picker entry.
      const agents = () => (Array.isArray(sync.data.agent) ? sync.data.agent : [])
      const list = createMemo(() => agents().filter((x) => x.mode !== "subagent" && !x.hidden && x.name !== "plan"), [])
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

    const research = (() => {
      let previousAgent: string | undefined
      return {
        current() {
          const name = agent.current()?.name
          if (name && RESEARCH_AGENTS.includes(name as any)) return name as (typeof RESEARCH_AGENTS)[number]
          return undefined
        },
        list() {
          return RESEARCH_AGENTS.filter((name) => agent.all().some((a) => a.name === name))
        },
        cycle() {
          if (biology.current()) {
            biology.cycle()
            return
          }
          const levels = this.list()
          if (levels.length === 0) return
          const current = this.current()
          if (!current) {
            previousAgent = agent.current()?.name
            agent.set(levels[0])
            return
          }
          const index = levels.indexOf(current)
          if (index === -1 || index === levels.length - 1) {
            const restore = previousAgent && !ALL_CYCLABLE.includes(previousAgent as any) ? previousAgent : "research"
            previousAgent = undefined
            agent.set(restore)
            return
          }
          agent.set(levels[index + 1])
        },
      }
    })()

    const biology = (() => {
      let previousAgent: string | undefined
      return {
        current() {
          const name = agent.current()?.name
          if (name && BIOLOGY_AGENTS.includes(name as any)) return name as (typeof BIOLOGY_AGENTS)[number]
          return undefined
        },
        list() {
          return BIOLOGY_AGENTS.filter((name) => agent.all().some((a) => a.name === name))
        },
        cycle() {
          const levels = this.list()
          if (levels.length === 0) return
          const current = this.current()
          if (!current) {
            previousAgent = agent.current()?.name
            agent.set(levels[0])
            return
          }
          const index = levels.indexOf(current)
          if (index === -1 || index === levels.length - 1) {
            const restore = previousAgent && !ALL_CYCLABLE.includes(previousAgent as any) ? previousAgent : "research"
            previousAgent = undefined
            agent.set(restore)
            return
          }
          agent.set(levels[index + 1])
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
          const resolved = resolveModel({ providerID, modelID })
          if (resolved) return resolved
        }

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
        return getFirstValidModel(
          () => ephemeral.model[a.name],
          () => a.model,
          fallbackModel,
        )
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
            const selected = model ? (resolveModel(model) ?? model) : undefined
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
      }
    })()

    const result = {
      slug: createMemo(() => sdk.scope),
      model,
      agent,
      research,
      biology,
    }
    return result
  },
})
