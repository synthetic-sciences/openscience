import path from "path"
import fs from "fs/promises"
import crypto from "crypto"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

// Persistent, user-authored memory: standing notes/instructions grouped into
// categories that get injected into agent context on every turn (when enabled).
// Two scopes: "global" (all projects) and "project" (the current directory).
// Backed by a plain JSON document per scope under ~/.openscience data dir.
export namespace Memory {
  const log = Log.create({ service: "settings.memory" })

  export const Note = z.object({
    id: z.string(),
    text: z.string(),
    createdAt: z.number(),
  })
  export type Note = z.infer<typeof Note>

  export const Category = z.object({
    id: z.string(),
    name: z.string(),
    notes: z.array(Note),
  })
  export type Category = z.infer<typeof Category>

  export const Doc = z.object({
    enabled: z.boolean(),
    categories: z.array(Category),
  })
  export type Doc = z.infer<typeof Doc>

  export const Scope = z.enum(["global", "project"])
  export type Scope = z.infer<typeof Scope>

  const root = path.join(Global.Path.data, "settings", "memory")

  function defaultDoc(): Doc {
    return {
      enabled: true,
      categories: [{ id: "about-you", name: "About you", notes: [] }],
    }
  }

  function fileFor(scope: Scope): string {
    if (scope === "global") return path.join(root, "global.json")
    const key = crypto.createHash("sha256").update(Instance.directory).digest("hex").slice(0, 16)
    return path.join(root, "projects", `${key}.json`)
  }

  export async function get(scope: Scope): Promise<Doc> {
    const text = await Bun.file(fileFor(scope))
      .text()
      .catch(() => undefined)
    if (!text) return defaultDoc()
    try {
      const parsed = Doc.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
    } catch (e) {
      log.error("failed to parse memory doc", { scope, error: e })
    }
    return defaultDoc()
  }

  export async function set(scope: Scope, doc: Doc): Promise<Doc> {
    const file = fileFor(scope)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify(doc, null, 2))
    return doc
  }

  // Formatted memory blocks for the current instance, honoring each scope's
  // enabled flag. Empty array => nothing to inject. Called from the session
  // loop so notes are actually recalled by the agent.
  export async function recall(): Promise<string[]> {
    const blocks: string[] = []
    for (const scope of Scope.options) {
      const doc = await get(scope).catch(() => undefined)
      if (!doc || !doc.enabled) continue
      const lines: string[] = []
      for (const category of doc.categories) {
        const notes = category.notes.filter((n) => n.text.trim())
        if (notes.length === 0) continue
        lines.push(`## ${category.name}`)
        for (const note of notes) lines.push(`- ${note.text.trim()}`)
      }
      if (lines.length > 0)
        blocks.push(
          [
            `<memory scope="${scope}">`,
            "The user has saved the following standing notes. Honor them across the session.",
            ...lines,
            "</memory>",
          ].join("\n"),
        )
    }
    return blocks
  }
}
