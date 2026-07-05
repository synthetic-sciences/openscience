/**
 * Dev-only Vite middleware that turns a `showDirectoryPicker` result
 * (folder name only, plus a fingerprint of its child names) into an
 * absolute path. We delegate the actual filesystem walk to the openscience
 * backend at :4096 — only openscience needs Full Disk Access on macOS, and
 * the user usually has it granted to that binary.
 *
 * Routes:
 *   GET  /api/resolve-folder/probe           — does openscience see ~/Desktop?
 *   POST /api/resolve-folder { name, hint, children? }
 */

import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"

const HOME = os.homedir()

const OPENSCIENCE_BASE = "http://localhost:4096"
const HEADER = "x-openscience-directory"

const SEARCH_ROOTS = [
  HOME,
  `${HOME}/Desktop`,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Projects`,
  `${HOME}/Code`,
  `${HOME}/code`,
  `${HOME}/src`,
  `${HOME}/dev`,
  `${HOME}/work`,
  `${HOME}/repos`,
  `${HOME}/github`,
  `${HOME}/conductor`,
  "/Volumes",
  "/tmp",
]

const MAX_DEPTH = 6
const MAX_CANDIDATES = 200
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  "dist",
  "build",
  ".idea",
  ".vscode",
  "Library",
])

function authHeaders(headers = {}) {
  const password = process.env.OPENSCIENCE_SERVER_PASSWORD
  if (!password) return headers
  const username = process.env.OPENSCIENCE_SERVER_USERNAME || "openscience"
  return {
    ...headers,
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  }
}

async function openscienceList(directory) {
  try {
    const url = `${OPENSCIENCE_BASE}/file?directory=${encodeURIComponent(directory)}&path=.`
    const res = await fetch(url, { headers: authHeaders({ [HEADER]: directory }) })
    if (!res.ok) {
      const fallback = await nodeList(directory)
      if (fallback.ok) return fallback
      return { ok: false, error: `openscience ${res.status}` }
    }
    const data = await res.json()
    if (!Array.isArray(data)) return { ok: false, error: "non-array" }
    return {
      ok: true,
      entries: data
        .filter((n) => n?.type === "directory" && !SKIP_DIRS.has(n.name))
        .map((n) => ({ name: String(n.name), absolute: String(n.absolute ?? "") })),
      childNames: new Set(data.map((n) => n?.name).filter(Boolean)),
    }
  } catch (e) {
    const fallback = await nodeList(directory)
    if (fallback.ok) return fallback
    return { ok: false, error: String(e?.message ?? e) }
  }
}

async function nodeList(directory) {
  try {
    const data = await fs.readdir(directory, { withFileTypes: true })
    return {
      ok: true,
      entries: data
        .filter((n) => n.isDirectory() && !SKIP_DIRS.has(n.name))
        .map((n) => ({ name: n.name, absolute: path.join(directory, n.name) })),
      childNames: new Set(data.map((n) => n.name).filter(Boolean)),
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

async function probe() {
  // openscience lists the parent fine but TCC blocks ~/Desktop unless the
  // openscience binary has Full Disk Access. We treat "0 entries on Desktop"
  // as the user's Desktop being unreachable.
  const desktop = `${HOME}/Desktop`
  const r = await openscienceList(desktop)
  if (!r.ok) return { fda: false, reason: r.error }
  const fda = r.entries.length > 0
  return { fda, reason: fda ? undefined : "openscience returned 0 entries for ~/Desktop (TCC blocking)" }
}

function score(candidate, hint, fingerprint) {
  let s = 1
  if (hint && candidate.childNames?.has(hint)) s += 50
  if (fingerprint && fingerprint.length > 0) {
    const matches = fingerprint.filter((n) => candidate.childNames?.has(n)).length
    s += matches * 10
  }
  return s
}

async function findByName(name, hint, fingerprint) {
  const candidates = []
  for (const root of SEARCH_ROOTS) {
    const rootList = await openscienceList(root)
    if (!rootList.ok) continue
    const queue = [{ path: root, depth: 0, list: rootList }]
    while (queue.length > 0 && candidates.length < MAX_CANDIDATES) {
      const cur = queue.shift()
      if (!cur || cur.depth > MAX_DEPTH) continue
      for (const d of cur.list.entries) {
        const full = d.absolute || `${cur.path}/${d.name}`
        if (d.name === name) {
          // Fetch this candidate's children and score it.
          const inner = await openscienceList(full)
          if (inner.ok) {
            const sc = score(inner, hint, fingerprint)
            candidates.push({ path: full, score: sc, depth: cur.depth + 1 })
            if (sc >= 50) {
              // Strong hint match — keep going but don't queue this one
              // for sub-walking, no point.
              continue
            }
          }
        }
        // Enqueue children for further walking.
        const next = await openscienceList(full)
        if (next.ok) queue.push({ path: full, depth: cur.depth + 1, list: next })
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.depth - b.depth)
  return candidates
}

async function readBody(req) {
  return await new Promise((resolveP, rejectP) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => resolveP(data))
    req.on("error", rejectP)
  })
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

function run(command, args) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk.toString()))
    child.stderr.on("data", (chunk) => (err += chunk.toString()))
    child.on("error", rejectP)
    child.on("close", (code) => {
      if (code === 0) {
        resolveP(out.trim())
        return
      }
      rejectP(new Error(err.trim() || `${command} exited ${code}`))
    })
  })
}

async function openNativeDialog() {
  if (process.platform === "darwin") {
    const script = ['set picked to choose folder with prompt "Open project folder"', "POSIX path of picked"]
    const out = await run(
      "osascript",
      script.flatMap((item) => ["-e", item]),
    )
    const folder = String(out || "")
      .trim()
      .replace(/\/+$/, "")
    return folder ? { paths: [folder] } : { paths: [] }
  }
  return { unsupported: true, message: `native dialog unsupported on ${process.platform}` }
}

function expandPath(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  const withoutFileUrl = raw.startsWith("file://") ? decodeURIComponent(new URL(raw).pathname) : raw
  if (withoutFileUrl === "~") return HOME
  if (withoutFileUrl.startsWith("~/")) return path.join(HOME, withoutFileUrl.slice(2))
  return path.resolve(withoutFileUrl)
}

async function validatePath(input) {
  const absolute = expandPath(input)
  if (!absolute) return { ok: false, error: "path required" }
  const stat = await fs.stat(absolute).catch(() => undefined)
  if (!stat) return { ok: false, absolute, error: "path not found" }
  if (!stat.isDirectory()) return { ok: false, absolute, error: "path is not a directory" }
  const real = await fs.realpath(absolute).catch(() => absolute)
  const listed = await openscienceList(real)
  return {
    ok: true,
    absolute: real,
    readable: listed.ok,
    entries: listed.ok ? listed.entries.length : 0,
    warning: listed.ok ? undefined : listed.error,
  }
}

async function handle(req, res) {
  const url = (req.url || "/").split("?")[0]
  if (url.endsWith("/probe")) {
    const r = await probe()
    return send(res, 200, r)
  }
  if (url.endsWith("/dialog")) {
    try {
      const r = await openNativeDialog()
      return send(res, r.unsupported ? 501 : 200, r)
    } catch (e) {
      const message = String(e?.message ?? e)
      const cancelled = /User canceled|cancelled/i.test(message)
      return send(res, cancelled ? 499 : 500, { error: cancelled ? "cancelled" : message })
    }
  }
  if (url.endsWith("/validate")) {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" })
    try {
      const body = JSON.parse((await readBody(req)) || "{}")
      const result = await validatePath(body.path)
      return send(res, result.ok ? 200 : 400, result)
    } catch (e) {
      return send(res, 400, { ok: false, error: String(e?.message ?? e) })
    }
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "POST only" })
  }
  let body
  try {
    body = JSON.parse((await readBody(req)) || "{}")
  } catch {
    return send(res, 400, { error: "invalid json" })
  }
  const name = String(body.name ?? "").trim()
  const hint = body.hint ? String(body.hint).trim() : ""
  // `children` = array of immediate child names the browser walked from
  // the picked handle. Used as a stronger disambiguator than a single hint.
  const fingerprint = Array.isArray(body.children) ? body.children.map(String).filter(Boolean).slice(0, 16) : []
  if (!name || /\//.test(name)) {
    return send(res, 400, { error: "name required (no slashes)" })
  }
  const candidates = await findByName(name, hint, fingerprint)
  return send(res, 200, {
    candidates: candidates.slice(0, 10).map((c) => ({ path: c.path, score: c.score })),
    best: candidates[0]?.path ?? null,
  })
}

export default {
  name: "folder-resolve",
  configureServer(server) {
    server.middlewares.use("/api/resolve-folder", (req, res, next) => {
      handle(req, res).catch(next)
    })
  },
}
