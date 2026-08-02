import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "../global"

// Reviewer preferences. Manual review is always available; `auto` opts into
// kicking off a reviewer pass automatically after a significant result (a
// durable artifact save). Persisted like the other settings stores.
export namespace ReviewSettings {
  export const Model = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })
  export const State = z.object({
    auto: z.boolean(),
    model: Model.nullable().default(null),
  })
  export type State = z.infer<typeof State>

  const file = path.join(Global.Path.data, "settings", "review.json")

  function fallback(): State {
    return { auto: false, model: null }
  }

  export async function get(): Promise<State> {
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (!text) return fallback()
    try {
      const parsed = State.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
    } catch {}
    return fallback()
  }

  export async function set(state: State): Promise<State> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify(state, null, 2))
    return state
  }
}
