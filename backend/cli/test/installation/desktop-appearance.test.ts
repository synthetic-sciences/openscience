import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  defaultAppearance,
  mergeAppearance,
  parseAppearance,
  readAppearance,
  resolveAppearance,
  splashQuery,
  writeAppearance,
} from "../../../../frontend/desktop/src/appearance.mjs"

const dark = { background: "#101010", foreground: "#eeeeee" }
const light = { background: "#fafafa", foreground: "#202020" }

test("a System scheme follows the OS appearance at launch", () => {
  const stored = { scheme: "system", theme: "openscience", colors: { dark } }
  expect(resolveAppearance(stored, true)).toEqual({ mode: "dark", ...dark })
  // Never painted light yet: the theme's own light colours, not the dark pair it remembers.
  expect(resolveAppearance(stored, false)).toEqual(defaultAppearance("light"))
  expect(resolveAppearance({ ...stored, colors: { dark, light } }, false)).toEqual({ mode: "light", ...light })
})

test("an explicit scheme paints what it last painted whatever the OS shows", () => {
  const stored = { scheme: "light", theme: "nord", colors: { light, dark } }
  expect(resolveAppearance(stored, true)).toEqual({ mode: "light", ...light })
  expect(resolveAppearance({ ...stored, scheme: "dark" }, false)).toEqual({ mode: "dark", ...dark })
})

test("paints the theme's dark colours before the workspace has ever reported", () => {
  expect(resolveAppearance(undefined, false)).toEqual(defaultAppearance())
  expect(defaultAppearance().mode).toBe("dark")
  expect(splashQuery({ mode: "light", ...light }, "install")).toEqual({ state: "install", scheme: "light", ...light })
})

test("remembers each painted mode and forgets the other mode when the theme changes", () => {
  const report = { mode: "dark", scheme: "system", theme: "openscience", background: "#101010", foreground: "#EEEEEE" }
  const first = mergeAppearance(undefined, report)
  expect(first).toEqual({ scheme: "system", theme: "openscience", colors: { dark } })

  const both = mergeAppearance(first, { ...report, mode: "light", ...light })
  expect(both).toEqual({ scheme: "system", theme: "openscience", colors: { dark, light } })

  const nord = { background: "#2e3440", foreground: "#eceff4" }
  const switched = mergeAppearance(both, { mode: "dark", scheme: "dark", theme: "nord", ...nord })
  expect(switched).toEqual({ scheme: "dark", theme: "nord", colors: { dark: nord } })
})

test("a report without a scheme keeps the painted mode, and unusable colours are left out", () => {
  const painted = mergeAppearance(undefined, { mode: "dark", scheme: null, theme: undefined, ...dark })
  expect(painted).toEqual({ scheme: "dark", theme: "openscience", colors: { dark } })

  const odd = {
    mode: "light",
    scheme: "system",
    theme: "openscience",
    background: "rgb(1, 2, 3)",
    foreground: "#202020",
  }
  const kept = mergeAppearance(painted, odd)
  expect(kept).toEqual({ scheme: "system", theme: "openscience", colors: { dark } })
  expect(resolveAppearance(kept, false)).toEqual(defaultAppearance("light"))

  expect(mergeAppearance(undefined, undefined)).toBeUndefined()
  expect(mergeAppearance(undefined, { mode: "sepia", scheme: "system", theme: "openscience", ...dark })).toBeUndefined()
})

test("round-trips through the appearance file and ignores one it cannot use", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openscience-appearance-"))
  try {
    const file = path.join(dir, "nested", "appearance.json")
    expect(await readAppearance(file)).toBeUndefined()

    const record = {
      scheme: "system",
      theme: "openscience",
      colors: { dark, light: { ...light, background: "white" } },
    }
    await writeAppearance(file, record)
    expect(await readAppearance(file)).toEqual({ scheme: "system", theme: "openscience", colors: { dark } })

    await Bun.write(file, "{not json")
    expect(await readAppearance(file)).toBeUndefined()
    await Bun.write(file, JSON.stringify({ mode: "light", ...light }))
    expect(await readAppearance(file)).toBeUndefined()
    expect(parseAppearance({ scheme: "dark" })).toEqual({ scheme: "dark", theme: "openscience", colors: {} })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
