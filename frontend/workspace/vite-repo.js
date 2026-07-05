import { spawn } from "node:child_process"

function run(command, args, cwd, ok = [0]) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk.toString()))
    child.stderr.on("data", (chunk) => (err += chunk.toString()))
    child.on("error", rejectP)
    child.on("close", (code) => {
      const result = { code, out: out.trim(), err: err.trim() }
      if (ok.includes(code ?? 1)) {
        resolveP(result)
        return
      }
      rejectP(new Error(result.err || result.out || `${command} exited ${code}`))
    })
  })
}

async function git(args, directory, ok) {
  return await run("git", args, directory, ok)
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

function directoryFrom(req) {
  const url = new URL(req.url || "/", "http://localhost")
  return String(url.searchParams.get("directory") ?? "").trim()
}

function parseRemote(remote) {
  if (!remote) return null
  const ssh = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh) return { owner: ssh[1], name: ssh[2], url: `https://github.com/${ssh[1]}/${ssh[2]}` }
  const https = remote.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return { owner: https[1], name: https[2], url: `https://github.com/${https[1]}/${https[2]}` }
  return null
}

function countStatus(lines) {
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

async function status(directory) {
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
          return { ahead: Number.isFinite(parts[0]) ? parts[0] : 0, behind: Number.isFinite(parts[1]) ? parts[1] : 0 }
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

async function commit(directory, message) {
  if (!directory) throw new Error("directory required")
  if (!String(message ?? "").trim()) throw new Error("commit message required")
  await git(["add", "-A"], directory)
  const diff = await git(["diff", "--cached", "--quiet"], directory, [0, 1])
  if (diff.code === 0) return { committed: false, message: "no changes staged" }
  const result = await git(["commit", "-m", String(message).trim()], directory)
  return { committed: true, output: result.out || result.err }
}

async function push(directory, branch) {
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

async function remote(directory, url) {
  if (!directory) throw new Error("directory required")
  const value = String(url ?? "").trim()
  if (!value) throw new Error("remote URL required")
  const hasOrigin = await git(["remote", "get-url", "origin"], directory)
    .then(() => true)
    .catch(() => false)
  await git(hasOrigin ? ["remote", "set-url", "origin", value] : ["remote", "add", "origin", value], directory)
  return await status(directory)
}

async function handle(req, res) {
  const path = (req.url || "/").split("?")[0].replace(/^\/+/, "")
  try {
    if (req.method === "GET" && path === "status") {
      return send(res, 200, await status(directoryFrom(req)))
    }
    if (req.method === "POST" && path === "commit") {
      const body = JSON.parse((await readBody(req)) || "{}")
      return send(res, 200, await commit(String(body.directory ?? ""), body.message))
    }
    if (req.method === "POST" && path === "push") {
      const body = JSON.parse((await readBody(req)) || "{}")
      return send(res, 200, await push(String(body.directory ?? ""), body.branch))
    }
    if (req.method === "POST" && path === "remote") {
      const body = JSON.parse((await readBody(req)) || "{}")
      return send(res, 200, await remote(String(body.directory ?? ""), body.url))
    }
    return send(res, 404, { error: "unknown repo route", path })
  } catch (e) {
    return send(res, 400, { error: String(e?.message ?? e) })
  }
}

export default {
  name: "repo-bridge",
  configureServer(server) {
    server.middlewares.use("/api/repo", (req, res, next) => {
      handle(req, res).catch(next)
    })
  },
}
