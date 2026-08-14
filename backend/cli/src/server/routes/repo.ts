/**
 * Git repository support for the openscience web Repository tab.
 *
 * Port of `frontend/workspace/vite-repo.js` (a dev-only vite middleware). The
 * SPA's RightPane → RepoView calls these endpoints to show branch state,
 * stage+commit, push, and set the origin remote. Without these handlers
 * the Repository tab silently 404s on every render.
 *
 * Routes (mounted at `/api/repo`):
 *   GET  /status?directory=...    — branch, remote, ahead/behind, dirty files
 *   POST /commit  { directory, message }
 *   POST /push    { directory, branch? }
 *   POST /remote  { directory, url } — sets origin (add or replace)
 *
 * Every operation requires the opaque project selector. A directory may be
 * supplied only as a checked worktree override; a caller-owned directory by
 * itself never grants repository execution authority.
 */

import { Hono } from "hono"
import { spawn } from "child_process"
import { lazy } from "../../util/lazy"
import { projectSelection } from "../project-selection"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Project } from "@/project/project"
import { ProjectTrust } from "@/project/trust"
import { AuthoritySignal } from "@/project/authority-signal"
import { Config } from "@/config/config"
import { Sandbox } from "@/sandbox/sandbox"
import { OpenScience } from "@/openscience"
import { CommandRuntime } from "@/science/command/registry"
import { Shell } from "@/shell/shell"

interface RunResult {
  code: number
  out: string
  err: string
}

/** Reject remote URLs that could run arbitrary commands via git's helper
 *  transports (`ext::`/`fake::`) or argument injection (leading `-`). Normal
 *  https/http/ssh/git@ remotes pass. Exported for tests. */
export function assertSafeRemoteUrl(url: unknown): string {
  const value = String(url ?? "").trim()
  if (!value) throw new Error("remote URL required")
  if (value.startsWith("-")) throw new Error("invalid remote URL")
  if (/^(ext|fake)::/i.test(value)) throw new Error("unsupported remote transport")
  if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(value)) throw new Error("unsupported remote URL scheme")
  return value
}

async function run(command: string, args: string[], cwd: string, ok: number[] = [0]): Promise<RunResult> {
  const launched = await AuthoritySignal.exclusive(async () => {
    await ProjectTrust.require(Instance.project, "repository")
    const options = await Config.trustedSandbox()
    const sandbox = Sandbox.wrapArgv({
      file: command,
      args,
      workspace: [cwd],
      readable: [cwd],
      unreadable: OpenScience.kernelSensitivePaths(),
      options,
    })
    const wrapped = await CommandRuntime.wrap({
      file: sandbox.file,
      args: sandbox.args,
    })
    const child = (() => {
      try {
        return spawn(wrapped.file, wrapped.args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd,
          env: {
            ...OpenScience.kernelEnv(process.env),
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "protocol.ext.allow",
            GIT_CONFIG_VALUE_0: "never",
            GIT_CONFIG_KEY_1: "protocol.fake.allow",
            GIT_CONFIG_VALUE_1: "never",
          },
          detached: process.platform !== "win32",
        })
      } catch (error) {
        Sandbox.cleanup(sandbox)
        throw error
      }
    })()
    const stop = () =>
      Shell.killTree(child, { exited: () => child.exitCode !== null, detached: process.platform !== "win32" })
    const output = new Promise<RunResult>((resolve, reject) => {
      let out = ""
      let err = ""
      child.stdout?.on("data", (chunk) => (out += chunk.toString()))
      child.stderr?.on("data", (chunk) => (err += chunk.toString()))
      child.once("error", reject)
      child.once("close", (code) => {
        resolve({ code: code ?? 1, out: out.trim(), err: err.trim() })
      })
    })
    const registered = await CommandRuntime.start(
      {
        projectID: Instance.project.id,
        sessionID: "repository",
        messageID: "repository",
        description: "Repository operation",
        command: [command, ...args].join(" "),
      },
      child,
      stop,
      { windowsRelease: wrapped.release },
    ).catch(async (error) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined
      await stop()
      Sandbox.cleanup(sandbox)
      throw error
    })
    const safeStop = registered
      ? async () => {
          await CommandRuntime.stop(registered.id, registered.projectID, registered.sessionID)
        }
      : stop
    return { registered, sandbox, stop: safeStop, output }
  })

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      void launched.stop().finally(() => reject(new Error(`${command} timed out`)))
    }, 120_000)
    timer.unref()
    launched.output.finally(() => clearTimeout(timer)).catch(() => undefined)
  })
  const result = await Promise.race([launched.output, timeout]).finally(() => {
    Sandbox.cleanup(launched.sandbox)
    if (launched.registered) CommandRuntime.finish(launched.registered.id)
  })
  if (ok.includes(result.code)) return result
  throw new Error(result.err || result.out || `${command} exited ${result.code}`)
}

const git = (args: string[], directory: string, ok?: number[]) => run("git", args, directory, ok)

interface RemoteInfo {
  owner: string
  name: string
  url: string
}

function parseRemote(remote: string): RemoteInfo | null {
  if (!remote) return null
  const ssh = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh) return { owner: ssh[1]!, name: ssh[2]!, url: `https://github.com/${ssh[1]}/${ssh[2]}` }
  const https = remote.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return { owner: https[1]!, name: https[2]!, url: `https://github.com/${https[1]}/${https[2]}` }
  return null
}

function countStatus(lines: string[]) {
  const base = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, total: 0 }
  for (const line of lines) {
    if (!line || line.startsWith("##")) continue
    base.total += 1
    const code = line.slice(0, 2)
    if (code === "??") {
      base.untracked += 1
      continue
    }
    if (code.includes("A")) base.added += 1
    if (code.includes("M")) base.modified += 1
    if (code.includes("D")) base.deleted += 1
    if (code.includes("R")) base.renamed += 1
  }
  return base
}

