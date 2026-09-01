import { execFile, spawn } from "node:child_process"
import { appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"

const execute = promisify(execFile)
const exec = (file, args, options = {}) =>
  execute(file, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024, ...options })
const bundleID = "ai.syntheticsciences.openscience"

function contained(root, file) {
  const relative = path.relative(root, file)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function decode(value) {
  if (value.length > 16_384) throw new Error("Desktop update payload is too large")
  const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  if (!Number.isInteger(payload.parent) || payload.parent <= 0) throw new Error("Invalid update parent process")
  for (const key of [
    "target",
    "incoming",
    "staged",
    "fallback",
    "root",
    "health",
    "runtime",
    "handoff",
    "ready",
    "journal",
    "result",
  ]) {
    if (typeof payload[key] !== "string" || !path.isAbsolute(payload[key])) throw new Error(`Invalid update ${key}`)
    if (path.normalize(payload[key]) !== payload[key]) throw new Error(`Update ${key} must use a normalized path`)
  }
  if (
    !payload.target.endsWith(".app") ||
    !payload.incoming.endsWith(".app") ||
    !payload.staged.endsWith(".app") ||
    !payload.fallback.endsWith(".app")
  ) {
    throw new Error("Desktop update paths must be application bundles")
  }
  if (typeof payload.replace !== "boolean") throw new Error("Invalid update replacement mode")
  if (
    payload.replace &&
    (!Number.isSafeInteger(payload.old_identity?.dev) ||
      payload.old_identity.dev < 0 ||
      !Number.isSafeInteger(payload.old_identity?.ino) ||
      payload.old_identity.ino <= 0 ||
      payload.old_identity.type !== "directory")
  ) {
    throw new Error("The approved existing application identity is missing")
  }
  if (!/^\d+\.\d+\.\d+$/.test(payload.version ?? "")) throw new Error("Invalid update version")
  if (!/^[0-9a-f]{48}$/.test(payload.token ?? "")) throw new Error("Invalid update health token")
  const cache = path.dirname(payload.root)
  if (
    !contained(payload.root, payload.staged) ||
    path.basename(payload.staged) !== "OpenScience.app" ||
    path.basename(payload.target) !== "OpenScience.app" ||
    path.dirname(payload.incoming) !== path.dirname(payload.target) ||
    !/^OpenScience\.incoming-[0-9a-f]{16}\.app$/.test(path.basename(payload.incoming)) ||
    path.dirname(payload.health) !== cache ||
    path.basename(payload.health) !== `health-${payload.token}.json` ||
    path.dirname(payload.runtime) !== cache ||
    path.basename(payload.runtime) !== `runtime-${payload.token}.json` ||
    path.dirname(payload.handoff) !== cache ||
    path.basename(payload.handoff) !== `handoff-${payload.token}.json` ||
    path.dirname(payload.ready) !== cache ||
    path.basename(payload.ready) !== `helper-${payload.token}.json` ||
    path.dirname(payload.journal) !== cache ||
    path.basename(payload.journal) !== `transaction-${payload.token}.json` ||
    path.dirname(payload.result) !== cache ||
    path.basename(payload.result) !== "last-result.json"
  ) {
    throw new Error("Desktop update paths do not match the staged transaction")
  }
  if (typeof payload.trusted !== "boolean") throw new Error("Invalid update trust mode")
  if (payload.trusted && (typeof payload.trust?.team !== "string" || typeof payload.trust?.designated !== "string")) {
    throw new Error("The trusted update publisher identity is missing")
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
  if (attempt >= 6_000) throw new Error(`OpenScience ${pid} did not exit after authorizing the update handoff`)
  await sleep(100)
  return wait(pid, attempt + 1)
}

async function authorized(payload) {
  const handoff = await readFile(payload.handoff, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => undefined)
  const at = Date.parse(handoff?.authorized_at)
  if (
    handoff?.schema !== 1 ||
    handoff?.authorized !== true ||
    handoff?.token !== payload.token ||
    handoff?.version !== payload.version ||
    handoff?.parent !== payload.parent ||
    !Number.isFinite(at) ||
    at > Date.now() + 60_000 ||
    Date.now() - at > 10 * 60_000
  ) {
    throw new Error("The old OpenScience runtime did not authorize this update after safe disposal")
  }
}

function uncertainProcess(message) {
  const error = new Error(message)
  error.code = "OPENSCIENCE_UPDATE_PROCESS_UNCERTAIN"
  return error
}

function validIdentity(value) {
  return !Number.isInteger(value?.pid) ||
    value.pid <= 0 ||
    value.pid === process.pid ||
    typeof value.started !== "string" ||
    !value.started.trim() ||
    typeof value.executable !== "string" ||
    !path.isAbsolute(value.executable) ||
    path.normalize(value.executable) !== value.executable ||
    typeof value.command !== "string" ||
    (value.command !== value.executable && !value.command.startsWith(`${value.executable} `))
    ? false
    : true
}

function validProcessIdentity(payload, value) {
  if (!validIdentity(value)) return false
  const relative = path.relative(payload.target, value.executable).split(path.sep)
  return relative.length === 3 && relative[0] === "Contents" && relative[1] === "MacOS" && Boolean(relative[2])
}

function validServiceIdentity(payload, value) {
  if (!validIdentity(value)) return false
  const relative = path.relative(payload.target, value.executable).split(path.sep)
  return (
    relative.length === 4 &&
    relative[0] === "Contents" &&
    relative[1] === "Resources" &&
    relative[2] === "sidecar" &&
    Boolean(relative[3])
  )
}

async function observedProcess(identity) {
  if (!alive(identity.pid)) return
  try {
    const [started, command, state] = await Promise.all([
      exec("/bin/ps", ["-p", String(identity.pid), "-o", "lstart="], { timeout: 2_000 }),
      exec("/bin/ps", ["-ww", "-p", String(identity.pid), "-o", "command="], { timeout: 2_000 }),
      exec("/bin/ps", ["-p", String(identity.pid), "-o", "state="], { timeout: 2_000 }),
    ])
    // macOS ps(1) reports E while a process is trying to exit and Z after it
    // has exited but is awaiting reaping. Neither can execute from the app
    // bundle. Treat both as terminal so an exact, identity-bound rollback is
    // not held forever by a dead sidecar that launchd has not reaped.
    if (/[EZ]/.test(state.stdout.trim())) return
    return { started: started.stdout.trim(), command: command.stdout.trim() }
  } catch (error) {
    if (!alive(identity.pid)) return
    throw error
  }
}

function sameProcess(observed, expected) {
  return Boolean(observed && observed.started === expected.started && observed.command === expected.command)
}

async function stopUnhealthy(payload, identity) {
  if (!validProcessIdentity(payload, identity)) {
    throw uncertainProcess("OpenScience could not verify the unhealthy update process identity")
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = await observedProcess(identity)
    if (!observed || !sameProcess(observed, identity)) return
    await sleep(100)
  }
  let observed = await observedProcess(identity)
  if (!observed || !sameProcess(observed, identity)) return
  process.kill(identity.pid, "SIGTERM")
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = await observedProcess(identity)
    if (!observed || !sameProcess(observed, identity)) return
    await sleep(100)
  }
  observed = await observedProcess(identity)
  if (!observed || !sameProcess(observed, identity)) return
  process.kill(identity.pid, "SIGKILL")
  for (let attempt = 0; attempt < 50; attempt++) {
    observed = await observedProcess(identity)
    if (!observed || !sameProcess(observed, identity)) return
    await sleep(100)
  }
  throw new Error(`Unhealthy OpenScience process ${identity.pid} did not exit before rollback`)
}

function combined(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
}

function guiEnvironment() {
  const env = { ...process.env }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENSCIENCE_UPDATE_SKIP_LAUNCH",
    "OPENSCIENCE_UPDATE_TEST_SKIP_FALLBACK",
    "OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE",
    "OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE",
  ]) {
    delete env[key]
  }
  return env
}

