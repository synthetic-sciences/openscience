import fs from "fs/promises"
import { readFileSync, existsSync, renameSync } from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"

const app = "openscience"

// Migration shim: installs created before the OpenScience rename kept their
// state under the legacy "synsc" XDG dirs. On boot, if the new dir does not
// exist yet and the legacy one does, move it into place; if the move fails
// (permissions, cross-device), keep reading the legacy dir so nothing is lost.
const legacy = "synsc"

function migrateDir(base: string): string {
  const next = path.join(base, app)
  const old = path.join(base, legacy)
  if (!existsSync(next) && existsSync(old)) {
    try {
      renameSync(old, next)
    } catch {
      return old
    }
  }
  // Both dirs existing means the legacy one was restored (backup, dotfiles)
  // after the new dir was created. It will never be read or migrated — say
  // so instead of silently stranding whatever auth/config lives in it.
  if (existsSync(next) && existsSync(old)) {
    console.error(`openscience: ignoring legacy config at ${old} (${next} already exists) — merge or remove it`)
  }
  return next
}

// Same shim for individual files that carried the legacy name.
function migrateFile(dir: string, oldName: string, newName: string) {
  const next = path.join(dir, newName)
  const old = path.join(dir, oldName)
  if (!existsSync(next) && existsSync(old)) {
    try {
      renameSync(old, next)
    } catch {}
  }
}

const cache = migrateDir(xdgCache!)
const config = migrateDir(xdgConfig!)
const state = migrateDir(xdgState!)

// The data directory can be relocated from settings ▸ Storage. When a pointer
// file exists (config/data-location) we honour it; otherwise the XDG default.
// Read synchronously at boot so every Global.Path.data consumer sees one value.
function resolveDataDir(): string {
  const fallback = migrateDir(xdgData!)
  try {
    const pointer = readFileSync(path.join(config, "data-location"), "utf8").trim()
    return pointer ? path.resolve(pointer) : fallback
  } catch {
    return fallback
  }
}

const data = resolveDataDir()

// Legacy file names inside the migrated dirs (pre-rename releases).
migrateFile(data, "synsci-session.json", "openscience-session.json")
migrateFile(config, "synsc-synced.json", "openscience-synced.json")
migrateFile(config, "synsc.jsonc", "openscience.jsonc")
migrateFile(config, "synsc.json", "openscience.json")

export namespace Global {
  export const Path = {
    // Allow override via OPENSCIENCE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENSCIENCE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

const CACHE_VERSION = "21"

const version = await Bun.file(path.join(Global.Path.cache, "version"))
  .text()
  .catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Bun.file(path.join(Global.Path.cache, "version")).write(CACHE_VERSION)
}
