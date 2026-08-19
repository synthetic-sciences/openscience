import { SettingsApiError } from "./api"

export async function prepareOllamaModels(models: string[], tune: (model: string) => Promise<string>) {
  const first = models[0]
  if (!first) return { models: [], tuned: true }
  const initial = await tune(first).catch((error) => {
    if (error instanceof SettingsApiError && (error.status === 404 || error.code === "not_found")) return undefined
    throw error
  })
  if (!initial) return { models, tuned: false }
  const rest = await Promise.all(models.slice(1).map(tune))
  return { models: [initial, ...rest], tuned: true }
}
