import { displayProviderForModel, logicalModelKey } from "@/context/model-catalog"

type QuickModel = {
  id: string
  name: string
  provider: { id: string; name: string }
  latest?: boolean
  release_date?: string
  capabilities: { reasoning: boolean }
  limit: { context: number }
}

type QuickModelInput<T extends QuickModel> = {
  pinned: readonly T[]
  current?: T
  recent: readonly T[]
  available: readonly T[]
  limit?: number
}

/**
 * Builds a small composer menu from models that are actually available.
 * Explicit pins and the current model stay first; the remaining slots favor
 * recent, current-generation reasoning models while keeping provider labs
 * diverse. No provider or model is invented by the client.
 */
export function curateQuickModels<T extends QuickModel>(input: QuickModelInput<T>) {
  const limit = input.limit ?? 4
  const selected: T[] = []
  const keys = new Set<string>()
  const labs = new Set<string>()
  const recency = new Map(input.recent.map((model, index) => [logicalModelKey(model.provider.id, model.id), index]))
  const key = (model: T) => logicalModelKey(model.provider.id, model.id)
  const lab = (model: T) => displayProviderForModel(model.provider, model.id).id
  const add = (model: T) => {
    const id = key(model)
    if (keys.has(id) || selected.length >= limit) return false
    selected.push(model)
    keys.add(id)
    labs.add(lab(model))
    return true
  }

  for (const model of input.pinned) add(model)
  if (input.current) add(input.current)
  if (selected.length >= limit) return selected

  const candidates = input.available
    .filter((model) => !keys.has(key(model)))
    .slice()
    .sort((left, right) => {
      const leftRecent = recency.has(key(left)) ? input.recent.length - (recency.get(key(left)) ?? 0) : 0
      const rightRecent = recency.has(key(right)) ? input.recent.length - (recency.get(key(right)) ?? 0) : 0
      return (
        rightRecent - leftRecent ||
        Number(Boolean(right.latest)) - Number(Boolean(left.latest)) ||
        (right.release_date ?? "").localeCompare(left.release_date ?? "") ||
        Number(right.capabilities.reasoning) - Number(left.capabilities.reasoning) ||
        right.limit.context - left.limit.context ||
        left.name.localeCompare(right.name)
      )
    })

  for (const model of candidates) {
    if (labs.has(lab(model))) continue
    add(model)
  }
  for (const model of candidates) add(model)
  return selected
}
