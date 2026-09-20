import { base64Encode } from "@synsci/util/encode"
import fs from "node:fs/promises"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Log } from "../util/log"

const log = Log.create({ service: "local-server" })

const DEFAULT_LOCAL_PORT = 4096
const FALLBACK_LOCAL_PORT = 4097
export const LOCAL_WORKSPACE_PORTS = [DEFAULT_LOCAL_PORT, FALLBACK_LOCAL_PORT] as const

export function localServerBase(port = DEFAULT_LOCAL_PORT) {
  return `http://localhost:${port}`
}

export function localWorkspaceUrl(base: string, directory?: string) {
  if (!directory) return base
  return `${base}/${base64Encode(directory)}/session`
}

/**
 * `runId` is the server's own per-process identity (`ServerIdentity.current`),
 * which `/global/health` already reports. Passing one turns the probe from
 * "something healthy answers here" into "the exact process that claimed this
 * port answers here", so a record naming a port this process never listened on
 * is inert.
 */
export function probeLocalServer(base: string, runId?: string, timeout = 1200) {
  return fetch(`${base}/global/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  })
    .then(async (response) => {
      if (!response.ok) return false
      const body = await response.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) return false
      if (!("healthy" in body) || body.healthy !== true) return false
      if (!("version" in body) || typeof body.version !== "string") return false
      if (runId === undefined) return true
      return "runId" in body && body.runId === runId
    })
    .catch(() => false)
}

/**
 * A healthy API listener is not necessarily a browser workspace. Source/eval
 * servers deliberately expose `/global/health` without bundled web assets, and
 * an older packaged server can survive an upgrade. The launcher must only
 * reuse a server that proves it owns a matching workspace bundle.
 */
export async function probeWorkspaceServer(base: string, version: string, runId?: string, timeout = 1200) {
  const healthy = await probeLocalServer(base, runId, timeout)
  if (!healthy) return false
  // `version.json` is a file in the workspace bundle, not an API route, and
  // the server answers an API-shaped request (`accept: application/json`) for
  // an unmatched route with a JSON 404 before it ever looks at the bundle. Ask
  // for the file the way a browser would, or every probe fails and each launch
  // starts another server.
  return fetch(`${base}/version.json`, {
    headers: { accept: "*/*" },
    signal: AbortSignal.timeout(timeout),
  })
    .then(async (response) => {
      if (!response.ok) return false
      const body = await response.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) return false
      return "version" in body && body.version === version && "channel" in body && typeof body.channel === "string"
    })
    .catch(() => false)
}

/**
 * The desktop app starts its sidecar on a random port, so the stable ports
 * below never find it and a terminal launch would start a second server beside
 * the app. The sidecar advertises itself in the data root both entry points
 * already share; this is the file it writes.
 */
export const DESKTOP_SERVER_FILE = "desktop-server.json"

export type DesktopServerRecord = {
  schema: 1
  port: number
  pid: number
  version: string
  /** The advertiser's own `ServerIdentity.current.runId`. A reader accepts the
   *  advertised port only when the server listening there reports this exact
   *  id, so nothing but the process that wrote the record can answer for it. */
  run_id: string
  started_at: string
}

function desktopServerPath(directory: string) {
  return path.join(directory, DESKTOP_SERVER_FILE)
}

/** A record left behind by a killed or crashed sidecar names a pid that is
 *  gone. EPERM is another user's live process, not a dead one. */
function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** The pid that owns `desktop-server.json.<pid>.tmp`, for the names this module
 *  writes and no others. */
function temporaryOwner(entry: string) {
  if (!entry.startsWith(`${DESKTOP_SERVER_FILE}.`) || !entry.endsWith(".tmp")) return
  const owner = entry.slice(DESKTOP_SERVER_FILE.length + 1, -".tmp".length)
  return /^\d+$/.test(owner) ? Number(owner) : undefined
}

/** A kill between the write and the rename orphans a temporary file that
 *  nothing would ever clean up. Sweep the ones whose writer is gone; another
 *  sidecar's in-flight temporary is left where it is. */
async function sweepTemporaries(directory: string, pid: number) {
  const entries = await fs.readdir(directory).catch(() => [])
  await Promise.all(
    entries.map((entry) => {
      const owner = temporaryOwner(entry)
      if (owner === undefined || (owner !== pid && running(owner))) return
      return fs.rm(path.join(directory, entry), { force: true }).catch(() => undefined)
    }),
  )
}

/** Publish the desktop sidecar's port for terminal launches. Best effort: a
 *  read-only or full data root must not stop the app's server from serving. */
export async function advertiseDesktopServer(
  directory: string,
  input: { port: number; pid: number; version: string; runId: string },
) {
  const file = desktopServerPath(directory)
  const temporary = `${file}.${input.pid}.tmp`
  const record: DesktopServerRecord = {
    schema: 1,
    port: input.port,
    pid: input.pid,
    version: input.version,
    run_id: input.runId,
    started_at: new Date().toISOString(),
  }
  await sweepTemporaries(directory, input.pid)
  await Bun.write(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    .then(() => fs.rename(temporary, file))
    .catch(async (error) => {
      // The app's server still serves; only terminal launches lose the
      // shortcut to it, which is invisible without a line saying why.
      log.warn("desktop server advertisement failed", { file, error })
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    })
}

/** Withdraw the advertisement, unless a newer sidecar already replaced it: a
 *  slow exit must not unadvertise the app's next server. Synchronous, because
 *  the only moment that survives every shutdown path — including the immediate
 *  `process.exit` the kernel signal hooks perform on SIGTERM — is an `exit`
 *  handler. Best effort, like the write side: a concurrent withdrawal from a
 *  second sidecar, a permission change, or a relocatable data root that went
 *  away must not throw out of an `exit` handler and change the process's exit
 *  code. */
export function withdrawDesktopServer(directory: string, pid: number) {
  const file = desktopServerPath(directory)
  try {
    if (!existsSync(file)) return
    const contents = readFileSync(file, "utf8")
    const record = parseDesktopServer(contents)
    if (record && record.pid !== pid) return
    // A record this build cannot read is still someone's: a newer sidecar
    // writing a schema from the future owns its own withdrawal. Only bytes
    // that are not JSON at all belong to nobody, and those would otherwise sit
    // in the data root forever, shadowing every later advertisement.
    if (!record && isJson(contents)) return
    rmSync(file, { force: true })
  } catch {
    // Nothing to withdraw if we can no longer read or remove the file.
  }
}

function isJson(contents: string) {
  try {
    JSON.parse(contents)
    return true
  } catch {
    return false
  }
}

function parseDesktopServer(contents: string | undefined) {
  const record = (() => {
    try {
      return contents === undefined ? undefined : (JSON.parse(contents) as unknown)
    } catch {
      return undefined
    }
  })()
  if (!record || typeof record !== "object" || Array.isArray(record)) return
  const value = record as Partial<DesktopServerRecord>
  const port = typeof value.port === "number" ? value.port : undefined
  const pid = typeof value.pid === "number" ? value.pid : undefined
  if (value.schema !== 1) return
  if (port === undefined || !Number.isSafeInteger(port) || port < 1 || port > 65535) return
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return
  if (typeof value.version !== "string" || !value.version) return
  if (typeof value.run_id !== "string" || !value.run_id) return
  if (typeof value.started_at !== "string" || !value.started_at) return
  return value as DesktopServerRecord
}

export async function readDesktopServer(directory: string) {
  return parseDesktopServer(
    await Bun.file(desktopServerPath(directory))
      .text()
      .catch(() => undefined),
  )
}

/** The advertised port, once the process behind it proves it is the live
 *  workspace that advertised it. A record whose process is gone, whose version
 *  has moved on, whose port does not answer, or whose port answers as a
 *  different server run is ignored, so the caller falls through to the stable
 *  ports. */
export async function findDesktopServer(version: string, directory: string) {
  const record = await readDesktopServer(directory)
  if (!record || record.version !== version || !running(record.pid)) return
  const match = await probeWorkspaceServer(localServerBase(record.port), version, record.run_id)
  return match ? record.port : undefined
}

export async function findWorkspaceServer(
  version: string,
  ports: readonly number[] = LOCAL_WORKSPACE_PORTS,
  directory?: string,
) {
  const desktop = directory ? await findDesktopServer(version, directory) : undefined
  if (desktop) return desktop
  const matches = await Promise.all(
    ports.map(async (port) => ({ port, match: await probeWorkspaceServer(localServerBase(port), version) })),
  )
  return matches.find((candidate) => candidate.match)?.port
}
