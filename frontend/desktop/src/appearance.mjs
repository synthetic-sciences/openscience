import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const HEX = /^#[0-9a-f]{6}$/i
// background-base and text-strong of the workspace's default theme
// (frontend/ui/src/theme/themes/openscience.json); frontend/ui's theme test
// keeps the two in step.
const theme = JSON.parse(readFileSync(new URL("./splash/theme.json", import.meta.url), "utf8"))

/** The colours the shell paints before the workspace has ever reported its own. */
export function defaultAppearance(mode = "dark") {
  const known = mode === "light" ? "light" : "dark"
  return { mode: known, background: theme[known]["background-base"], foreground: theme[known]["text-strong"] }
}

/** What the workspace reported, each colour falling back to the theme when it is not an opaque hex. */
export function parseAppearance(value) {
  if (!value || typeof value !== "object") return
  const base = defaultAppearance(value.mode)
  return {
    mode: base.mode,
    background: HEX.test(value.background) ? value.background.toLowerCase() : base.background,
    foreground: HEX.test(value.foreground) ? value.foreground.toLowerCase() : base.foreground,
  }
}

export async function readAppearance(file) {
  const stored = await readFile(file, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return parseAppearance(stored) ?? defaultAppearance()
}

export async function writeAppearance(file, value) {
  const parsed = parseAppearance(value)
  if (!parsed) return
  // Written beside and renamed over, so a quit mid-write leaves the last good file.
  const partial = `${file}.${process.pid}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(partial, JSON.stringify(parsed)))
    .then(() => rename(partial, file))
    .catch(() => undefined)
}

/** The splash page reads its state and colours from its URL and holds no palette itself. */
export function splashQuery(appearance, state) {
  return { state, scheme: appearance.mode, background: appearance.background, foreground: appearance.foreground }
}
