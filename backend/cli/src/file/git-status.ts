/** Git's -z records preserve tabs, newlines and leading/trailing whitespace in filenames. */
export namespace GitStatus {
  export function paths(output: string): string[] {
    return output.split("\0").filter(Boolean)
  }

  export function numstat(output: string): { path: string; added: number; removed: number }[] {
    const records = paths(output)
    const result: { path: string; added: number; removed: number }[] = []
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!
      const first = record.indexOf("\t")
      const second = record.indexOf("\t", first + 1)
      if (first < 0 || second < 0) continue
      const added = record.slice(0, first)
      const removed = record.slice(first + 1, second)
      const name = record.slice(second + 1)
      // With -z, a rename uses an empty filename followed by old and new NUL records.
      const next = name || records[index + 2]
      if (!next) continue
      if (!name) index += 2
      result.push({
        path: next,
        added: added === "-" ? 0 : Number(added),
        removed: removed === "-" ? 0 : Number(removed),
      })
    }
    return result
  }
}