async function status(directory: string) {
  if (!directory) throw new Error("directory required")
  await git(["rev-parse", "--is-inside-work-tree"], directory)
  const [branch, remote, upstream, porcelain, userName, userEmail, head] = await Promise.all([
    git(["branch", "--show-current"], directory)
      .then((x) => x.out)
      .catch(() => ""),
    git(["config", "--get", "remote.origin.url"], directory)
      .then((x) => x.out)
      .catch(() => ""),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], directory)
      .then((x) => x.out)
      .catch(() => ""),
    git(["status", "--porcelain=v1", "--branch"], directory)
      .then((x) => x.out)
      .catch(() => ""),
    git(["config", "user.name"], directory)
      .then((x) => x.out)
      .catch(() => ""),
    git(["config", "user.email"], directory)
      .then((x) => x.out)
      .catch(() => ""),
    git(["rev-parse", "--short", "HEAD"], directory)
      .then((x) => x.out)
      .catch(() => ""),
  ])
  const aheadBehind = upstream
    ? await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], directory)
        .then((x) => {
          const parts = x.out.split(/\s+/).map((n) => Number(n))
          return {
            ahead: Number.isFinite(parts[0]) ? parts[0]! : 0,
            behind: Number.isFinite(parts[1]) ? parts[1]! : 0,
          }
        })
        .catch(() => ({ ahead: 0, behind: 0 }))
    : { ahead: 0, behind: 0 }
  const lines = porcelain.split("\n").filter(Boolean)
  const counts = countStatus(lines)
  return {
    directory,
    isGit: true,
    branch,
    remote,
    github: parseRemote(remote),
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    head,
    userName,
    userEmail,
    counts,
    clean: counts.total === 0,
    files: lines.filter((line) => !line.startsWith("##")).slice(0, 60),
  }
}

async function commit(directory: string, message: unknown) {
  if (!directory) throw new Error("directory required")
  const text = String(message ?? "").trim()
  if (!text) throw new Error("commit message required")
  await git(["add", "-A"], directory)
  // `diff --cached --quiet` exits 0 when there are no staged changes, 1 when
  // there are — accept both codes here so we can branch on the result.
  const diff = await git(["diff", "--cached", "--quiet"], directory, [0, 1])
  if (diff.code === 0) return { committed: false, message: "no changes staged" }
  const result = await git(["commit", "-m", text], directory)
  return { committed: true, output: result.out || result.err }
}

async function push(directory: string, branch: unknown) {
  if (!directory) throw new Error("directory required")
  const current = String(branch || (await git(["branch", "--show-current"], directory).then((x) => x.out))).trim()
  if (!current) throw new Error("branch required")
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], directory)
    .then((x) => x.out)
    .catch(() => "")
  const args = upstream ? ["push"] : ["push", "-u", "origin", current]
  const result = await git(args, directory)
  return { pushed: true, output: result.out || result.err }
}

async function setRemote(directory: string, url: unknown) {
  if (!directory) throw new Error("directory required")
  const value = assertSafeRemoteUrl(url)
  const hasOrigin = await git(["remote", "get-url", "origin"], directory)
    .then(() => true)
    .catch(() => false)
  await git(hasOrigin ? ["remote", "set-url", "origin", value] : ["remote", "add", "origin", value], directory)
  return await status(directory)
}

async function wrap<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, body: await fn() }
  } catch (e: any) {
    return { ok: false as const, body: { error: String(e?.message ?? e) } }
  }
}

async function within<T>(
  selected: Awaited<ReturnType<typeof projectSelection>>,
  action: (directory: string) => Promise<T>,
) {
  if (!selected.project || !selected.directory) {
    throw new Error("Repository operations require an opaque project selector")
  }
  return Instance.provide({
    directory: selected.directory,
    init: InstanceBootstrap,
    async fn() {
      if (Instance.project.id !== selected.project.id) {
        throw new Project.MismatchError({ projectID: selected.project.id, directory: Instance.directory })
      }
      await ProjectTrust.require(Instance.project, "repository")
      return action(Instance.directory)
    },
  })
}

export const RepoRoutes = lazy(() =>
  new Hono()
    .get("/status", async (c) => {
      const selected = await projectSelection(c)
      const r = await wrap(() => within(selected, status))
      return c.json(r.body, r.ok ? 200 : 400)
    })
    .post("/commit", async (c) => {
      let body: { directory?: string; project?: string; projectID?: string; message?: unknown } = {}
      try {
        body = await c.req.json()
      } catch {}
      const selected = await projectSelection(c, {
        projectID: body.projectID ?? body.project,
        directory: body.directory,
      })
      const r = await wrap(() => within(selected, (directory) => commit(directory, body.message)))
      return c.json(r.body, r.ok ? 200 : 400)
    })
    .post("/push", async (c) => {
      let body: { directory?: string; project?: string; projectID?: string; branch?: unknown } = {}
      try {
        body = await c.req.json()
      } catch {}
      const selected = await projectSelection(c, {
        projectID: body.projectID ?? body.project,
        directory: body.directory,
      })
      const r = await wrap(() => within(selected, (directory) => push(directory, body.branch)))
      return c.json(r.body, r.ok ? 200 : 400)
    })
    .post("/remote", async (c) => {
      let body: { directory?: string; project?: string; projectID?: string; url?: unknown } = {}
      try {
        body = await c.req.json()
      } catch {}
      const selected = await projectSelection(c, {
        projectID: body.projectID ?? body.project,
        directory: body.directory,
      })
      const r = await wrap(() => within(selected, (directory) => setRemote(directory, body.url)))
      return c.json(r.body, r.ok ? 200 : 400)
    }),
)
