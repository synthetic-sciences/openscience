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
      // Folding a character can change its length ("İ" lowercases to "i" plus a
      // combining dot), so an offset in the folded line is not the cell xterm
      // selects against the original buffer. Track both edges of every folded
      // code unit and translate the match back: deriving the end from the start
      // of the last unit is a code unit short whenever the match ends in an
      // astral character, which cut the highlight through the middle of it.
      let value = ""
      const start: number[] = []
      const end: number[] = []
      let offset = 0
      for (const char of line) {
        const folded = char.toLocaleLowerCase()
        value += folded
        for (let unit = 0; unit < folded.length; unit++) {
          start.push(offset)
          end.push(offset + char.length)
        }
        offset += char.length
      }
      return Array.from({ length: value.length }, (_, column) => column)
        .filter((column) => value.indexOf(needle, column) === column)
        .map((column) => ({
          column: start[column],
          row,
          length: end[column + needle.length - 1]! - start[column]!,
        }))
    })
    .flat()
}
