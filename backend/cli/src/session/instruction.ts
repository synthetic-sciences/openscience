import path from "path"
import { constants as FS } from "node:fs"
import fs from "node:fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { Log } from "../util/log"
import type { MessageV2 } from "./message-v2"
import { Network } from "@/settings/network"

const log = Log.create({ service: "instruction" })

const FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md", // deprecated
]

const SOURCE_BYTES = 256 * 1024
const TOTAL_BYTES = 1024 * 1024
const SOURCE_COUNT = 64

// Project memory: notes that should outlive a session boundary. It is a directory
// convention rather than a new config key, so a project adopts it by writing files
// and nothing has to be enabled first.
const MEMORY_DIR = path.join(".openscience", "memory")

// Reading is only half of a memory. Without a stated place to put a new note the
// directory stays empty and each session still restates what earlier ones decided,
// so the convention ships with one sentence of operating context. It is not a
// capture pipeline: the model writes only when the user asks, so nothing lands in
// the project's memory without a turn that asked for it.
const MEMORY_GUIDE = [
  "This project keeps notes that outlive a session in .openscience/memory/, loaded above.",
  "When the user asks you to remember something, or a decision is settled that a later session must know,",
  "append a short entry to .openscience/memory/decision.md with your file tools instead of only restating it here.",
].join(" ")

async function memoryFiles(limit: number) {
  if (limit <= 0) return [] as string[]
  const found: string[] = []
  try {
    const glob = new Bun.Glob("**/*.md")
    for await (const match of glob.scan({
      cwd: path.join(Instance.directory, MEMORY_DIR),
      absolute: true,
      onlyFiles: true,
      dot: false,
    })) {
      found.push(path.resolve(match))
      if (found.length >= limit) break
    }
  } catch {
    // A missing or unreadable memory directory must not break the session.
  }
  return found.sort()
}

function globalFiles() {
  const files = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.OPENSCIENCE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(Global.Path.home, ".claude", "CLAUDE.md"))
  }
  if (Flag.OPENSCIENCE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENSCIENCE_CONFIG_DIR, "AGENTS.md"))
  }
  return files
}

async function globUp(instruction: string, start: string, stop: string, limit: number) {
  const found: string[] = []
  const cursor = { path: start }
  while (found.length < limit) {
    try {
      const glob = new Bun.Glob(instruction)
      for await (const match of glob.scan({
        cwd: cursor.path,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
        dot: true,
      })) {
        found.push(match)
        if (found.length >= limit) break
      }
    } catch {
      // Invalid or unreadable configured patterns do not break the session.
    }
    if (cursor.path === stop) break
    const parent = path.dirname(cursor.path)
    if (parent === cursor.path) break
    cursor.path = parent
  }
  return found
}

async function resolveRelative(instruction: string, limit: number): Promise<string[]> {
  if (!Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG) {
    return globUp(instruction, Instance.directory, Instance.worktree, limit)
  }
  if (!Flag.OPENSCIENCE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENSCIENCE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return globUp(instruction, Flag.OPENSCIENCE_CONFIG_DIR, Flag.OPENSCIENCE_CONFIG_DIR, limit)
}

async function local(filepath: string) {
  const canonical = await fs.realpath(filepath)
  const handle = await fs.open(canonical, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      log.warn("Skipping non-regular local instruction source", { filepath })
      return ""
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > SOURCE_BYTES) {
      log.warn("Skipping oversized local instruction source", { filepath, limit: SOURCE_BYTES })
      return ""
    }
    const bytes = Buffer.allocUnsafe(before.size)
    const offset = { value: 0 }
    while (offset.value < bytes.byteLength) {
      const result = await handle.read(bytes, offset.value, bytes.byteLength - offset.value, offset.value)
      if (!result.bytesRead) return ""
      offset.value += result.bytesRead
    }
    const after = await handle.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      log.warn("Skipping local instruction source that changed during its read", { filepath })
      return ""
    }
    return bytes.toString("utf8")
  } finally {
    await handle.close()
  }
}

async function remote(url: string) {
  const response = await Network.fetch(
    url,
    { signal: AbortSignal.timeout(5000) },
    { maxResponseBytes: SOURCE_BYTES, streamResponse: true },
  )
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    return ""
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const size = { value: 0 }
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size.value += next.value.byteLength
      if (size.value > SOURCE_BYTES) {
        await reader.cancel().catch(() => undefined)
        log.warn("Skipping oversized remote instruction source", { url, limit: SOURCE_BYTES })
        return ""
      }
      chunks.push(next.value.slice())
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size.value).toString("utf8")
}

