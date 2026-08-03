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
 *   POST /dialog             — open the host OS-native file/folder dialog
 *   POST /validate           — { path } → resolved absolute path
 *   POST /                   — { name, hint?, children? } → best candidate
 */

import { Hono, type Context } from "hono"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { lazy } from "../../util/lazy"
import { projectSelection } from "../project-selection"
import { probeProtectedFolderAccess } from "../../file/protected-folder-access"

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

type NativePickerInput = {
  kind: "folder" | "file"
  title: string
  multiple: boolean
}

export type NativePickerPlan = {
  command: string
  args: string[]
  format: "lines" | "json"
}

const powershellString = (value: string) => `'${value.replaceAll("'", "''")}'`

export function nativePickerPlan(
  input: NativePickerInput,
  platform: NodeJS.Platform = process.platform,
): NativePickerPlan | undefined {
  if (platform === "darwin") {
    const script = [
      "on run argv",
      "set dialogTitle to item 1 of argv",
      "set selectionKind to item 2 of argv",
      'set allowMany to item 3 of argv is "true"',
      'if selectionKind is "file" then',
      "if allowMany then",
      "set pickedItems to choose file with prompt dialogTitle with multiple selections allowed",
      "else",
      "set pickedItems to {choose file with prompt dialogTitle}",
      "end if",
      "else",
      "if allowMany then",
      "set pickedItems to choose folder with prompt dialogTitle with multiple selections allowed",
      "else",
      "set pickedItems to {choose folder with prompt dialogTitle}",
      "end if",
      "end if",
      "set selectedPaths to {}",
      "repeat with pickedItem in pickedItems",
      "set end of selectedPaths to POSIX path of pickedItem",
      "end repeat",
      "set AppleScript's text item delimiters to linefeed",
      "return selectedPaths as text",
      "end run",
    ]
    return {
      command: "osascript",
      args: [...script.flatMap((line) => ["-e", line]), "--", input.title, input.kind, String(input.multiple)],
      format: "lines",
    }
  }

  if (platform !== "win32") return

  const setup = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
  ]
  const dialog =
    input.kind === "file"
      ? [
          "$picker = New-Object System.Windows.Forms.OpenFileDialog",
          `$picker.Title = ${powershellString(input.title)}`,
          `$picker.Multiselect = ${input.multiple ? "$true" : "$false"}`,
          "$picker.CheckFileExists = $true",
          "$picker.CheckPathExists = $true",
          "$result = $picker.ShowDialog()",
          "if ($result -ne [System.Windows.Forms.DialogResult]::OK) { [Console]::Write('[]'); exit 0 }",
          "$paths = @($picker.FileNames)",
        ]
      : [
          "$picker = New-Object System.Windows.Forms.FolderBrowserDialog",
          `$picker.Description = ${powershellString(input.title)}`,
          "$picker.ShowNewFolderButton = $true",
          "$result = $picker.ShowDialog()",
          "if ($result -ne [System.Windows.Forms.DialogResult]::OK) { [Console]::Write('[]'); exit 0 }",
          "$paths = @($picker.SelectedPath)",
        ]
  const script = [...setup, ...dialog, "[Console]::Write((ConvertTo-Json -Compress -InputObject $paths))"].join("; ")
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-STA", "-Command", script],
    format: "json",
  }
}

export async function openNativePicker(input: NativePickerInput, platform: NodeJS.Platform = process.platform) {
  const plan = nativePickerPlan(input, platform)
  if (!plan) return
  const output = await run(plan.command, plan.args)
  const values = (() => {
    if (plan.format === "lines") return output.split(/\r?\n/)
    const parsed = JSON.parse(output || "[]") as unknown
    return Array.isArray(parsed) ? parsed : []
  })()
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(path.normalize)
}

async function pickerResponse(c: Context, input: NativePickerInput) {
  const plan = nativePickerPlan(input)
  if (!plan) return c.json({ unsupported: true, message: `native dialog unsupported on ${process.platform}` }, 501)
  return openNativePicker(input).then(
    (paths) => c.json({ paths: paths ?? [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = /User canceled|cancelled/i.test(message)
      if (cancelled) return c.json({ error: "cancelled" }, 400)
      return c.json({ error: message }, 500)
    },
  )
}

export const FolderResolveRoutes = lazy(() =>
  new Hono()
    .get("/probe", async (c) => {
      const result = await probeProtectedFolderAccess()
      return c.json({
        fda: !result.blocked,
        reason: result.reason,
      })
    })
    .get("/dialog", (c) => pickerResponse(c, { kind: "folder", title: "Open project folder", multiple: false }))
    .post("/dialog", async (c) => {
      const body = await c.req.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid json" }, 400)
      const kind = "kind" in body && body.kind === "file" ? "file" : "folder"
      const title =
        "title" in body && typeof body.title === "string" ? body.title.trim().slice(0, 160) : "Choose a location"
      const multiple = "multiple" in body && body.multiple === true
      return pickerResponse(c, { kind, title: title || "Choose a location", multiple })
    })
    .post("/validate", async (c) => {
      let body: { path?: string; project?: string; projectID?: string } = {}
      try {
        body = await c.req.json()
      } catch {
        return c.json({ ok: false, error: "invalid json" }, 400)
      }
      const absolute = expandPath(body.path)
      const selected = await projectSelection(c, {
        projectID: body.projectID ?? body.project,
        directory: absolute || undefined,
      })
      const directory = selected.directory
      if (!directory) return c.json({ ok: false, error: "path required" }, 400)
      const stat = await fs.stat(directory).catch(() => undefined)
      if (!stat) return c.json({ ok: false, absolute: directory, error: "path not found" }, 400)
      if (!stat.isDirectory()) return c.json({ ok: false, absolute: directory, error: "path is not a directory" }, 400)
      const real = await fs.realpath(directory).catch(() => directory)
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