function skipLaunch() {
  return process.env.NODE_ENV === "test" && process.env.OPENSCIENCE_UPDATE_SKIP_LAUNCH === "1"
}

function skipFallback() {
  return process.env.NODE_ENV === "test" && process.env.OPENSCIENCE_UPDATE_TEST_SKIP_FALLBACK === "1"
}

function identity(stats) {
  return { dev: stats.dev, ino: stats.ino, type: "directory" }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.type === right.type && left.dev === right.dev && left.ino === right.ino)
}

async function entry(bundle) {
  const stats = await lstat(bundle).catch(() => undefined)
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return
  return identity(stats)
}

async function publisher(payload, bundle) {
  const stats = await lstat(bundle)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`OpenScience cannot replace the existing item at ${bundle}`)
  }
  const plist = path.join(bundle, "Contents", "Info.plist")
  const identifier = await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist])
  if (identifier.stdout.trim() !== bundleID) {
    throw new Error("The existing Applications item is not OpenScience")
  }
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])
  if (payload.trusted) {
    const details = await exec("/usr/bin/codesign", ["-d", "--verbose=4", bundle])
    const requirement = await exec("/usr/bin/codesign", ["-d", "-r", "-", bundle])
    const team = combined(details)
      .match(/^TeamIdentifier=(.+)$/m)?.[1]
      ?.trim()
    const designated = combined(requirement)
      .match(/designated\s*=>\s*(.+)$/m)?.[1]
      ?.trim()
    if (team !== payload.trust.team || designated !== payload.trust.designated) {
      throw new Error("The existing OpenScience app is signed by a different publisher")
    }
  }
  const after = await entry(bundle)
  const approved = identity(stats)
  if (!sameIdentity(after, approved)) throw new Error("The OpenScience publisher entry changed during verification")
  return approved
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

