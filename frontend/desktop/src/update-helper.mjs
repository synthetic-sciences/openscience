import { execFile } from "node:child_process"
import { appendFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"

const exec = promisify(execFile)

function decode(value) {
  const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  if (!Number.isInteger(payload.parent) || payload.parent <= 0) throw new Error("Invalid update parent process")
  for (const key of ["current", "staged", "backup", "root"]) {
    if (typeof payload[key] !== "string" || !path.isAbsolute(payload[key])) throw new Error(`Invalid update ${key}`)
  }
  if (!payload.current.endsWith(".app") || !payload.staged.endsWith(".app") || !payload.backup.endsWith(".app")) {
    throw new Error("Desktop update paths must be application bundles")
  }
  return payload
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function wait(pid, attempt = 0) {
  if (!alive(pid)) return
  if (attempt >= 600) throw new Error(`OpenScience ${pid} did not exit before the update`)
  await sleep(100)
  return wait(pid, attempt + 1)
}

async function install(payload) {
  await wait(payload.parent)
  await rename(payload.current, payload.backup)
  try {
    await exec("/usr/bin/ditto", [payload.staged, payload.current])
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", payload.current])
    await rm(payload.backup, { recursive: true, force: true })
  } catch (error) {
    await rm(payload.current, { recursive: true, force: true })
    await rename(payload.backup, payload.current)
    throw error
  }
  if (process.env.OPENSCIENCE_UPDATE_SKIP_LAUNCH !== "1") {
    await exec("/usr/bin/open", ["-n", payload.current])
  }
  await rm(payload.root, { recursive: true, force: true })
}

const payload = decode(process.argv[2] ?? "")
const log = path.join(path.dirname(payload.root), "update.log")

await install(payload).catch(async (error) => {
  await appendFile(log, `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, {
    mode: 0o600,
  })
  process.exitCode = 1
})
