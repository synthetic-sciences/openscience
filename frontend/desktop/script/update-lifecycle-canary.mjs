import { execFile, spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { apply, asset, checksum, launch, newer, stage, verify } from "../src/updater.mjs"

const execute = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))

function argumentsMap(argv) {
  const input = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid updater lifecycle canary argument: ${key ?? ""}`)
    }
    input.set(key.slice(2), value)
  }
  return input
}

function required(input, key) {
  const value = input.get(key)
  if (!value) throw new Error(`Missing updater lifecycle canary --${key}`)
  return value
}

async function realArchive(file, expectedName) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || path.basename(file) !== expectedName) {
    throw new Error(`${expectedName} is not a real, non-empty updater archive`)
  }
  return info
}

async function extractArchive(archive, output) {
  await mkdir(output, { recursive: true, mode: 0o700 })
  await execute("/usr/bin/ditto", ["-x", "-k", archive, output], { timeout: 10 * 60_000 })
  const entries = await readdir(output, { withFileTypes: true })
  if (
    entries.length !== 1 ||
    entries[0].name !== "OpenScience.app" ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink()
  ) {
    throw new Error("The previous updater archive must contain only a real OpenScience.app bundle")
  }
  return path.join(output, "OpenScience.app")
}

function decodePrepared(prepared) {
  const payload = JSON.parse(Buffer.from(prepared.payload, "base64url").toString("utf8"))
  return {
    token: payload.token,
    target: payload.target,
    incoming: payload.incoming,
    root: payload.root,
    health: payload.health,
    runtime: payload.runtime,
    handoff: payload.handoff,
    ready: payload.ready,
    journal: payload.journal,
    result: payload.result,
  }
}

async function driver(configFile) {
  const config = JSON.parse(await readFile(configFile, "utf8"))
  const archiveInfo = await realArchive(config.archive, asset(config.arch))
  const digest = await checksum(config.archive)
  let server
  try {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === `/releases/tags/v${config.version}`) {
          return Response.json({
            tag_name: `v${config.version}`,
            draft: false,
            prerelease: false,
            assets: [
              {
                name: asset(config.arch),
                digest: `sha256:${digest}`,
                size: archiveInfo.size,
                browser_download_url: new URL("/asset", server.url).toString(),
              },
            ],
          })
        }
        if (url.pathname === "/asset") return new Response(Bun.file(config.archive))
        return new Response("Not found", { status: 404 })
      },
    })
    const update = await stage(config.version, {
      api: server.url.toString().replace(/\/$/, ""),
      arch: config.arch,
      cache: config.cache,
      current: config.target,
      currentVersion: config.previousVersion,
      trusted: true,
    })
    const prepared = await apply(update, {
      current: config.target,
      trusted: true,
      executable: process.execPath,
    })
    await writeFile(config.handoffInfo, `${JSON.stringify(decodePrepared(prepared))}\n`, { mode: 0o600 })
    await launch(prepared)
  } finally {
    server?.stop(true)
  }
}

async function readJson(file) {
  return readFile(file, "utf8")
    .then((value) => JSON.parse(value))
    .catch((error) => {
      if (error?.code === "ENOENT") return
      throw error
    })
}

async function waitForFile(file, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await readJson(file)
    if (value) return value
    await sleep(50)
  }
  throw new Error(`Timed out waiting for updater canary evidence: ${path.basename(file)}`)
}

async function waitForResult(file) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const value = await readJson(file)
    if (value?.status === "succeeded" || value?.status === "failed") return value
    await sleep(100)
  }
  throw new Error("The packaged updater lifecycle did not settle within two minutes")
}

async function missing(file) {
  return lstat(file).then(
    () => false,
    (error) => {
      if (error?.code === "ENOENT") return true
      throw error
    },
  )
}

async function assertTransactionClean(info) {
  const owned = ["incoming", "root", "health", "runtime", "handoff", "ready", "journal"]
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const retained = []
    for (const key of owned) {
      if (!(await missing(info[key]))) retained.push(key)
    }
    if (!retained.length) return
    await sleep(100)
  }
  const retained = []
  for (const key of owned) {
    if (!(await missing(info[key]))) retained.push(`${key}: ${info[key]}`)
  }
  throw new Error(`Updater lifecycle did not clean its transaction: ${retained.join(", ")}`)
}

async function observed(identity) {
  const [started, command] = await Promise.all([
    execute("/bin/ps", ["-p", String(identity.pid), "-o", "lstart="], { timeout: 2_000 }).catch(() => undefined),
    execute("/bin/ps", ["-ww", "-p", String(identity.pid), "-o", "command="], { timeout: 2_000 }).catch(
      () => undefined,
    ),
  ])
  if (!started?.stdout.trim() || !command?.stdout.trim()) return
  return { started: started.stdout.trim(), command: command.stdout.trim() }
}

function sameProcess(value, identity) {
  return Boolean(value && value.started === identity.started && value.command === identity.command)
}

async function waitForExit(identity, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!sameProcess(await observed(identity), identity)) return true
    await sleep(100)
  }
  return false
}

async function stopSuccessfulApp(health) {
  const desktop = health?.process_identity
  const service = health?.service_identity
  if (
    !Number.isSafeInteger(desktop?.pid) ||
    !desktop.started ||
    !desktop.command ||
    !Number.isSafeInteger(service?.pid) ||
    !service.started ||
    !service.command
  ) {
    throw new Error("The successful lifecycle result omitted exact packaged process identities")
  }
  if (!sameProcess(await observed(desktop), desktop) || !sameProcess(await observed(service), service)) {
    throw new Error("The packaged main or sidecar exited before lifecycle evidence was inspected")
  }
  process.kill(desktop.pid, "SIGTERM")
  if (!(await waitForExit(desktop, 30_000))) {
    throw new Error("The packaged OpenScience main did not stop after its lifecycle canary")
  }
  if (!(await waitForExit(service, 30_000))) {
    // Clean up only the exact sidecar identity whose receipt was authenticated,
    // then fail the canary because the desktop did not drain it itself.
    if (sameProcess(await observed(service), service)) process.kill(service.pid, "SIGTERM")
    await waitForExit(service, 10_000)
    throw new Error("The packaged OpenScience sidecar outlived its desktop lifecycle canary")
  }
}

async function clearSettledCache(cache) {
  const allowed = new Set(["last-result.json", "update.log"])
  const entries = await readdir(cache).catch((error) => {
    if (error?.code === "ENOENT") return []
    throw error
  })
  const unexpected = entries.filter((entry) => !allowed.has(entry))
  if (unexpected.length) {
    throw new Error(`Updater lifecycle cache retained unexpected entries: ${unexpected.join(", ")}`)
  }
  for (const entry of entries) await rm(path.join(cache, entry), { force: true })
}

async function copyPrevious(previous, target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await execute("/usr/bin/ditto", [previous, target], { timeout: 10 * 60_000 })
}

async function runTransaction(config, environment = {}) {
  await writeFile(config.configFile, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  const child = spawn(process.execPath, [script, "--driver", config.configFile], {
    env: { ...process.env, ...environment },
    stdio: "inherit",
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(signal ? `signal ${signal}` : code))
  })
  if (exitCode !== 0) throw new Error(`Updater lifecycle handoff driver exited with ${exitCode}`)
  const info = await waitForFile(config.handoffInfo)
  return { info, result: await waitForResult(info.result) }
}

async function main() {
  const input = argumentsMap(process.argv.slice(2))
  const archive = path.resolve(required(input, "zip"))
  const previousArchive = path.resolve(required(input, "previous-zip"))
  const version = required(input, "version")
  const previousVersion = required(input, "previous-version")
  const arch = required(input, "arch")
  const team = required(input, "team")
  if (process.platform !== "darwin") throw new Error("The packaged updater lifecycle canary requires macOS")
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported canary architecture: ${arch}`)
  if (process.arch !== arch) {
    throw new Error(`The ${arch} updater lifecycle must run natively, not on ${process.arch}`)
  }
  if (!newer(previousVersion, version)) {
    throw new Error(`Canary baseline ${previousVersion} is not older than candidate ${version}`)
  }
  await Promise.all([realArchive(archive, asset(arch)), realArchive(previousArchive, asset(arch))])

  const workspace = await mkdtemp(path.join(os.tmpdir(), `openscience-update-lifecycle-${arch}-`))
  const cache = path.join(os.homedir(), "Library", "Application Support", "OpenScience", "updates")
  const target = path.join(workspace, "Applications", "OpenScience.app")
  try {
    await mkdir(cache, { recursive: true, mode: 0o700 })
    if ((await readdir(cache)).length) {
      throw new Error("The native lifecycle runner did not start with an isolated OpenScience update cache")
    }
    const previous = await extractArchive(previousArchive, path.join(workspace, "previous"))
    const previousTrust = await verify(previous, previousVersion, { trusted: true, current: previous })
    if (previousTrust?.team !== team) {
      throw new Error(
        `Previous signed stable belongs to Apple team ${previousTrust?.team || "unknown"}, expected ${team}`,
      )
    }

    await copyPrevious(previous, target)
    const success = await runTransaction({
      archive,
      arch,
      cache,
      configFile: path.join(workspace, "success-config.json"),
      handoffInfo: path.join(workspace, "success-handoff.json"),
      previousVersion,
      target,
      version,
    })
    if (success.result.status !== "succeeded" || success.result.version !== version || success.result.cleanup_error) {
      throw new Error(`Packaged updater success path failed: ${JSON.stringify(success.result)}`)
    }
    if (
      success.result.health?.service_health?.version !== version ||
      typeof success.result.health?.service_health?.run_id !== "string" ||
      !success.result.health.service_health.run_id
    ) {
      throw new Error("Packaged updater success omitted authenticated new-main/sidecar health")
    }
    const installedTrust = await verify(target, version, { trusted: true, current: target })
    if (installedTrust?.team !== team) throw new Error("Activated update does not belong to the configured Apple team")
    await assertTransactionClean(success.info)
    await stopSuccessfulApp(success.result.health)

    await clearSettledCache(cache)
    await copyPrevious(previous, target)
    const failure = await runTransaction(
      {
        archive,
        arch,
        cache,
        configFile: path.join(workspace, "failure-config.json"),
        handoffInfo: path.join(workspace, "failure-handoff.json"),
        previousVersion,
        target,
        version,
      },
      {
        NODE_ENV: "test",
        OPENSCIENCE_UPDATE_TEST_SKIP_FALLBACK: "1",
        OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE: "after-healthy",
      },
    )
    if (
      failure.result.status !== "failed" ||
      failure.result.version !== version ||
      failure.result.error !== "Injected desktop update health failure after packaged health" ||
      failure.result.recovery_error
    ) {
      throw new Error(`Injected packaged updater rollback did not settle cleanly: ${JSON.stringify(failure.result)}`)
    }
    const restoredTrust = await verify(target, previousVersion, { trusted: true, current: target })
    if (restoredTrust?.team !== team) throw new Error("Rollback did not restore the previous signed publisher")
    await assertTransactionClean(failure.info)
    console.log(
      `verified native ${arch} packaged lifecycle ${previousVersion} -> ${version}, cleanup, and safe rollback`,
    )
  } finally {
    await clearSettledCache(cache).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
  }
}

if (process.argv[2] === "--driver") await driver(path.resolve(process.argv[3] ?? ""))
else await main()
