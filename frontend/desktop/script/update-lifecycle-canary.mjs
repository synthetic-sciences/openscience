import { execFile, spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { apply, asset, checksum, launch, newer, stage, verify } from "../src/updater.mjs"

const execute = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const desktopPackage = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))
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

async function bindProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("The updater helper process identity is invalid")
  const [started, command] = await Promise.all([
    execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], { timeout: 2_000 }),
    execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 2_000 }),
  ])
  const identity = { pid, started: started.stdout.trim(), command: command.stdout.trim() }
  if (!identity.started || !identity.command) throw new Error("The updater helper process identity is incomplete")
  return identity
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
    const launched = await launch(prepared)
    const helperIdentity = await bindProcessIdentity(launched.helper_pid)
    await writeFile(
      config.handoffInfo,
      `${JSON.stringify({ ...decodePrepared(prepared), helper_identity: helperIdentity })}\n`,
      { mode: 0o600 },
    )
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

async function transactionResidue(info) {
  const owned = ["incoming", "root", "health", "runtime", "handoff", "ready", "journal"]
  const retained = []
  for (const key of owned) {
    if (!(await missing(info[key]))) retained.push(`${key}: ${info[key]}`)
  }
  const cache = path.dirname(info.health)
  const allowed = new Set(["last-result.json", "update.log"])
  const entries = await readdir(cache).catch((error) => {
    if (error?.code === "ENOENT") return []
    throw error
  })
  const unexpected = entries.filter((entry) => !allowed.has(entry)).map((entry) => `cache: ${path.join(cache, entry)}`)
  const applications = path.dirname(info.incoming)
  const purges = await readdir(applications)
    .then((values) =>
      values
        .filter((entry) => entry.startsWith(".openscience-purge-"))
        .map((entry) => `applications: ${path.join(applications, entry)}`),
    )
    .catch((error) => {
      if (error?.code === "ENOENT") return []
      throw error
    })
  return [...retained, ...unexpected, ...purges]
}

export const updaterSettlementTimeout = 10 * 60_000

async function logTail(file, limit = 8 * 1024) {
  const handle = await open(file, "r").catch((error) => {
    if (error?.code === "ENOENT") return
    throw error
  })
  if (!handle) return ""
  try {
    const stats = await handle.stat()
    const length = Math.min(limit, stats.size)
    const content = Buffer.alloc(length)
    const start = Math.max(0, stats.size - length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(content, offset, length - offset, start + offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return content.subarray(0, offset).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function settlementDiagnostics(info) {
  const cache = path.dirname(info.result)
  const [residue, updateLog] = await Promise.all([
    transactionResidue(info).catch((error) => [`diagnostic error: ${error instanceof Error ? error.message : error}`]),
    logTail(path.join(cache, "update.log")).catch(
      (error) => `diagnostic error: ${error instanceof Error ? error.message : error}`,
    ),
  ])
  return { residue, update_log_tail: updateLog || undefined }
}

export async function assertTransactionClean(info, timeout = updaterSettlementTimeout) {
  const deadline = Date.now() + timeout
  let previouslyClean = false
  while (Date.now() < deadline) {
    const clean = !(await transactionResidue(info)).length
    if (clean && previouslyClean) return
    previouslyClean = clean
    await sleep(100)
  }
  const residue = await transactionResidue(info)
  if (!residue.length) throw new Error("Updater lifecycle cache did not remain settled before its timeout")
  throw new Error(`Updater lifecycle did not clean its transaction: ${residue.join(", ")}`)
}

async function observed(identity) {
  let result
  try {
    result = await execute("/bin/ps", ["-ww", "-p", String(identity.pid), "-o", "lstart=", "-o", "command="], {
      timeout: 2_000,
    })
  } catch (error) {
    try {
      process.kill(identity.pid, 0)
    } catch (probe) {
      if (probe?.code === "ESRCH") return
      throw new Error(`Could not prove whether packaged process ${identity.pid} exited`, { cause: probe })
    }
    throw new Error(`Could not inspect packaged process ${identity.pid}`, { cause: error })
  }
  const output = result.stdout.trim()
  if (!output) {
    try {
      process.kill(identity.pid, 0)
    } catch (probe) {
      if (probe?.code === "ESRCH") return
      throw new Error(`Could not prove whether packaged process ${identity.pid} exited`, { cause: probe })
    }
    throw new Error(`Packaged process ${identity.pid} was alive but ps returned no identity`)
  }
  if (!output.startsWith(`${identity.started} `)) return { started: "", command: output }
  return { started: identity.started, command: output.slice(identity.started.length).trimStart() }
}

function sameProcess(value, identity) {
  return Boolean(value && value.started === identity.started && value.command === identity.command)
}

async function waitForExit(identity, timeout, inspect = observed) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!sameProcess(await inspect(identity), identity)) return true
    await sleep(100)
  }
  return false
}

function validExactIdentity(identity) {
  return Boolean(
    Number.isSafeInteger(identity?.pid) &&
    identity.pid > 1 &&
    typeof identity.started === "string" &&
    identity.started &&
    typeof identity.command === "string" &&
    identity.command,
  )
}

export async function settleTransaction(info, expected, operations = {}) {
  const helper = info?.helper_identity
  if (!validExactIdentity(helper)) throw new Error("The updater lifecycle handoff omitted its exact helper identity")
  if (
    (expected?.status !== "succeeded" && expected?.status !== "failed") ||
    typeof expected?.version !== "string" ||
    !expected.version
  ) {
    throw new Error("The updater lifecycle expected final state is invalid")
  }
  const timeout = operations.timeout ?? updaterSettlementTimeout
  const inspect = operations.observe ?? observed
  const awaitExit = operations.waitForExit ?? ((identity, duration) => waitForExit(identity, duration, inspect))
  const assertClean = operations.assertClean ?? assertTransactionClean
  const readResult = operations.readResult ?? readJson
  const deadline = Date.now() + timeout
  const helperExited = await awaitExit(helper, timeout)
  if (!helperExited) throw new Error("The exact updater helper did not exit after lifecycle settlement")
  const validateResult = async () => {
    const result = await readResult(info.result)
    const expectedError = Object.hasOwn(expected, "error") ? expected.error : undefined
    if (
      result?.status !== expected.status ||
      result?.version !== expected.version ||
      result.cleanup_error ||
      result.recovery_error ||
      (Object.hasOwn(expected, "error") && result.error !== expectedError)
    ) {
      throw new Error(`Updater lifecycle final state did not match its contract: ${JSON.stringify(result)}`)
    }
    return result
  }
  try {
    await validateResult()
  } catch (error) {
    const diagnostics = await settlementDiagnostics(info)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; helper diagnostics: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    )
  }
  await assertClean(info, Math.max(1, deadline - Date.now()))
  return validateResult()
}

