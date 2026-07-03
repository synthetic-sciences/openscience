import { createStore } from "solid-js/store"
import { batch, createMemo } from "solid-js"
import { createSimpleContext } from "@synsci/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { base64Encode } from "@synsci/util/encode"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"

export type ModelKey = { providerID: string; modelID: string }

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const providers = useProviders()

    function isModelValid(model: ModelKey) {
      const provider = providers.all().find((x) => x.id === model.providerID)
      return (
        !!provider?.models[model.modelID] &&
        providers
          .connected()
          .map((p) => p.id)
          .includes(model.providerID)
      )
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const RESEARCH_AGENTS = ["research"] as const
    const BIOLOGY_AGENTS = ["biology"] as const
    const ALL_CYCLABLE = ["research", "biology", "physics", "ml"] as const

    const agent = (() => {
      const list = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const all = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent"))
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
      const models = useModels()

      const [ephemeral, setEphemeral] = createStore<{
        model: Record<string, ModelKey | undefined>
      }>({
        model: {},
      })

      const fallbackModel = createMemo<ModelKey | undefined>(() => {
        if (sync.data.config.model) {
          const [providerID, modelID] = sync.data.config.model.split("/")
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of models.recent.list()) {
          if (isModelValid(item)) {
            return item
          }
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

      const current = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        const key = getFirstValidModel(
          () => ephemeral.model[a.name],
          () => a.model,
          fallbackModel,
        )
        if (!key) return undefined
        return models.find(key)
      })

      const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

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
        list: models.list,
        cycle,
        set(model: ModelKey | undefined, options?: { recent?: boolean }) {
          batch(() => {
            const currentAgent = agent.current()
            const next = model ?? fallbackModel()
            if (currentAgent) setEphemeral("model", currentAgent.name, next)
            if (model) models.setVisibility(model, true)
            if (options?.recent && model) models.recent.push(model)
          })
        },
        visible(model: ModelKey) {
          return models.visible(model)
        },
        setVisibility(model: ModelKey, visible: boolean) {
          models.setVisibility(model, visible)
        },
        variant: {
          current() {
            const m = current()
            if (!m) return undefined
            return models.variant.get({ providerID: m.provider.id, modelID: m.id })
          },
          list() {
            const m = current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            models.variant.set({ providerID: m.provider.id, modelID: m.id }, value)
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const currentVariant = this.current()
            if (!currentVariant) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(currentVariant)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })()

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
      research,
      biology,
    }
    return result
  },
})
