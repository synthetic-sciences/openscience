// A hidden record of where an imported session came from, so a re-import can
// update it (or make a separate copy) instead of importing twice.
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
