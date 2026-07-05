/**
 * Folder picker support endpoints used by the openscience web UI.
 *
 * Originally implemented as a Vite dev-server middleware
 * (`frontend/workspace/vite-folder-resolve.js`). When `openscience web` proxied the
 * SPA from Vercel these endpoints never existed there either — the SPA
 * relied on graceful failure. Now that the SPA is served locally we need
 * to answer these calls so the Finder-style picker can validate a path
 * and the "couldn't auto-resolve" toast goes away.
 *
 * Routes (all under `/api/resolve-folder`):
 *   GET  /probe              — can we list ~/Desktop? (mac FDA check)
 *   GET  /dialog             — open OS-native folder dialog (mac only)
 *   POST /validate           — { path } → resolved absolute path
 *   POST /                   — { name, hint?, children? } → best candidate
 */

import { Hono } from "hono"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { lazy } from "../../util/lazy"

const HOME = os.homedir()

const SEARCH_ROOTS = [
  HOME,
  path.join(HOME, "Desktop"),
  path.join(HOME, "Documents"),
  path.join(HOME, "Downloads"),
  path.join(HOME, "Projects"),
  path.join(HOME, "Code"),
  path.join(HOME, "code"),
  path.join(HOME, "src"),
  path.join(HOME, "dev"),
  path.join(HOME, "work"),
  path.join(HOME, "repos"),
  path.join(HOME, "github"),
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

interface ListResult {
  ok: boolean
  entries?: { name: string; absolute: string }[]
  childNames?: Set<string>
  error?: string
}

async function listDirectory(dir: string): Promise<ListResult> {
  try {
    const data = await fs.readdir(dir, { withFileTypes: true })
    return {
      ok: true,
      entries: data
        .filter((n) => n.isDirectory() && !SKIP_DIRS.has(n.name))
        .map((n) => ({ name: n.name, absolute: path.join(dir, n.name) })),
      childNames: new Set(data.map((n) => n.name)),
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

function expandPath(input: unknown): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  const withoutFileUrl = raw.startsWith("file://") ? decodeURIComponent(new URL(raw).pathname) : raw
  if (withoutFileUrl === "~") return HOME
  if (withoutFileUrl.startsWith("~/")) return path.join(HOME, withoutFileUrl.slice(2))
  return path.resolve(withoutFileUrl)
}

function score(candidate: ListResult, hint: string, fingerprint: string[]): number {
  let s = 1
  if (hint && candidate.childNames?.has(hint)) s += 50
  if (fingerprint.length > 0) {
    const matches = fingerprint.filter((n) => candidate.childNames?.has(n)).length
    s += matches * 10
  }
  return s
}

const FIND_TIMEOUT_MS = 3000
const STRONG_MATCH_SCORE = 50

async function findByName(name: string, hint: string, fingerprint: string[]) {
  const candidates: { path: string; score: number; depth: number }[] = []
  const deadline = Date.now() + FIND_TIMEOUT_MS

  const expired = () => Date.now() > deadline
  const hasStrongMatch = () => candidates.some((c) => c.score >= STRONG_MATCH_SCORE)

  for (const root of SEARCH_ROOTS) {
    if (expired() || hasStrongMatch()) break
    const rootList = await listDirectory(root)
    if (!rootList.ok) continue
    const queue: { path: string; depth: number; list: ListResult }[] = [{ path: root, depth: 0, list: rootList }]
    while (queue.length > 0 && candidates.length < MAX_CANDIDATES) {
      if (expired() || hasStrongMatch()) break
      const cur = queue.shift()
      if (!cur || cur.depth > MAX_DEPTH) continue
      for (const d of cur.list.entries ?? []) {
        if (expired()) break
        if (d.name === name) {
          const inner = await listDirectory(d.absolute)
          if (inner.ok) {
            const sc = score(inner, hint, fingerprint)
            candidates.push({ path: d.absolute, score: sc, depth: cur.depth + 1 })
            // Strong-confidence match — don't bother descending into it.
            if (sc >= STRONG_MATCH_SCORE) continue
          }
        }
        const next = await listDirectory(d.absolute)
        if (next.ok) queue.push({ path: d.absolute, depth: cur.depth + 1, list: next })
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.depth - b.depth)
  return candidates
}

function run(command: string, args: string[]): Promise<string> {
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

export const FolderResolveRoutes = lazy(() =>
  new Hono()
    .get("/probe", async (c) => {
      // macOS Full Disk Access check: can we read ~/Desktop? On Linux/Windows
      // there's no TCC equivalent so we always answer "yes".
      if (process.platform !== "darwin") return c.json({ fda: true })
      const desktop = path.join(HOME, "Desktop")
      const r = await listDirectory(desktop)
      const fda = r.ok && (r.entries?.length ?? 0) > 0
      return c.json({ fda, reason: fda ? undefined : (r.error ?? "Desktop unreadable (TCC blocking)") })
    })
    .get("/dialog", async (c) => {
      // Only macOS gets a reliable scriptable native dialog. Linux/Windows
      // fall through to the in-app FolderPicker the SPA renders next.
      if (process.platform !== "darwin") {
        return c.json({ unsupported: true, message: `native dialog unsupported on ${process.platform}` }, 501)
      }
      try {
        const script = ['set picked to choose folder with prompt "Open project folder"', "POSIX path of picked"]
        const out = await run(
          "osascript",
          script.flatMap((s) => ["-e", s]),
        )
        const folder = out.trim().replace(/\/+$/, "")
        return c.json({ paths: folder ? [folder] : [] })
      } catch (e: any) {
        const message = String(e?.message ?? e)
        const cancelled = /User canceled|cancelled/i.test(message)
        return c.json({ error: cancelled ? "cancelled" : message }, (cancelled ? 499 : 500) as any)
      }
    })
    .post("/validate", async (c) => {
      let body: { path?: string } = {}
      try {
        body = await c.req.json()
      } catch {
        return c.json({ ok: false, error: "invalid json" }, 400)
      }
      const absolute = expandPath(body.path)
      if (!absolute) return c.json({ ok: false, error: "path required" }, 400)
      const stat = await fs.stat(absolute).catch(() => undefined)
      if (!stat) return c.json({ ok: false, absolute, error: "path not found" }, 400)
      if (!stat.isDirectory()) return c.json({ ok: false, absolute, error: "path is not a directory" }, 400)
      const real = await fs.realpath(absolute).catch(() => absolute)
      const listed = await listDirectory(real)
      return c.json({
        ok: true,
        absolute: real,
        readable: listed.ok,
        entries: listed.ok ? (listed.entries?.length ?? 0) : 0,
        warning: listed.ok ? undefined : listed.error,
      })
    })
    .post("/", async (c) => {
      let body: { name?: string; hint?: string; children?: unknown } = {}
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: "invalid json" }, 400)
      }
      const name = String(body.name ?? "").trim()
      const hint = body.hint ? String(body.hint).trim() : ""
      const fingerprint = Array.isArray(body.children) ? body.children.map(String).filter(Boolean).slice(0, 16) : []
      if (!name || /\//.test(name)) return c.json({ error: "name required (no slashes)" }, 400)
      const candidates = await findByName(name, hint, fingerprint)
      return c.json({
        candidates: candidates.slice(0, 10).map((cand) => ({ path: cand.path, score: cand.score })),
        best: candidates[0]?.path ?? null,
      })
    }),
)