function signalExact(identity, signal) {
  try {
    signal(identity)
    return true
  } catch (error) {
    // The exact process may finish between its identity inspection and the
    // signal. Only ESRCH proves that narrow race; every other signal failure
    // remains a canary instrumentation error.
    if (error?.code === "ESRCH") return false
    throw error
  }
}

export async function stopSuccessfulApp(health, operations = {}) {
  const desktop = health?.process_identity
  const service = health?.service_identity
  if (
    !Number.isSafeInteger(desktop?.pid) ||
    desktop.pid <= 1 ||
    typeof desktop.started !== "string" ||
    !desktop.started ||
    typeof desktop.command !== "string" ||
    !desktop.command ||
    !Number.isSafeInteger(service?.pid) ||
    service.pid <= 1 ||
    typeof service.started !== "string" ||
    !service.started ||
    typeof service.command !== "string" ||
    !service.command
  ) {
    throw new Error("The successful lifecycle result omitted exact packaged process identities")
  }
  const inspect = operations.observe ?? observed
  const signal = operations.signal ?? ((identity) => process.kill(identity.pid, "SIGTERM"))
  const awaitExit = operations.waitForExit ?? ((identity, timeout) => waitForExit(identity, timeout, inspect))
  const [desktopProcess, serviceProcess] = await Promise.all([inspect(desktop), inspect(service)])
  const desktopExact = sameProcess(desktopProcess, desktop)
  const serviceExact = sameProcess(serviceProcess, service)
  if (!desktopExact || !serviceExact) {
    // Never signal a reused PID. Do stop an exact survivor so a failed canary
    // cannot leave either half of the packaged runtime behind.
    const survivors = [desktopExact ? desktop : undefined, serviceExact ? service : undefined].filter(Boolean)
    await Promise.all(
      survivors.map(async (identity) => {
        signalExact(identity, signal)
        await awaitExit(identity, 10_000)
      }),
    )
    const missing = [
      !desktopExact ? (desktopProcess ? "main identity changed" : "main exited") : undefined,
      !serviceExact ? (serviceProcess ? "sidecar identity changed" : "sidecar exited") : undefined,
    ].filter(Boolean)
    throw new Error(`The packaged lifecycle ended before canary shutdown: ${missing.join("; ")}`)
  }
  signalExact(desktop, signal)
  if (!(await awaitExit(desktop, 30_000))) {
    throw new Error("The packaged OpenScience main did not stop after its lifecycle canary")
  }
  if (!(await awaitExit(service, 30_000))) {
    // Clean up only the exact sidecar identity whose receipt was authenticated,
    // then fail the canary because the desktop did not drain it itself.
    if (sameProcess(await inspect(service), service)) signalExact(service, signal)
    await awaitExit(service, 10_000)
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

export async function canonical(arch) {
  // macOS exposes its temporary directory through /var, while realpath resolves
  // it through /private/var. The production swap intentionally rejects paths
  // whose spelling is not canonical, so the synthetic install root must obey
  // the same contract as a real /Applications target.
  return realpath(await mkdtemp(path.join(os.tmpdir(), `openscience-update-lifecycle-${arch}-`)))
}

export function packagedUpdateCache(home = os.homedir(), metadata = desktopPackage) {
  const name = metadata?.productName || metadata?.name
  const segments = typeof name === "string" ? name.split("/") : []
  if (
    !path.isAbsolute(home) ||
    path.normalize(home) !== home ||
    !segments.length ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    throw new Error("The packaged desktop user-data path is invalid")
  }
  // Electron derives app.getPath("userData") from the packaged package name,
  // not from electron-builder's bundle display name. Keep the synthetic
  // transaction in the exact cache the launched app will authenticate.
  return path.join(home, "Library", "Application Support", ...segments, "updates")
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

  const workspace = await canonical(arch)
  const cache = packagedUpdateCache()
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
    await settleTransaction(success.info, { status: "succeeded", version })
    await stopSuccessfulApp(success.result.health)
    const installedTrust = await verify(target, version, { trusted: true, current: target })
    if (installedTrust?.team !== team) throw new Error("Activated update does not belong to the configured Apple team")

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
    await settleTransaction(failure.info, {
      status: "failed",
      version,
      error: "Injected desktop update health failure after packaged health",
    })
    const restoredTrust = await verify(target, previousVersion, { trusted: true, current: target })
    if (restoredTrust?.team !== team) throw new Error("Rollback did not restore the previous signed publisher")
    console.log(
      `verified native ${arch} packaged lifecycle ${previousVersion} -> ${version}, cleanup, and safe rollback`,
    )
  } finally {
    await clearSettledCache(cache).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--driver") await driver(path.resolve(process.argv[3] ?? ""))
  else await main()
}