async function copyQuarantine(source, target) {
  const result = await exec("/usr/bin/xattr", ["-px", "com.apple.quarantine", source]).catch((error) => {
    if (error?.code === 1) return
    throw error
  })
  const value = result?.stdout.replaceAll(/\s/g, "")
  if (!value) return
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("OpenScience quarantine metadata is malformed")
  await exec("/usr/bin/xattr", ["-wx", "com.apple.quarantine", value, target])
}

async function openBundle(payload, bundle, args = []) {
  await publisher(payload, bundle)
  await exec("/usr/bin/open", ["-n", bundle, ...args], { env: guiEnvironment() })
}

async function bundleExecutable(payload, bundle) {
  await publisher(payload, bundle)
  const plist = path.join(bundle, "Contents", "Info.plist")
  const result = await exec("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", plist])
  const name = result.stdout.trim()
  if (!name || name !== path.basename(name) || name === "." || name === "..") {
    throw new Error("The verified update has an invalid application executable")
  }
  const executable = path.join(bundle, "Contents", "MacOS", name)
  const before = await lstat(executable)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("The verified update application executable is invalid")
  }
  const after = await lstat(executable)
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile() || after.isSymbolicLink()) {
    throw new Error("The verified update application executable changed before launch")
  }
  return executable
}

async function launchBundle(payload, bundle, args) {
  const executable = await bundleExecutable(payload, bundle)
  const child = spawn(executable, args, {
    cwd: path.dirname(bundle),
    env: guiEnvironment(),
    stdio: "ignore",
  })
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  if (!child.pid) throw new Error("The verified update application did not start")
  const observed = await observedProcess({ pid: child.pid })
  const identity = observed
    ? { pid: child.pid, started: observed.started, executable, command: observed.command }
    : undefined
  if (payload.trusted && !validProcessIdentity(payload, identity)) {
    child.kill("SIGTERM")
    throw new Error("The verified update application exited or launched with an unexpected process identity")
  }
  return { child, identity }
}

