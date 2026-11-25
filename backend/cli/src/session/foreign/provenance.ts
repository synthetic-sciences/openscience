// A hidden record of where an imported session came from, so a re-import can
// update it (or make a separate copy) instead of importing twice.
import crypto from "node:crypto"
import { Instance } from "../../project/instance"
import { Storage } from "../../storage/storage"
import type { ForeignSource } from "./types"

export namespace Provenance {
  export type Record = {
    source: ForeignSource
    sourceID: string
    path: string
    cwd?: string
    /** Source record ids on the imported branch, oldest first. */
    branchIDs: string[]
    /** `sourceID` of the last entry written. */
    lastSourceID: string
    /** The last OpenScience message the import wrote. */
    lastMessageID: string
    importedAt: number
  }

  const key = (sessionID: string) => ["foreign_import", Instance.project.id, sessionID]

  export async function read(sessionID: string): Promise<Record | undefined> {
    return Storage.read<Record>(key(sessionID)).catch(() => undefined)
  }

  export async function write(sessionID: string, record: Record): Promise<void> {
    await Storage.write(key(sessionID), record)
  }

  export async function remove(sessionID: string): Promise<void> {
    await Storage.remove(key(sessionID)).catch(() => undefined)
  }

  const countKey = (source: ForeignSource, sourceID: string) => [
    "foreign_import_count",
    Instance.project.id,
    source,
    crypto.createHash("sha256").update(sourceID).digest("hex").slice(0, 32),
  ]

  /** Sessions ever created from this conversation in the project. The counter outlives the
   * sessions: it numbers copies and marks "imported, then deleted". */
  export async function copyCount(source: ForeignSource, sourceID: string): Promise<number> {
    return (await Storage.read<{ count: number }>(countKey(source, sourceID)).catch(() => ({ count: 0 }))).count
  }

  /** Record a session made from this conversation; call only once its import succeeded. */
  export async function setCopyCount(source: ForeignSource, sourceID: string, count: number): Promise<void> {
    await Storage.write(countKey(source, sourceID), { count })
  }

  export async function everImported(source: ForeignSource, sourceID: string): Promise<boolean> {
    return Storage.read(countKey(source, sourceID))
      .then(() => true)
      .catch(() => false)
  }

  /** Every import record in the project, read once: `source:sourceID` → session ids. */
  export async function index(): Promise<Map<string, string[]>> {
    const keys = await Storage.list(["foreign_import", Instance.project.id]).catch(() => [] as string[][])
    const out = new Map<string, string[]>()
    for (const item of keys) {
      const sessionID = item.at(-1)!
      const record = await read(sessionID)
      if (!record) continue
      const key = `${record.source}:${record.sourceID}`
      out.set(key, [...(out.get(key) ?? []), sessionID])
    }
    return out
  }

  /** Sessions in the current project imported from this source conversation. */
  export async function findBySource(source: ForeignSource, sourceID: string): Promise<string[]> {
    const keys = await Storage.list(["foreign_import", Instance.project.id]).catch(() => [] as string[][])
    const found: string[] = []
    for (const item of keys) {
      const sessionID = item.at(-1)!
      const record = await read(sessionID)
      if (record?.source === source && record.sourceID === sourceID) found.push(sessionID)
    }
    return found.toSorted()
  }
}
