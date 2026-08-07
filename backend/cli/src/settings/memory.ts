import path from "path"
import fs from "fs/promises"
import crypto from "crypto"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

// Persistent, curated memory: standing notes/instructions grouped into
// categories that get injected into agent context on every turn (when enabled).
// Two scopes: "global" (all projects) and "project" (the current directory).
// Backed by a plain JSON document per scope under ~/.openscience data dir.
//
// The document is bounded: each scope has a character budget. Agent writes past
// the budget error until existing notes are consolidated (the "consolidation
// wall") — bounded space creates selection pressure for what is worth keeping.
// The panel's whole-doc PUT (set) is exempt from the wall, but recall() clamps
// injection at a hard safety limit so an over-budget doc can never flood the
// context window.
export namespace Memory {
  const log = Log.create({ service: "settings.memory" })

  // Default per-scope budget in characters (~700 tokens); both scopes together
  // stay under ~1,500 tokens of every-turn context. Overridable via Doc.budget.
  export const BUDGET = 2000
  // A single note may never exceed this many characters.
  export const NOTE_MAX = 500
  // recall() injects at most CLAMP x budget characters of notes per scope.
  const CLAMP = 2

  export const Source = z.enum(["user", "agent"])
  export type Source = z.infer<typeof Source>

  export const Note = z.object({
    id: z.string(),
    text: z.string(),
    createdAt: z.number(),
    updatedAt: z.number().optional(),
    // Who wrote the note. Absent on documents saved before this field existed;
    // treat missing as "user".
    source: Source.optional(),
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
    budget: z.number().int().positive().optional(),
  })
  export type Doc = z.infer<typeof Doc>

  export const Capacity = z.object({
    used: z.number(),
    max: z.number(),
    gauge: z.string(),
  })
  export type Capacity = z.infer<typeof Capacity>

  export const Scope = z.enum(["global", "project"])
  export type Scope = z.infer<typeof Scope>

  const root = path.join(Global.Path.data, "settings", "memory")

