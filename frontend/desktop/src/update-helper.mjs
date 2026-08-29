import { execFile } from "node:child_process"
import { appendFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"

const exec = promisify(execFile)

function decode(value) {
  const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  if (!Number.isInteger(payload.parent) || payload.parent <= 0) throw new Error("Invalid update parent process")
  for (const key of ["target", "staged", "backup", "root"]) {
    if (typeof payload[key] !== "string" || !path.isAbsolute(payload[key])) throw new Error(`Invalid update ${key}`)
  }
  if (!payload.target.endsWith(".app") || !payload.staged.endsWith(".app") || !payload.backup.endsWith(".app")) {
    throw new Error("Desktop update paths must be application bundles")
  }
  if (typeof payload.replace !== "boolean") throw new Error("Invalid update replacement mode")
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
  if (payload.replace) await rename(payload.target, payload.backup)
  try {
    await exec("/usr/bin/ditto", [payload.staged, payload.target])
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", payload.target])
    await exec("/usr/bin/xattr", ["-dr", "com.apple.quarantine", payload.target]).catch(() => undefined)
    const quarantined = await exec("/usr/bin/xattr", ["-p", "com.apple.quarantine", payload.target]).then(
      () => true,
      () => false,
    )
    if (quarantined) throw new Error("The verified OpenScience update is still quarantined")
    if (payload.replace) await rm(payload.backup, { recursive: true, force: true })
  } catch (error) {
    await rm(payload.target, { recursive: true, force: true })
    if (payload.replace) await rename(payload.backup, payload.target)
    throw error
  }
  if (process.env.OPENSCIENCE_UPDATE_SKIP_LAUNCH !== "1") {
    await exec("/usr/bin/open", ["-n", payload.target])
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
