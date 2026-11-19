/** Substitute the formatter's `$FILE` placeholder with the exact path. A
 * function replacer keeps `$` sequences in a filename from being read as
 * replacement patterns, which would hand the formatter the wrong path. */
export function substituteFile(command: string[], file: string): string[] {
  return command.map((value) => value.replace("$FILE", () => file))
}