  function defaultDoc(): Doc {
    return {
      enabled: false,
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

  // Case- and whitespace-folded text used for exact-duplicate comparison.
  function fold(text: string) {
    return text.toLowerCase().replace(/\s+/g, " ").trim()
  }

  // Invisible/control Unicode that could smuggle hidden instructions into the
  // every-turn context: zero-width chars, bidi controls, word joiners, BOM.
  const INVISIBLE = new RegExp(
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]",
  )

  // Screening applied on every note write path. Whole system-reminder-style
  // blocks are dropped (tags and payload), then any stray tags.
  export function screen(text: string) {
    const cleaned = text
      .replace(/<\s*system-reminder[^>]*>[\s\S]*?<\/\s*system-reminder\s*>/gi, "")
      .replace(/<\/?\s*system-reminder[^>]*>/gi, "")
      .trim()
    if (!cleaned) throw new Error("Memory note is empty after screening.")
    if (INVISIBLE.test(cleaned))
      throw new Error("Memory note contains invisible or control characters. Rewrite it as plain text.")
    if (cleaned.length > NOTE_MAX)
      throw new Error(`Memory note is ${cleaned.length} chars; the maximum is ${NOTE_MAX}. Distill it before saving.`)
    return cleaned
  }

  function size(doc: Doc) {
    return doc.categories.reduce((sum, c) => sum + c.notes.reduce((s, n) => s + n.text.length, 0), 0)
  }

  export function measure(doc: Doc): Capacity {
    const used = size(doc)
    const max = doc.budget ?? BUDGET
    const pct = Math.min(999, Math.round((used / max) * 100))
    return { used, max, gauge: `[${pct}% — ${used}/${max} chars]` }
  }

  export async function capacity(scope: Scope) {
    return measure(await get(scope))
  }

  function assertEnabled(scope: Scope, doc: Doc) {
    if (doc.enabled) return
    throw new Error(`Memory is disabled for the ${scope} scope.`)
  }

  function duplicate(doc: Doc, text: string, except?: string) {
    const folded = fold(text)
    for (const category of doc.categories)
      for (const note of category.notes) {
        if (note.id === except) continue
        if (fold(note.text) === folded) return true
      }
    return false
  }

  export async function append(scope: Scope, input: { text: string; category?: string; source?: Source }) {
    const doc = await get(scope)
    assertEnabled(scope, doc)
    const text = screen(input.text)
    const cap = measure(doc)
    if (duplicate(doc, text)) throw new Error(`Duplicate: an identical note already exists. Capacity ${cap.gauge}`)
    if (cap.used + text.length > cap.max)
      throw new Error(
        [
          `Memory is full: adding ${text.length} chars would exceed the ${scope} budget. Capacity ${cap.gauge}`,
          "Consolidate first: merge, shorten, or remove existing notes (memory replace/remove), then retry.",
        ].join("\n"),
      )
    const name = input.category?.trim() || "General"
    const found = doc.categories.find((c) => fold(c.name) === fold(name))
    const category = found ?? { id: crypto.randomUUID(), name, notes: [] }
    if (!found) doc.categories.push(category)
    const note: Note = { id: crypto.randomUUID(), text, createdAt: Date.now(), source: input.source ?? "user" }
    category.notes.push(note)
    await set(scope, doc)
    return { note, capacity: measure(doc) }
  }

  function clip(text: string) {
    return text.length > 80 ? text.slice(0, 80) + "…" : text
  }

  // Every note whose text contains the exact substring. Mutations require
  // exactly one hit — never a silent multi-note overwrite.
  function locate(doc: Doc, old: string) {
    const hits: { category: Category; note: Note }[] = []
    for (const category of doc.categories)
      for (const note of category.notes) if (note.text.includes(old)) hits.push({ category, note })
    return hits
  }

  function single(scope: Scope, doc: Doc, old: string) {
    const hits = locate(doc, old)
    if (hits.length === 0)
      throw new Error(
        `No ${scope} note contains "${clip(old)}" (matching is an exact, case-sensitive substring). Use memory search to find the exact wording.`,
      )
    if (hits.length > 1)
      throw new Error(
        [
          `Ambiguous: ${hits.length} notes contain "${clip(old)}". Narrow old_text until it matches exactly one:`,
          ...hits.slice(0, 5).map((hit) => `- ${clip(hit.note.text)}`),
        ].join("\n"),
      )
    return hits[0]!
  }

  // Surgical edit: within the single note containing old, every occurrence of
  // old becomes next.
  export async function replace(scope: Scope, old: string, next: string) {
    const doc = await get(scope)
    assertEnabled(scope, doc)
    const hit = single(scope, doc, old)
    const text = screen(hit.note.text.split(old).join(next))
    if (duplicate(doc, text, hit.note.id))
      throw new Error(`Duplicate: another identical note already exists. Capacity ${measure(doc).gauge}`)
    const cap = measure(doc)
    const grown = cap.used - hit.note.text.length + text.length
    if (grown > cap.max && grown > cap.used)
      throw new Error(
        [
          `Memory is full: this edit would grow the ${scope} scope to ${grown}/${cap.max} chars. Capacity ${cap.gauge}`,
          "Consolidate first: merge, shorten, or remove existing notes, then retry.",
        ].join("\n"),
      )
    hit.note.text = text
    hit.note.updatedAt = Date.now()
    await set(scope, doc)
    return { note: hit.note, capacity: measure(doc) }
  }

  // Deletes the single note whose text contains old.
  export async function remove(scope: Scope, old: string) {
    const doc = await get(scope)
    assertEnabled(scope, doc)
    const hit = single(scope, doc, old)
    hit.category.notes = hit.category.notes.filter((note) => note.id !== hit.note.id)
    await set(scope, doc)
    return { note: hit.note, capacity: measure(doc) }
  }

  // Formatted memory blocks for the current instance, honoring each scope's
  // enabled flag. Empty array => nothing to inject. Called from the session
  // loop so notes are actually recalled by the agent. Injection is clamped at
  // CLAMP x budget per scope as a hard safety against over-budget panel edits.
  export async function recall(): Promise<string[]> {
    const blocks: string[] = []
    for (const scope of Scope.options) {
      const doc = await get(scope).catch(() => undefined)
      if (!doc || !doc.enabled) continue
      const cap = measure(doc)
      const limit = cap.max * CLAMP
      const lines: string[] = []
      const over: string[] = []
      let total = 0
      for (const category of doc.categories) {
        const notes = category.notes.filter((n) => n.text.trim())
        if (notes.length === 0) continue
        const kept: string[] = []
        for (const note of notes) {
          const text = note.text.trim()
          if (total + text.length > limit) {
            over.push(text)
            continue
          }
          total += text.length
          kept.push(`- ${text}`)
        }
        if (kept.length > 0) lines.push(`## ${category.name}`, ...kept)
      }
      if (over.length > 0)
        lines.push(
          `(${over.length} note(s) omitted — memory is over its safety limit; consolidate in Settings → Memory)`,
        )
      if (lines.length > 0)
        blocks.push(
          [
            `<memory scope="${scope}">`,
            "The user has saved the following standing notes. Honor them across the session.",
            ...lines,
            `Capacity: ${cap.gauge}`,
            "Use the memory tool to add, correct, or search memories (full-text).",
            "</memory>",
          ].join("\n"),
        )
    }
    return blocks
  }
}
