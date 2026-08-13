import fs from "node:fs/promises"
import path from "node:path"
import { SafeFileIO } from "@/file/safe-io"
import { ProvenanceEnvelope } from "@/science/provenance/envelope"

type Fingerprint = { size: number; mtimeMs: number; dev: number; ino: number }
export type Snapshot = Map<string, Fingerprint>

const MAX_ENTRIES = 4_096
const MAX_FILES = 64
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const ignored = new Set([".git", ".venv", "node_modules", "__pycache__", ".cache"])

/**
 * Bounded, best-effort observation of ordinary workspace files. It deliberately
 * skips dependency/cache trees and symbolic links: execution history is a
 * scientific record, not a second recursive backup system.
 */
export async function snapshot(root: string): Promise<Snapshot> {
  const output: Snapshot = new Map()
  const walk = async (directory: string) => {
    if (output.size >= MAX_ENTRIES) return
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (output.size >= MAX_ENTRIES) break
      if (ignored.has(entry.name)) continue
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.lstat(target).catch(() => undefined)
      if (!stat?.isFile()) continue
      const relative = path.relative(root, target)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue
      output.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino })
    }
  }
  await walk(root)
  return output
}

/** Hash files that were created or changed during an execution, within hard
 * per-run byte/count bounds. Concurrent replacement fails closed through
 * SafeFileIO and simply leaves that file uncaptured. */
export async function changed(root: string, before: Snapshot, completedAt: number) {
  const after = await snapshot(root)
  const candidates = [...after].filter(([name, value]) => {
    const prior = before.get(name)
    return !prior || prior.size !== value.size || prior.mtimeMs !== value.mtimeMs || prior.ino !== value.ino
  })
  const outputs: ProvenanceEnvelope.Output[] = []
  let total = 0
  for (const [name, value] of candidates.slice(0, MAX_FILES)) {
    if (value.size > MAX_FILE_BYTES || total + value.size > MAX_TOTAL_BYTES) continue
    const target = path.join(root, name)
    const file = await SafeFileIO.optional(target).catch(() => undefined)
    if (!file || file.bytes.byteLength !== value.size) continue
    total += file.bytes.byteLength
    outputs.push(
      ProvenanceEnvelope.output({
        kind: "checkpoint",
        label: name,
        path: name,
        content: file.bytes,
        createdAt: completedAt,
      }),
    )
  }
  return outputs
}
