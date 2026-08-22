import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import path from "path"
import z from "zod"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { Instance } from "../../project/instance"
import { Session } from "../../session"
import { lazy } from "../../util/lazy"

// Plain-text project search over session titles, conversation text, ordinary
// workspace files, and recognized artifacts. Honest scope: case-insensitive
// substring matching over bounded recent/local content, no semantic index.
const Result = z.object({
  sessions: z.array(z.object({ id: z.string(), title: z.string() })),
  messages: z.array(z.object({ sessionID: z.string(), messageID: z.string(), role: z.string(), snippet: z.string() })),
  files: z.array(z.object({ path: z.string(), name: z.string(), snippet: z.string().optional() })),
  artifacts: z.array(z.object({ path: z.string(), name: z.string(), kind: z.string() })),
})

const SESSION_CAP = 200
const MESSAGE_CAP = 200
const MATCH_CAP = 20
const FILE_SCAN_CAP = 500
const FILE_READ_CAP = 64 * 1024
const FILE_CONCURRENCY = 8

export const SearchRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Search sessions, messages, files, and artifacts",
      description:
        "Case-insensitive plain-text search across session titles, recent conversation text, up to 500 visible workspace files, and artifact files in the project.",
      operationId: "search.query",
      responses: {
        200: {
          description: "Grouped plain-text matches",
          content: { "application/json": { schema: resolver(Result) } },
        },
      },
    }),
    validator("query", z.object({ q: z.string().trim().min(2).max(200) })),
    async (c) => {
      const query = c.req.valid("query").q.toLowerCase()
      const sessions: Array<{ id: string; title: string }> = []
      const messages: Array<{ sessionID: string; messageID: string; role: string; snippet: string }> = []
      const files: Array<{ path: string; name: string; snippet?: string }> = []
      const artifacts: Array<{ path: string; name: string; kind: string }> = []

      const snippet = (text: string, index: number) => {
        const start = Math.max(0, index - 60)
        const end = Math.min(text.length, index + query.length + 60)
        return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
      }

      let scanned = 0
      for await (const session of Session.list()) {
        if (scanned >= SESSION_CAP) break
        scanned += 1
        if (session.parentID) continue
        if (sessions.length < MATCH_CAP && session.title.toLowerCase().includes(query)) {
          sessions.push({ id: session.id, title: session.title })
        }
        if (messages.length >= MATCH_CAP) continue
        const items = await Session.messages({ sessionID: session.id, limit: MESSAGE_CAP }).catch(
          () => [] as Awaited<ReturnType<typeof Session.messages>>,
        )
        for (const item of items) {
          if (messages.length >= MATCH_CAP) break
          for (const part of item.parts) {
            if (part.type !== "text") continue
            const index = part.text.toLowerCase().indexOf(query)
            if (index === -1) continue
            messages.push({
              sessionID: session.id,
              messageID: item.info.id,
              role: item.info.role,
              snippet: snippet(part.text, index),
            })
            break
          }
        }
      }

      // The palette promises ordinary project files, not just extensions that
      // happen to classify as research artifacts. Enumerate a bounded prefix
      // of ripgrep's visible, ignore-aware file list and inspect only small,
      // in-project text files. Ripgrep does not follow symlinks here, while
      // File.raw re-checks canonical containment before every read.
      const candidates: string[] = []
      const iterator = Ripgrep.files({
        cwd: Instance.directory,
        hidden: false,
        glob: ["!.openscience/**", "!.synsc/**"],
      })[Symbol.asyncIterator]()
      for (const _ of Array.from({ length: FILE_SCAN_CAP })) {
        const item = await iterator.next().catch(() => undefined)
        if (!item || item.done) break
        candidates.push(item.value)
      }
      await iterator.return?.(undefined).catch(() => undefined)

      const batches = Array.from({ length: Math.ceil(candidates.length / FILE_CONCURRENCY) }, (_, index) =>
        candidates.slice(index * FILE_CONCURRENCY, (index + 1) * FILE_CONCURRENCY),
      )
      for (const batch of batches) {
        const found = await Promise.all(
          batch.map(async (file) => {
            const normalized = file.replaceAll("\\", "/")
            if (normalized.toLowerCase().includes(query)) {
              return { path: normalized, name: path.basename(file) }
            }
            const raw = await File.raw(file, { maxBytes: FILE_READ_CAP }).catch(() => undefined)
            if (!raw) return
            const mime = raw.type.toLowerCase()
            const textual =
              !mime ||
              mime.startsWith("text/") ||
              ["json", "javascript", "xml", "yaml", "toml"].some((kind) => mime.includes(kind))
            if (!textual) return
            const bytes = new Uint8Array(await raw.arrayBuffer())
            if (bytes.includes(0)) return
            const text = new TextDecoder().decode(bytes)
            if ((text.match(/\uFFFD/g)?.length ?? 0) > 3) return
            const index = text.toLowerCase().indexOf(query)
            if (index === -1) return
            return { path: normalized, name: path.basename(file), snippet: snippet(text, index) }
          }),
        )
        for (const item of found) {
          if (!item) continue
          files.push(item)
          if (files.length >= MATCH_CAP) break
        }
        if (files.length >= MATCH_CAP) break
      }

      for (const artifact of await File.artifacts().catch(() => [])) {
        if (artifacts.length >= MATCH_CAP) break
        if (`${artifact.name} ${artifact.path}`.toLowerCase().includes(query)) {
          artifacts.push({ path: artifact.path, name: artifact.name, kind: artifact.kind })
        }
      }

      // Prefer the richer artifact entry when the same path matched both
      // groups, while retaining artifact content hits that did not match the
      // artifact's name or path.
      const artifactPaths = new Set(artifacts.map((artifact) => artifact.path.replaceAll("\\", "/")))
      const ordinary = files.filter((file) => !artifactPaths.has(file.path))
      return c.json({ sessions, messages, files: ordinary, artifacts })
    },
  ),
)
