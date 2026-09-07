import { describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dict as en } from "./en"
import { dict as uiEn } from "@synsci/ui/i18n/en"

// The translators fall back to English for any key a locale lacks, so English
// is the one dictionary every referenced key must exist in. Keys assembled at
// runtime from template strings are typed against the dictionary instead.
const roots = ["..", "../../../ui/src"].map((relative) => fileURLToPath(new URL(relative, import.meta.url)))

function sources(dir: string, into: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "i18n") sources(path, into)
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) into.push(path)
  }
  return into
}

describe("interface copy keys", () => {
  test('every key referenced by t("…") in the workspace and ui sources exists in English', async () => {
    const known = new Set([...Object.keys(en), ...Object.keys(uiEn)])
    const missing: string[] = []
    let references = 0
    for (const file of roots.flatMap((root) => sources(root))) {
      const text = await Bun.file(file).text()
      for (const match of text.matchAll(/\bt\(\s*(["'])([^"'\n]+)\1/g)) {
        references++
        if (!known.has(match[2])) missing.push(`${file}: ${match[2]}`)
      }
    }
    expect(references).toBeGreaterThan(100)
    expect(missing).toEqual([])
  })
})