async function verify(payload, bundle) {
  const before = await entry(bundle)
  if (!before) throw new Error("The update application entry is invalid")
  const plist = path.join(bundle, "Contents", "Info.plist")
  const [identifier, version] = await Promise.all([
    exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist]),
    exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]),
  ])
  if (identifier.stdout.trim() !== bundleID)
    throw new Error("The installed update has the wrong application identifier")
  if (version.stdout.trim() !== payload.version)
    throw new Error("The installed update has the wrong application version")
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])
  if (payload.trusted) {
    const assessment = await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle])
    if (!/source=Notarized Developer ID/m.test(combined(assessment))) {
      throw new Error("The installed update did not pass macOS notarized Developer ID assessment")
    }
    const details = await exec("/usr/bin/codesign", ["-d", "--verbose=4", bundle])
    const requirement = await exec("/usr/bin/codesign", ["-d", "-r", "-", bundle])
    const team = combined(details)
      .match(/^TeamIdentifier=(.+)$/m)?.[1]
      ?.trim()
    const designated = combined(requirement)
      .match(/designated\s*=>\s*(.+)$/m)?.[1]
      ?.trim()
    if (team !== payload.trust.team || designated !== payload.trust.designated) {
      throw new Error("The installed update publisher identity changed during replacement")
    }
  }
  const after = await entry(bundle)
  if (!sameIdentity(after, before)) throw new Error("The update application entry changed during verification")
  return before
}

