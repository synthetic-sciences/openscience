import path from "node:path"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"

/**
 * Proof that a person, not an agent process, opened the terminal tab.
 *
 * A launcher the person started (the CLI's `web` command, the desktop app)
 * mints a one-time code and opens the workspace with it in the URL fragment.
 * The workspace trades it once for a key held in an HttpOnly cookie. Host
 * terminals require that key; without it a terminal stays sandboxed.
 *
 * Only hashes are stored. The store lives in the data root and is listed in
 * `OpenScience.kernelSensitivePaths`, so sandboxed processes cannot read it.
 * With the sandbox off an agent runs with the person's full permissions and
 * this proof no longer separates them; that mode is out of scope.
 */
export namespace TerminalKey {
  /** A code opened by a launcher is spent within seconds. */
  export const CODE_TTL = 120_000
  /** The desktop app hands its code to the server before the window loads,
   *  and a first start can run migrations before the page asks for it. */
  export const DESKTOP_CODE_TTL = 15 * 60_000
  export const KEY_TTL = 30 * 24 * 60 * 60_000
  /** Removed from `process.env` once read; its prefix is already withheld
   *  from every child process by `filterControlPlaneEnv`. */
  export const DESKTOP_CODE_ENV = "OPENSCIENCE_DESKTOP_PARENT_TERMINAL_CODE"

  type Entry = { hash: string; expires: number }
  type Store = { codes: Entry[]; keys: Entry[] }

  export function filepath() {
    return path.join(Global.Path.data, "terminal-keys.json")
  }

  /** Browsers share cookies across ports on one host; a dev and a release
   *  server on localhost must not share keys. */
  export function cookieName(port: string | number) {
    return `openscience_terminal_${port}`
  }

  const hash = (value: string) => createHash("sha256").update(value).digest("hex")

  const live = (entries: unknown, now: number): Entry[] =>
    Array.isArray(entries)
      ? entries.filter(
          (entry): entry is Entry =>
            typeof entry?.hash === "string" && typeof entry?.expires === "number" && entry.expires > now,
        )
      : []

  const matches = (entries: Entry[], digest: string) => {
    const wanted = Buffer.from(digest, "hex")
    // Compare every entry so the time taken does not reveal which one matched.
    return entries.reduce((found, entry) => {
      const stored = Buffer.from(entry.hash, "hex")
      return (stored.length === wanted.length && timingSafeEqual(stored, wanted)) || found
    }, false)
  }

  async function update(fn: (store: Store, now: number) => void) {
    await JsonStore.update(filepath(), (data) => {
      const now = Date.now()
      const store = { codes: live(data.codes, now), keys: live(data.keys, now) }
      fn(store, now)
      return store
    })
  }

  /** Register a launcher's code. Returns the code to put in the URL fragment. */
  export async function mintCode(ttl = CODE_TTL) {
    const code = randomBytes(32).toString("base64url")
    await adoptCode(code, ttl)
    return code
  }

  /** Register a code minted by another process (the desktop app). */
  export async function adoptCode(code: string, ttl = CODE_TTL) {
    if (code.length < 32) throw new Error("Terminal launch code is too short")
    await update((store, now) => {
      store.codes.push({ hash: hash(code), expires: now + ttl })
    })
  }

  /** Read and forget the desktop app's code, if this server was given one. */
  export async function adoptDesktopCode(env: NodeJS.ProcessEnv = process.env) {
    const code = env[DESKTOP_CODE_ENV]
    delete env[DESKTOP_CODE_ENV]
    if (!code) return false
    await adoptCode(code, DESKTOP_CODE_TTL)
    return true
  }

  /** Spend a code once and mint the key that replaces it. */
  export async function exchange(code: string) {
    const digest = hash(code)
    const key = randomBytes(32).toString("base64url")
    let spent = false
    await update((store, now) => {
      if (!matches(store.codes, digest)) return
      store.codes = store.codes.filter((entry) => entry.hash !== digest)
      store.keys.push({ hash: hash(key), expires: now + KEY_TTL })
      spent = true
    })
    return spent ? key : undefined
  }

  export async function valid(key: string | undefined) {
    if (!key) return false
    const data = await JsonStore.read(filepath()).catch(() => ({}) as Record<string, unknown>)
    return matches(live(data.keys, Date.now()), hash(key))
  }

  /** Forget every key and pending code; open tabs fall back on their next connect. */
  export async function forget() {
    await update((store) => {
      store.codes = []
      store.keys = []
    })
  }
}
