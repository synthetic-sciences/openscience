import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = fileURLToPath(new URL("../", import.meta.url))

const cssFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : []
  })

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "")

const tokenRadius = String.raw`var\(--radius-(?:xs|sm|md|lg|xl)\)`
const semanticRadius = new RegExp(String.raw`^(?:0|50%|${tokenRadius})(?:\s+(?:0|50%|${tokenRadius}))*$`)

describe("shared UI radius contract", () => {
  test("uses the shared ladder outside documented scrollbar micro-geometry", () => {
    const violations: string[] = []
    const scrollbarExceptions: string[] = []

    for (const file of cssFiles(sourceRoot)) {
      const name = relative(sourceRoot, file)
      let source = stripComments(readFileSync(file, "utf8"))

      if (name === "styles/tailwind/utilities.css") {
        source = source.replace(
          /&::-webkit-scrollbar-(track|thumb)\s*\{[^{}]*?border-radius:\s*2px;[^{}]*?\}/g,
          (block, part: string) => {
            scrollbarExceptions.push(part)
            return block.replace("border-radius: 2px", "border-radius: var(--radius-xs)")
          },
        )
      }

      for (const match of source.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;{}]+)/g)) {
        const value = match[1]!.trim()
        if (semanticRadius.test(value)) continue

        const line = source.slice(0, match.index).split("\n").length
        violations.push(`${name}:${line}: ${value}`)
      }
    }

    // The 10px Tailwind scrollbar uses a 3px transparent inset. Its 2px track
    // and thumb corners are rendering mechanics, not component geometry.
    expect(scrollbarExceptions.sort()).toEqual(["thumb", "track"])
    expect(violations).toEqual([])
  })
})
