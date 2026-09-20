import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  appearanceTempFile,
  defaultAppearance,
  mergeAppearance,
  parseAppearance,
  readAppearance,
  resolveAppearance,
  saveAppearance,
  splashQuery,
  sweepAppearance,
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

test("stages every write under its own name, so overlapping writes cannot share one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openscience-appearance-"))
  try {
    const file = path.join(dir, "appearance.json")
    const staged = new Set([appearanceTempFile(file), appearanceTempFile(file), appearanceTempFile(file)])
    expect(staged.size).toBe(3)
    for (const name of staged) {
      expect(path.dirname(name)).toBe(dir)
      expect(name.startsWith(`${file}.${process.pid}.`)).toBe(true)
      expect(name.endsWith(".tmp")).toBe(true)
    }

    // A theme change landing while the window closes is two writes at once.
    const records = [
      { scheme: "system", theme: "openscience", colors: { dark } },
      { scheme: "light", theme: "nord", colors: { light } },
      { scheme: "dark", theme: "openscience", colors: { dark, light } },
    ]
    await Promise.all(records.map((record) => writeAppearance(file, record)))
    const stored = await readAppearance(file)
    expect(records.some((record) => Bun.deepEquals(record, stored))).toBe(true)
    // Nothing half-written is left behind for the next launch to trip over.
    expect(await readdir(dir)).toEqual(["appearance.json"])

    // A kill between write and rename leaves one, and no later write reclaims
    // a name it will never use again: the next launch sweeps it.
    await Bun.write(appearanceTempFile(file), "{}")
    await Bun.write(path.join(dir, "notes.txt"), "kept")
    expect(await sweepAppearance(file)).toBe(1)
    expect((await readdir(dir)).sort()).toEqual(["appearance.json", "notes.txt"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("keeps what the workspace reports, and keeps the last good record when it reports nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openscience-appearance-"))
  try {
    const file = path.join(dir, "appearance.json")
    const painted = await saveAppearance(file, undefined, {
      mode: "dark",
      scheme: "system",
      theme: "openscience",
      ...dark,
    })
    expect(painted).toEqual({ scheme: "system", theme: "openscience", colors: { dark } })
    expect(await readAppearance(file)).toEqual(painted)

    // The OS flipped and the workspace repainted: the other mode joins it.
    const both = await saveAppearance(file, painted, {
      mode: "light",
      scheme: "system",
      theme: "openscience",
      ...light,
    })
    expect(both).toEqual({ scheme: "system", theme: "openscience", colors: { dark, light } })
    expect(await readAppearance(file)).toEqual(both)

    // A window torn down mid-read answers nothing; the file keeps what it had.
    expect(await saveAppearance(file, both, undefined)).toEqual(both)
    expect(await readAppearance(file)).toEqual(both)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