async function receipt(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  const handle = await open(temporary, "w", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  const directory = await open(path.dirname(file), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function removeDurable(file, options = {}) {
  await rm(file, options)
  const directory = await open(path.dirname(file), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function transaction(payload, state, entries = {}) {
  const rootIdentity = await entry(payload.root)
  if (!rootIdentity) throw new Error("The desktop update transaction root changed before journaling")
  await receipt(payload.journal, {
    schema: 1,
    token: payload.token,
    version: payload.version,
    helper_pid: process.pid,
    target: payload.target,
    incoming: payload.incoming,
    fallback: payload.fallback,
    root: payload.root,
    health: payload.health,
    runtime: payload.runtime,
    handoff: payload.handoff,
    ready: payload.ready,
    result: payload.result,
    replace: payload.replace,
    trusted: payload.trusted,
    trust: payload.trust,
    root_identity: rootIdentity,
    old_identity: entries.old,
    new_identity: entries.new,
    state,
    updated_at: new Date().toISOString(),
  })
}

async function prepareSwapper(payload) {
  if (process.env.NODE_ENV === "test" && process.env.OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE) {
    return process.env.OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE
  }
  const source = path.join(payload.incoming, "Contents", "Resources", "sidecar", "openscience")
  const stats = await lstat(source)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("The verified update has no atomic swap helper")
  const target = path.join(payload.root, "update-swap")
  await copyFile(source, target)
  await chmod(target, 0o700)
  return target
}

async function atomicSwap(payload, executable, target, incoming) {
  const request = Buffer.from(
    JSON.stringify({
      action: "swap",
      target: payload.target,
      incoming: payload.incoming,
      target_identity: target,
      incoming_identity: incoming,
    }),
  ).toString("base64url")
  await exec(executable, ["--desktop-update-swap", request], { env: guiEnvironment() })
}

async function atomicInstall(payload, executable, incoming) {
  const request = Buffer.from(
    JSON.stringify({
      action: "move",
      target: payload.target,
      incoming: payload.incoming,
      incoming_identity: incoming,
    }),
  ).toString("base64url")
  await exec(executable, ["--desktop-update-swap", request], { env: guiEnvironment() })
}

async function exactRemove(executable, target, expected) {
  const current = await entry(target)
  if (!current) return false
  if (!expected || !sameIdentity(current, expected)) {
    throw new Error(`Refusing to clean an unapproved desktop update path: ${target}`)
  }
  const request = Buffer.from(JSON.stringify({ action: "remove", target, target_identity: expected })).toString(
    "base64url",
  )
  await exec(executable, ["--desktop-update-swap", request], { env: guiEnvironment() })
  if (!(await missing(target))) throw new Error(`Desktop update cleanup did not remove ${target}`)
  return true
}

async function slotState(payload, oldIdentity, newIdentity) {
  const [target, incoming] = await Promise.all([entry(payload.target), entry(payload.incoming)])
  if (oldIdentity) {
    if (sameIdentity(target, newIdentity) && sameIdentity(incoming, oldIdentity)) return "activated"
    if (sameIdentity(target, oldIdentity) && sameIdentity(incoming, newIdentity)) return "restored"
    return "uncertain"
  }
  if (sameIdentity(target, newIdentity) && !incoming) return "activated"
  if (!target && sameIdentity(incoming, newIdentity)) return "restored"
  return "uncertain"
}

async function jsonReceipt(file) {
  try {
    const source = await readFile(file, "utf8")
    try {
      return { present: true, value: JSON.parse(source) }
    } catch (error) {
      return { present: true, error }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false }
    throw error
  }
}

async function receiptWriteInProgress(file) {
  const prefix = `${path.basename(file)}.`
  return (await readdir(path.dirname(file))).some((entry) => entry.startsWith(prefix))
}

async function waitForHealth(payload) {
  const request = Buffer.from(
    JSON.stringify({
      receipt: payload.health,
      runtime: payload.runtime,
      token: payload.token,
      version: payload.version,
    }),
  ).toString("base64url")
  if (process.env.NODE_ENV === "test" && process.env.OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE === "1") {
    throw new Error("Injected desktop update health failure")
  }
  let launched
  if (skipLaunch()) {
    await receipt(payload.health, { healthy: true, token: payload.token, version: payload.version })
  } else {
    launched = await launchBundle(payload, payload.target, [`--openscience-update-health=${request}`])
  }
  let pendingProcess = launched?.identity
  let pendingService
  let pendingFailure
  let exitedWithoutRuntimeAt
  for (let attempt = 0; attempt < 600; attempt++) {
    const [healthReceipt, runtimeReceipt] = await Promise.all([
      jsonReceipt(payload.health),
      jsonReceipt(payload.runtime),
    ])
    const health = healthReceipt.value
    const runtime = runtimeReceipt.value
    if (
      runtime?.schema === 1 &&
      runtime.token === payload.token &&
      runtime.version === payload.version &&
      runtime.parent === (launched?.child.pid ?? pendingProcess?.pid) &&
      validServiceIdentity(payload, runtime.service_identity)
    ) {
      pendingService = runtime.service_identity
    }
    if (health?.token === payload.token && health?.version === payload.version) {
      if (validProcessIdentity(payload, health.process_identity)) {
        if (pendingProcess && !sameProcess(health.process_identity, pendingProcess)) {
          throw uncertainProcess(`OpenScience ${payload.version} changed its supervised desktop process identity`)
        }
        pendingProcess = health.process_identity
      }
      if (validServiceIdentity(payload, health.service_identity)) pendingService = health.service_identity
      if (health.healthy === true) {
        if (payload.trusted) {
          if (
            !validProcessIdentity(payload, health.process_identity) ||
            !validServiceIdentity(payload, health.service_identity) ||
            health.service_health?.version !== payload.version ||
            typeof health.service_health?.run_id !== "string" ||
            !health.service_health.run_id
          ) {
            throw uncertainProcess(`OpenScience ${payload.version} returned incomplete process health evidence`)
          }
          const [desktop, service] = await Promise.all([
            observedProcess(health.process_identity),
            observedProcess(health.service_identity),
          ])
          if (!sameProcess(desktop, health.process_identity) || !sameProcess(service, health.service_identity)) {
            throw uncertainProcess(`OpenScience ${payload.version} exited before startup health committed`)
          }
        }
        if (process.env.NODE_ENV === "test" && process.env.OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE === "after-healthy") {
          await stopUnhealthy(payload, health.process_identity)
          for (let attempt = 0; attempt < 300; attempt++) {
            const service = await observedProcess(health.service_identity)
            if (!sameProcess(service, health.service_identity)) {
              throw new Error("Injected desktop update health failure after packaged health")
            }
            await sleep(100)
          }
          throw uncertainProcess(
            `OpenScience ${payload.version} did not dispose its exact local runtime after the injected canary shutdown`,
          )
        }
        launched?.child.unref()
        return {
          process_identity: health.process_identity,
          service_identity: health.service_identity,
          service_health: health.service_health,
        }
      }
      if (health.healthy === false) {
        pendingFailure = new Error(
          typeof health.error === "string" && health.error
            ? `OpenScience ${payload.version} failed its startup check: ${health.error}`
            : `OpenScience ${payload.version} failed its startup check`,
        )
        if (health.safe_to_terminate === true) {
          if (pendingService) {
            const service = await observedProcess(pendingService)
            if (sameProcess(service, pendingService)) {
              throw uncertainProcess(
                `OpenScience ${payload.version} reported safe shutdown while its local runtime was still active`,
              )
            }
          }
          await stopUnhealthy(payload, health.process_identity)
          throw pendingFailure
        }
      }
    }
    if (pendingService) {
      const [desktop, service] = await Promise.all([
        pendingProcess ? observedProcess(pendingProcess) : undefined,
        observedProcess(pendingService),
      ])
      const desktopExited = launched
        ? launched.child.exitCode !== null || launched.child.signalCode !== null
        : pendingProcess
          ? !sameProcess(desktop, pendingProcess)
          : false
      if (desktopExited && !sameProcess(service, pendingService)) {
        throw pendingFailure ?? new Error(`OpenScience ${payload.version} exited before startup health completed`)
      }
    } else if (launched && (launched.child.exitCode !== null || launched.child.signalCode !== null)) {
      // The sidecar bootstrap durably writes the runtime receipt before it
      // imports provider/configuration code or adopts the desktop parent. Once
      // the exact launched Electron child has exited, an absent receipt after
      // the parent-death guard interval is proof that no supervised runtime
      // started. A malformed or in-flight receipt is deliberately uncertain.
      if (runtimeReceipt.present) {
        throw uncertainProcess(`OpenScience ${payload.version} left incomplete local runtime evidence`)
      }
      if (await receiptWriteInProgress(payload.runtime)) {
        throw uncertainProcess(`OpenScience ${payload.version} exited while local runtime evidence was being written`)
      }
      exitedWithoutRuntimeAt ??= Date.now()
      if (Date.now() - exitedWithoutRuntimeAt >= 500) {
        throw pendingFailure ?? new Error(`OpenScience ${payload.version} exited before starting its local runtime`)
      }
    }
    await sleep(100)
  }
  if (!pendingProcess) {
    throw uncertainProcess(`OpenScience ${payload.version} did not identify its launched update process`)
  }
  if (pendingFailure) {
    throw uncertainProcess(
      `OpenScience ${payload.version} failed startup without proving that its local runtime was safely disposed`,
    )
  }
  throw uncertainProcess(
    `OpenScience ${payload.version} did not report health or prove that its local runtime was safely disposed`,
  )
}

async function install(payload) {
  let parentExited = false
  let activated = false
  let exchangeAttempted = false
  let restored = false
  let targetTrusted = false
  let swapper
  let oldIdentity = payload.old_identity
  let newIdentity
  let stagedIdentity
  let rootIdentity
  let startupHealth
  try {
    await authorized(payload)
    await receipt(payload.ready, {
      schema: 1,
      ready: true,
      token: payload.token,
      version: payload.version,
      parent: payload.parent,
      helper_pid: process.pid,
      accepted_at: new Date().toISOString(),
    })
    await wait(payload.parent)
    parentExited = true
    rootIdentity = await entry(payload.root)
    if (!rootIdentity) throw new Error("The desktop update transaction root is missing")
    if (!(await missing(payload.incoming))) {
      throw new Error(`OpenScience cannot stage over the existing item at ${payload.incoming}`)
    }
    await mkdir(payload.incoming, { mode: 0o700 })
    const partialIdentity = await entry(payload.incoming)
    if (!partialIdentity) throw new Error("OpenScience could not create its incoming update directory")
    stagedIdentity = partialIdentity
    await transaction(payload, "copying", { old: oldIdentity, new: partialIdentity })
    await exec("/usr/bin/ditto", [payload.staged, payload.incoming])
    await copyQuarantine(payload.staged, payload.incoming)
    newIdentity = await verify(payload, payload.incoming)
    stagedIdentity = newIdentity
    swapper = await prepareSwapper(payload)
    if (payload.replace) {
      const approved = await publisher(payload, payload.target)
      if (!sameIdentity(approved, oldIdentity)) {
        throw new Error("The existing application changed after update approval")
      }
      oldIdentity = approved
    }
    await transaction(payload, "incoming_ready", { old: oldIdentity, new: newIdentity })
    if (payload.replace) {
      exchangeAttempted = true
      await atomicSwap(payload, swapper, oldIdentity, newIdentity)
      activated = true
      // The old exact target now occupies the incoming slot. Revalidate it
      // after the atomic exchange so a path race cannot approve another app.
      const received = await publisher(payload, payload.incoming)
      if (!sameIdentity(received, oldIdentity)) throw new Error("The previous application changed during exchange")
      targetTrusted = true
    } else {
      exchangeAttempted = true
      // The signed sidecar owns the held parent-directory descriptors and
      // performs an identity-bound RENAME_EXCL. This is the first-install
      // commit point: a target raced into place is retained, never replaced.
      await atomicInstall(payload, swapper, newIdentity)
      activated = true
    }
    await transaction(payload, "activated", { old: oldIdentity, new: newIdentity })
    const installed = await verify(payload, payload.target)
    if (!sameIdentity(installed, newIdentity)) throw new Error("The installed update changed during activation")
    startupHealth = await waitForHealth(payload)
  } catch (error) {
    const recovery = []
    let uncertain = error?.code === "OPENSCIENCE_UPDATE_PROCESS_UNCERTAIN"
    let terminalJournal = false
    if (exchangeAttempted && newIdentity) {
      const current = await slotState(payload, oldIdentity, newIdentity)
      if (current === "activated") activated = true
      else if (current === "restored") {
        activated = false
        restored = Boolean(oldIdentity)
      } else {
        uncertain = true
        recovery.push(new Error("The atomic update exchange ended in an ambiguous state"))
      }
    }
    if (!uncertain && activated && oldIdentity && newIdentity && swapper) {
      let rollbackError
      for (let attempt = 0; attempt < 2 && !restored; attempt++) {
        await atomicSwap(payload, swapper, newIdentity, oldIdentity).catch((cause) => {
          rollbackError = cause
        })
        const current = await slotState(payload, oldIdentity, newIdentity)
        if (current === "restored") restored = true
        else if (current !== "activated") uncertain = true
      }
      if (!restored) {
        uncertain = true
        recovery.push(rollbackError ?? new Error("The previous OpenScience app could not be restored"))
      } else {
        const received = await publisher(payload, payload.target).catch((cause) => {
          recovery.push(cause)
          return undefined
        })
        targetTrusted = sameIdentity(received, oldIdentity)
        if (!targetTrusted) uncertain = true
      }
    } else if (!uncertain && activated) {
      await transaction(payload, "rolled_back", { old: oldIdentity, new: newIdentity })
      terminalJournal = true
      if (!swapper || !newIdentity) recovery.push(new Error("The exact update cleanup helper is unavailable"))
      else await exactRemove(swapper, payload.target, newIdentity).catch((cause) => recovery.push(cause))
      activated = false
    }
    if (!uncertain && restored && targetTrusted) {
      await transaction(payload, "rolled_back", { old: oldIdentity, new: newIdentity })
      terminalJournal = true
    } else if (!uncertain && !terminalJournal && !activated && !restored && stagedIdentity) {
      await transaction(payload, "aborted", { old: oldIdentity, new: stagedIdentity })
    }
    const fallback = restored && targetTrusted ? payload.target : payload.fallback
    if (!uncertain && parentExited && !skipLaunch() && !skipFallback()) {
      await openBundle(payload, fallback).catch((cause) => recovery.push(cause))
    }
    const detail = error instanceof Error ? error.message : String(error)
    await receipt(payload.result, {
      status: "failed",
      version: payload.version,
      completed_at: new Date().toISOString(),
      error: detail,
      recovery_error: recovery.length
        ? recovery.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; ")
        : undefined,
    }).catch((cause) => recovery.push(cause))
    if (!uncertain && !recovery.length) {
      await removeDurable(payload.health, { force: true }).catch((cause) => recovery.push(cause))
      if (!recovery.length) await removeDurable(payload.runtime, { force: true }).catch((cause) => recovery.push(cause))
      if (!recovery.length) await removeDurable(payload.handoff, { force: true }).catch((cause) => recovery.push(cause))
      if (!recovery.length) await removeDurable(payload.ready, { force: true }).catch((cause) => recovery.push(cause))
      if (!recovery.length && stagedIdentity) {
        if (!swapper) recovery.push(new Error("The exact update cleanup helper is unavailable"))
        else await exactRemove(swapper, payload.incoming, stagedIdentity).catch((cause) => recovery.push(cause))
      }
      if (!recovery.length && rootIdentity) {
        if (!swapper) recovery.push(new Error("The exact update cleanup helper is unavailable"))
        else await exactRemove(swapper, payload.root, rootIdentity).catch((cause) => recovery.push(cause))
      }
      if (!recovery.length) await removeDurable(payload.journal, { force: true }).catch((cause) => recovery.push(cause))
    }
    if (recovery.length) throw new AggregateError([error, ...recovery], detail)
    throw error
  }

  // The new application and its sidecar have acknowledged the exact version.
  // Cleanup failures must never roll a healthy install back; record and log
  // them while leaving the working update in place.
  await transaction(payload, "committed", { old: oldIdentity, new: newIdentity })
  await receipt(payload.result, {
    status: "succeeded",
    version: payload.version,
    completed_at: new Date().toISOString(),
    health: startupHealth,
  })
  const cleanup = []
  if (oldIdentity) await exactRemove(swapper, payload.incoming, oldIdentity).catch((cause) => cleanup.push(cause))
  if (!cleanup.length) await removeDurable(payload.health, { force: true }).catch((cause) => cleanup.push(cause))
  if (!cleanup.length) await removeDurable(payload.runtime, { force: true }).catch((cause) => cleanup.push(cause))
  if (!cleanup.length) await removeDurable(payload.handoff, { force: true }).catch((cause) => cleanup.push(cause))
  if (!cleanup.length) await removeDurable(payload.ready, { force: true }).catch((cause) => cleanup.push(cause))
  if (!cleanup.length && rootIdentity) {
    await exactRemove(swapper, payload.root, rootIdentity).catch((cause) => cleanup.push(cause))
  }
  if (!cleanup.length) await removeDurable(payload.journal, { force: true }).catch((cause) => cleanup.push(cause))
  await receipt(payload.result, {
    status: "succeeded",
    version: payload.version,
    completed_at: new Date().toISOString(),
    health: startupHealth,
    cleanup_error: cleanup.length
      ? cleanup.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; ")
      : undefined,
  })
  return cleanup
}

const payload = decode(process.argv[2] ?? "")
const log = path.join(path.dirname(payload.root), "update.log")

await install(payload).then(
  async (cleanup) => {
    if (!cleanup.length) return
    await appendFile(
      log,
      `${new Date().toISOString()} update installed with cleanup warnings: ${cleanup
        .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
        .join("; ")}\n`,
      { mode: 0o600 },
    )
  },
  async (error) => {
    await appendFile(log, `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, {
      mode: 0o600,
    })
    process.exitCode = 1
  },
)
