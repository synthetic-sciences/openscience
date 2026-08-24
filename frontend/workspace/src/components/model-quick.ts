import { COMPOSER_MODEL_ROSTER, logicalModelKey } from "@/context/model-catalog"

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
  available: readonly T[]
  limit?: number
}

type QuickModelRowOptions = {
  pinned?: readonly string[]
  hidden?: ReadonlySet<string>
}

export type QuickModelRow<T extends { key: string }> =
  | { kind: "choice"; key: string; choice: T }
  | { kind: "unavailable"; key: string; model: (typeof COMPOSER_MODEL_ROSTER)[number] }

/**
 * Produces the root picker's source order. Pinned choices lead, followed by
 * visible roster entries and passive placeholders for genuinely disconnected
 * roster models. Hidden connected entries are omitted. The rendered DOM can
 * use this list directly instead of relying on CSS `order`, which would
 * disagree with keyboard and accessibility traversal.
 */
export function curateQuickModelRows<T extends { key: string }>(
  choices: readonly T[],
  options: QuickModelRowOptions = {},
): QuickModelRow<T>[] {
  const byKey = new Map(choices.map((choice) => [choice.key, choice]))
  const rosterKeys = new Set<string>(COMPOSER_MODEL_ROSTER.map((model) => model.key))
  const added = new Set<string>()
  const rows: QuickModelRow<T>[] = []
  const addChoice = (key: string) => {
    const choice = byKey.get(key)
    if (!choice || added.has(key)) return
    rows.push({ kind: "choice", key, choice })
    added.add(key)
  }

  for (const key of options.pinned ?? []) addChoice(key)

  for (const model of COMPOSER_MODEL_ROSTER) {
    if (added.has(model.key)) continue
    const choice = byKey.get(model.key)
    if (choice) {
      rows.push({ kind: "choice", key: model.key, choice })
      added.add(model.key)
      continue
    }
    if (options.hidden?.has(model.key)) continue
    rows.push({ kind: "unavailable", key: model.key, model })
    added.add(model.key)
  }

  for (const choice of choices) {
    if (rosterKeys.has(choice.key) || added.has(choice.key)) continue
    rows.push({ kind: "choice", key: choice.key, choice })
    added.add(choice.key)
  }
  return rows
}

/**
 * Builds the root composer menu without leaking the broader release catalog
 * into it. Pins lead the suggested roster and the explicit current exception
 * remains reachable when it is visible; no provider or callable model is
 * invented by the client.
 */
export function curateQuickModels<T extends QuickModel>(input: QuickModelInput<T>) {
  const limit = input.limit ?? Number.POSITIVE_INFINITY
  const selected: T[] = []
  const keys = new Set<string>()
  const key = (model: T) => logicalModelKey(model.provider.id, model.id)
  const add = (model: T) => {
    const id = key(model)
    if (keys.has(id)) return false
    selected.push(model)
    keys.add(id)
    return true
  }

  const roster = new Map<string, number>(COMPOSER_MODEL_ROSTER.map((model, index) => [model.key, index]))
  const curated = input.available
    .filter((model) => roster.has(key(model)))
    .slice()
    .sort(
      (left, right) =>
        (roster.get(key(left)) ?? Number.MAX_SAFE_INTEGER) - (roster.get(key(right)) ?? Number.MAX_SAFE_INTEGER),
    )
  for (const model of input.pinned) add(model)
  for (const model of curated) add(model)
  if (input.current) add(input.current)
  return selected.slice(0, limit)
}
