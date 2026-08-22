export type MarkdownImage = {
  alt: string
  target: string
  line: number
  start: number
  end: number
}

type Destination = {
  target: string
  end: number
}

const label = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase()

const lines = (source: string) => {
  const values = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []
  return values
    .filter((value, index) => value.length > 0 || (source.length === 0 && index === 0))
    .map((raw) => ({ raw, text: raw.replace(/(?:\r\n|\n|\r)$/, "") }))
}

const escaped = (value: string, index: number) => {
  const count = { value: 0 }
  for (const char of value.slice(0, index).split("").reverse()) {
    if (char !== "\\") break
    count.value += 1
  }
  return count.value % 2 === 1
}

const close = (value: string, start: number, target: string) => {
  const cursor = { value: start }
  while (cursor.value < value.length) {
    if (value[cursor.value] === target && !escaped(value, cursor.value)) return cursor.value
    cursor.value += 1
  }
  return -1
}

const destination = (value: string, start: number): Destination | undefined => {
  const cursor = { value: start }
  while (/\s/.test(value[cursor.value] ?? "")) cursor.value += 1
  if (value[cursor.value] === "<") {
    const end = close(value, cursor.value + 1, ">")
    if (end < 0) return
    return { target: value.slice(cursor.value + 1, end), end: end + 1 }
  }
  const begin = cursor.value
  const depth = { value: 0 }
  while (cursor.value < value.length) {
    const char = value[cursor.value]!
    if (!escaped(value, cursor.value)) {
      if (char === "(") depth.value += 1
      if (char === ")") {
        if (depth.value === 0) break
        depth.value -= 1
      }
      if (/\s/.test(char) && depth.value === 0) break
    }
    cursor.value += 1
  }
  if (cursor.value === begin || depth.value !== 0) return
  return { target: value.slice(begin, cursor.value), end: cursor.value }
}

const inline = (value: string, start: number) => {
  const found = destination(value, start)
  if (!found) return
  const cursor = { value: found.end }
  while (/\s/.test(value[cursor.value] ?? "")) cursor.value += 1
  if (value[cursor.value] === ")") return { target: found.target, end: cursor.value + 1 }
  const opener = value[cursor.value]
  const closer = opener === "(" ? ")" : opener === '"' || opener === "'" ? opener : undefined
  if (!closer) return
  const title = close(value, cursor.value + 1, closer)
  if (title < 0) return
  cursor.value = title + 1
  while (/\s/.test(value[cursor.value] ?? "")) cursor.value += 1
  if (value[cursor.value] !== ")") return
  return { target: found.target, end: cursor.value + 1 }
}

const definitions = (source: string) => {
  const output = new Map<string, string>()
  const fence = { marker: "", size: 0 }
  for (const line of lines(source)) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line.text)?.[1]
    if (marker) {
      const char = marker[0]!
      if (!fence.marker) {
        fence.marker = char
        fence.size = marker.length
      } else if (fence.marker === char && marker.length >= fence.size) {
        fence.marker = ""
        fence.size = 0
      }
      continue
    }
    if (fence.marker || /^(?: {4}|\t)/.test(line.text)) continue
    const match = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(.*)$/.exec(line.text)
    if (!match) continue
    const found = destination(match[2]!, 0)
    if (!found) continue
    output.set(label(match[1]!), found.target)
  }
  return output
}

/** Parse inline and reference-style Markdown images while ignoring fenced and inline code. */
export function markdownImages(source: string): MarkdownImage[] {
  const refs = definitions(source)
  const output: MarkdownImage[] = []
  const offset = { value: 0 }
  const fence = { marker: "", size: 0 }
  for (const [row, line] of lines(source).entries()) {
    const value = line.text
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(value)?.[1]
    if (marker) {
      const char = marker[0]!
      if (!fence.marker) {
        fence.marker = char
        fence.size = marker.length
      } else if (fence.marker === char && marker.length >= fence.size) {
        fence.marker = ""
        fence.size = 0
      }
      offset.value += line.raw.length
      continue
    }
    if (fence.marker) {
      offset.value += line.raw.length
      continue
    }
    if (/^(?: {4}|\t)/.test(value)) {
      offset.value += line.raw.length
      continue
    }
    const cursor = { value: 0 }
    while (cursor.value < value.length) {
      if (value[cursor.value] === "`") {
        const ticks = /^`+/.exec(value.slice(cursor.value))?.[0] ?? "`"
        const end = value.indexOf(ticks, cursor.value + ticks.length)
        cursor.value = end < 0 ? value.length : end + ticks.length
        continue
      }
      if (value[cursor.value] !== "!" || value[cursor.value + 1] !== "[" || escaped(value, cursor.value)) {
        cursor.value += 1
        continue
      }
      const altEnd = close(value, cursor.value + 2, "]")
      if (altEnd < 0) break
      const alt = value.slice(cursor.value + 2, altEnd)
      const next = altEnd + 1
      const direct = value[next] === "(" ? inline(value, next + 1) : undefined
      if (direct) {
        output.push({
          alt,
          target: direct.target,
          line: row + 1,
          start: offset.value + cursor.value,
          end: offset.value + direct.end,
        })
        cursor.value = direct.end
        continue
      }
      const referenceEnd = value[next] === "[" ? close(value, next + 1, "]") : -1
      const reference =
        referenceEnd >= 0 ? value.slice(next + 1, referenceEnd) || alt : value[next] === "[" ? undefined : alt
      const target = reference === undefined ? undefined : refs.get(label(reference))
      if (!target) {
        cursor.value = altEnd + 1
        continue
      }
      const end = referenceEnd >= 0 ? referenceEnd + 1 : altEnd + 1
      output.push({ alt, target, line: row + 1, start: offset.value + cursor.value, end: offset.value + end })
      cursor.value = end
    }
    offset.value += line.raw.length
  }
  return output
}

/** Rewrite parsed images as safe inline Markdown without changing non-image text. */
export function rewriteMarkdownImages(source: string, rewrite: (image: MarkdownImage) => string | undefined) {
  const images = markdownImages(source)
  return images.reduceRight((output, image) => {
    const target = rewrite(image)
    if (!target) return output
    const alt = image.alt.replaceAll("]", "\\]")
    const destination = /[\s()<>]/.test(target) ? `<${target.replaceAll(">", "%3E")}>` : target
    return `${output.slice(0, image.start)}![${alt}](${destination})${output.slice(image.end)}`
  }, source)
}
