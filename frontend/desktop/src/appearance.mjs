import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

const HEX = /^#[0-9a-f]{6}$/i
const MODES = ["light", "dark"]
const SCHEMES = ["system", "light", "dark"]
// background-base and text-strong of the workspace's default theme
// (frontend/ui/src/theme/themes/openscience.json); the "desktop splash" tests
// in frontend/ui/src/components/atom-loader.test.ts keep the two in step.
const theme = JSON.parse(readFileSync(new URL("./splash/theme.json", import.meta.url), "utf8"))

const colours = (value) =>
  HEX.test(value?.background) && HEX.test(value?.foreground)
    ? { background: value.background.toLowerCase(), foreground: value.foreground.toLowerCase() }
    : undefined

/** The colours the shell paints before the workspace has ever reported its own. */
export function defaultAppearance(mode = "dark") {
  const known = mode === "light" ? "light" : "dark"
  return { mode: known, background: theme[known]["background-base"], foreground: theme[known]["text-strong"] }
}

/**
 * The stored record: the user's scheme choice, the theme it was made in and
 * the colours the workspace painted in each mode it has run in. Colours that
 * are not opaque hex are dropped rather than repaired, so a mode with no usable
 * pair falls back to the theme file when it is resolved.
 */
export function parseAppearance(value) {
  if (!value || typeof value !== "object" || !SCHEMES.includes(value.scheme)) return
  const colors = {}
  for (const mode of MODES) {
    const known = colours(value.colors?.[mode])
    if (known) colors[mode] = known
  }
  return { scheme: value.scheme, theme: typeof value.theme === "string" ? value.theme : "openscience", colors }
}

/**
 * Folds what the mounted workspace reported into the record: the painted
 * mode's colours are kept per mode, so a System user who has run in both
 * keeps both, and a theme change forgets the other mode's colours because
 * they belonged to the old theme.
 */
export function mergeAppearance(previous, reported) {
  if (!reported || typeof reported !== "object" || !MODES.includes(reported.mode)) return
  const scheme = SCHEMES.includes(reported.scheme) ? reported.scheme : reported.mode
  const theme = typeof reported.theme === "string" && reported.theme ? reported.theme : "openscience"
  const kept = previous?.theme === theme ? previous.colors : {}
  const painted = colours(reported)
  return { scheme, theme, colors: painted ? { ...kept, [reported.mode]: painted } : { ...kept } }
}

/**
 * The colours to paint at launch. An explicit scheme paints what it last
 * painted; System follows the OS as it is now (`nativeTheme.shouldUseDarkColors`),
 * so a launch after the system switched appearance opens in the mode the
 * workspace is about to use, on the remembered colours for that mode when it
 * has run in it and on the theme's own otherwise.
 */
export function resolveAppearance(stored, systemDark) {
  if (!stored) return defaultAppearance()
  const mode = stored.scheme === "system" ? (systemDark ? "dark" : "light") : stored.scheme
  return { mode, ...(stored.colors[mode] ?? defaultAppearance(mode)) }
}

export async function readAppearance(file) {
  const stored = await readFile(file, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return parseAppearance(stored)
}

/**
 * Removes the staging files a kill between write and rename left behind. Names
 * are unique per write, so nothing reclaims them on its own; the launch that
 * reads the record is the moment no write is in flight.
 */
export async function sweepAppearance(file) {
  const prefix = `${path.basename(file)}.`
  const stale = await readdir(path.dirname(file))
    .then((entries) => entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp")))
    .catch(() => [])
  await Promise.all(stale.map((entry) => unlink(path.join(path.dirname(file), entry)).catch(() => undefined)))
  return stale.length
}

/**
 * Where one write stages its bytes. Unique per write, not per process: a theme
 * change while the window is closing gives one process two writes at once, and
 * a shared name lets the second truncate the file the first is about to rename.
 */
export function appearanceTempFile(file) {
  return `${file}.${process.pid}.${randomUUID()}.tmp`
}

export async function writeAppearance(file, value) {
  const parsed = parseAppearance(value)
  if (!parsed) return
  // Written beside and renamed over, so a quit mid-write leaves the last good file.
  const partial = appearanceTempFile(file)
  await mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(partial, JSON.stringify(parsed)))
    .then(() => rename(partial, file))
    .catch(() => unlink(partial).catch(() => undefined))
}

/**
 * Folds a report from the workspace into the stored record and keeps it. The
 * shell calls this whenever the workspace repaints -- once it has mounted, when
 * its theme colour changes, and again before the window or the app goes away --
 * so a mid-session theme change survives even though the last of those races
 * the quit.
 */
export async function saveAppearance(file, previous, reported) {
  const next = mergeAppearance(previous, reported)
  if (!next) return previous
  await writeAppearance(file, next)
  return next
}

/** The splash page reads its state and colours from its URL and holds no palette itself. */
export function splashQuery(appearance, state) {
  return { state, scheme: appearance.mode, background: appearance.background, foreground: appearance.foreground }
}
