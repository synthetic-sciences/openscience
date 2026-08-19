import { SettingsApiError } from "./api"

export const isOpenScienceOllamaAlias = (model: string) => /^openscience\/.+-ctx-\d+(?::latest)?$/i.test(model)

export const selectableLocalModels = (models: string[]) => models.filter((model) => !isOpenScienceOllamaAlias(model))

export async function prepareOllamaModels(models: string[], tune: (model: string) => Promise<string>) {
  const first = models[0]
  if (!first) return { models: [], aliases: {}, tuned: true }
  const initial = await tune(first).catch((error) => {
    if (error instanceof SettingsApiError && (error.status === 404 || error.code === "not_found")) return undefined
    throw error
  })
  if (!initial) return { models, aliases: {}, tuned: false }
  const rest = await Promise.all(models.slice(1).map(tune))
  return {
    models,
    aliases: Object.fromEntries(models.map((model, index) => [model, [initial, ...rest][index]!])),
    tuned: true,
  }
}
