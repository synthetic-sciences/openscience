// A whitelist of one-code-unit atoms for the project's native /gi contract,
// not a general JS regexp parser. Unrecognised syntax uses the prefix path.
const atom =
  /(?:[A-Za-z0-9 _:#@%,\u3400-\u9fff-]|\\u[\da-fA-F]{4}|\\[dDsSwW]|\[(?:[A-Za-z0-9_-]|\\[dDsSwW])+\])(?:\{([1-9]\d{0,3})(?:,([1-9]\d{0,3}))?\})?/y
const MAX_WIDTH = 4096

export function boundedRegexWidth(pattern: RegExp): number | undefined {
  if (pattern.flags !== "gi") return
  const tokens = new RegExp(atom)
  let position = 0,
    width = 0,
    variable = false
  while (position < pattern.source.length) {
    tokens.lastIndex = position
    const token = tokens.exec(pattern.source)
    if (!token) return
    const min = Number(token[1] ?? 1),
      max = Number(token[2] ?? min)
    // Avoid promoting chains of ambiguous variable repetitions to full-history scans.
    if (max !== min && variable) return
    variable ||= max !== min
    width += max
    if (width > MAX_WIDTH) return
    position = tokens.lastIndex
  }
  return width || undefined
}