function bounded(entries: string[]) {
  const size = { value: 0 }
  return entries.filter((entry) => {
    if (!entry) return false
    const bytes = Buffer.byteLength(entry)
    if (size.value + bytes > TOTAL_BYTES) {
      log.warn("Skipping instruction source because the combined instruction limit was reached", {
        limit: TOTAL_BYTES,
      })
      return false
    }
    size.value += bytes
    return true
  })
}

export namespace InstructionPrompt {
  const state = Instance.state(() => {
    return {
      claims: new Map<string, Set<string>>(),
    }
  })

  function isClaimed(messageID: string, filepath: string) {
    const claimed = state().claims.get(messageID)
    if (!claimed) return false
    return claimed.has(filepath)
  }

  function claim(messageID: string, filepath: string) {
    const current = state()
    let claimed = current.claims.get(messageID)
    if (!claimed) {
      claimed = new Set()
      current.claims.set(messageID, claimed)
    }
    claimed.add(filepath)
  }

  export function clear(messageID: string) {
    state().claims.delete(messageID)
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    if (!Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.slice(0, SOURCE_COUNT - paths.size).forEach((p) => paths.add(path.resolve(p)))
          break
        }
      }
    }

    for (const file of globalFiles()) {
      if (paths.size >= SOURCE_COUNT) break
      if (await Bun.file(file).exists()) {
        paths.add(path.resolve(file))
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (paths.size >= SOURCE_COUNT) break
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(Global.Path.home, instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await globUp(
              path.basename(instruction),
              path.dirname(instruction),
              path.dirname(instruction),
              SOURCE_COUNT - paths.size,
            )
          : await resolveRelative(instruction, SOURCE_COUNT - paths.size)
        matches.slice(0, SOURCE_COUNT - paths.size).forEach((p) => paths.add(path.resolve(p)))
      }
    }

    // Project memory is added last on purpose: `bounded()` drops entries once the
    // combined limit is reached, so instructions keep their priority and memory is
    // the first thing sacrificed when a project gets greedy.
    if (!Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG) {
      for (const file of await memoryFiles(SOURCE_COUNT - paths.size)) {
        if (paths.size >= SOURCE_COUNT) break
        paths.add(file)
      }
    }

    return paths
  }

  export async function system() {
    const config = await Config.get()
    const paths = await systemPaths()
    const sources = [
      ...Array.from(paths).map((filepath) => ({ label: filepath, read: () => local(filepath) })),
      ...(config.instructions ?? [])
        .filter((instruction) => instruction.startsWith("https://") || instruction.startsWith("http://"))
        .map((url) => ({ label: url, read: () => remote(url) })),
    ].slice(0, SOURCE_COUNT)
    const entries = await Promise.all(
      sources.map((source) =>
        source
          .read()
          .catch(() => "")
          .then((content) => (content ? "Instructions from: " + source.label + "\n" + content : "")),
      ),
    )
    // The guide is appended outside bounded(): it is the write half of the same
    // convention, it is short, and a project whose instruction budget is already
    // full still needs to know where a new note goes.
    return [...bounded(entries), ...(Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG ? [] : [MEMORY_GUIDE])]
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Bun.file(filepath).exists()) return filepath
    }
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string, messageID: string) {
    const system = await systemPaths()
    const already = loaded(messages)
    const results: { filepath: string; content: string }[] = []
    const size = { value: 0 }

    let current = path.dirname(path.resolve(filepath))
    const root = path.resolve(Instance.directory)

    while (Filesystem.contains(root, current)) {
      const found = await find(current)
      if (found && !system.has(found) && !already.has(found) && !isClaimed(messageID, found)) {
        claim(messageID, found)
        const content = await local(found).catch(() => undefined)
        if (content) {
          const entry = "Instructions from: " + found + "\n" + content
          const bytes = Buffer.byteLength(entry)
          if (size.value + bytes > TOTAL_BYTES) break
          size.value += bytes
          results.push({ filepath: found, content: entry })
        }
      }
      if (current === root) break
      current = path.dirname(current)
    }

    return results
  }
}
