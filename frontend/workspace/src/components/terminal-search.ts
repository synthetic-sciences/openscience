export type TerminalMatch = {
  column: number
  row: number
  length: number
}

export function terminalMatches(lines: string[], query: string): TerminalMatch[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []

  return lines
    .map((line, row) => {
      const value = line.toLocaleLowerCase()
      return Array.from({ length: value.length }, (_, column) => column)
        .filter((column) => value.indexOf(needle, column) === column)
        .map((column) => ({ column, row, length: query.length }))
    })
    .flat()
}
