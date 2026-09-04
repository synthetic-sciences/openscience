import { createHash, randomBytes } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { constants, createReadStream, createWriteStream } from "node:fs"
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

const execute = promisify(execFile)
const exec = (file, args, options = {}) =>
  execute(file, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024, ...options })
const api = "https://api.github.com/repos/synthetic-sciences/openscience"
const id = "ai.syntheticsciences.openscience"
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
// How long the detached helper may take to verify the handoff and write its
// receipt before the launch is revoked.
const HANDOFF_TIMEOUT = 30_000

function valid(version) {
  return /^\d+\.\d+\.\d+$/.test(version)
}

export function newer(current, target) {
  if (!valid(current) || !valid(target)) return false
  const left = current.split(".").map(Number)
  const right = target.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    if (right[index] > left[index]) return true
    if (right[index] < left[index]) return false
  }
  return false
}

export function asset(arch = process.arch) {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS architecture: ${arch}`)
  return `OpenScience-mac-${arch}.zip`
}

export async function checksum(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

export async function release(version, options = {}) {
  if (!valid(version)) throw new Error(`Invalid OpenScience update version: ${version}`)
  const base = options.api ?? api
  const timeout = AbortSignal.timeout(30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await (options.fetch ?? fetch)(`${base}/releases/tags/v${version}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `OpenScience/${version}`,
    },
    signal,
  })
  if (!response.ok) throw new Error(`OpenScience ${version} release metadata is unavailable (${response.status})`)
  const data = await response.json()
  if (data.tag_name !== `v${version}` || data.draft || data.prerelease) {
    throw new Error(`OpenScience ${version} is not a published stable release`)
  }
  const name = asset(options.arch)
  const found = data.assets?.find((item) => item.name === name)
  if (!found) throw new Error(`OpenScience ${version} is missing ${name}`)
  if (!/^sha256:[0-9a-f]{64}$/.test(found.digest ?? "")) {
    throw new Error(`${name} has no trusted GitHub SHA-256 digest`)
  }
  if (!Number.isSafeInteger(found.size) || found.size <= 0 || found.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`${name} has an invalid release size`)
  }
  if (!URL.canParse(found.browser_download_url ?? "")) throw new Error(`${name} has no valid download URL`)
  return {
    version,
    name,
    url: found.browser_download_url,
    digest: found.digest.slice("sha256:".length),
    size: found.size,
  }
}

async function download(url, file, options = {}) {
  const timeout = AbortSignal.timeout(30 * 60_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "User-Agent": `OpenScience/${options.version}` },
    redirect: "follow",
    signal,
  })
  if (!response.ok || !response.body) throw new Error(`OpenScience update download failed (${response.status})`)
  const header = response.headers.get("content-length")
  const total = header && /^\d+$/.test(header) ? Number(header) : options.expectedSize
  if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0 || total > MAX_ARCHIVE_BYTES)) {
    throw new Error("OpenScience update download has an invalid size")
  }
  if (options.expectedSize && total && total !== options.expectedSize) {
    throw new Error("OpenScience update size does not match the published release")
  }
  let transferred = 0
  const progress = new TransformStream({
    transform(chunk, controller) {
      transferred += chunk.byteLength
      if (transferred > (options.expectedSize ?? MAX_ARCHIVE_BYTES)) {
        throw new Error("OpenScience update download exceeded the published release size")
      }
      options.onProgress?.({ phase: "downloading", transferred, total })
      controller.enqueue(chunk)
    },
  })
  options.onProgress?.({ phase: "downloading", transferred: 0, total })
  await pipeline(Readable.fromWeb(response.body.pipeThrough(progress)), createWriteStream(file, { mode: 0o600 }), {
    signal,
  })
  if (options.expectedSize && transferred !== options.expectedSize) {
    throw new Error("OpenScience update download is incomplete")
  }
}

function output(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
}

export async function signature(bundle, options = {}) {
  const command = options.signal ? { signal: options.signal } : undefined
  const details = await exec("/usr/bin/codesign", ["-d", "--verbose=4", bundle], command)
  const team = output(details)
    .match(/^TeamIdentifier=(.+)$/m)?.[1]
    ?.trim()
  const requirement = await exec("/usr/bin/codesign", ["-d", "-r", "-", bundle], command)
  const designated = output(requirement)
    .match(/designated\s*=>\s*(.+)$/m)?.[1]
    ?.trim()
  if (!team || !designated) throw new Error("OpenScience update is not signed by an identified Apple development team")
  return { team, designated }
}

export async function verify(bundle, version, options = {}) {
  const command = options.signal ? { signal: options.signal } : undefined
  const plist = path.join(bundle, "Contents", "Info.plist")
  const [identifier, current] = await Promise.all([
    exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist], command),
    exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist], command),
  ])
  if (identifier.stdout.trim() !== id) throw new Error("The downloaded update has the wrong application identifier")
  if (current.stdout.trim() !== version) throw new Error("The downloaded update has the wrong application version")
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], command)
  if (!options.trusted) return
  const assessment = await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle], command)
  if (!/source=Notarized Developer ID/m.test(output(assessment))) {
    throw new Error("The update did not pass macOS notarized Developer ID assessment")
  }
  const received = await signature(bundle, options)
  if (!options.current) return received
  const installed = await signature(options.current, options)
  if (installed.team !== received.team || installed.designated !== received.designated) {
    throw new Error("The downloaded update is not signed by the same OpenScience publisher as the installed app")
  }
  return received
}

async function identity(bundle) {
  const plist = path.join(bundle, "Contents", "Info.plist")
  const result = await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist])
  if (result.stdout.trim() !== id) throw new Error("The existing Applications item is not OpenScience")
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

export async function stage(version, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Desktop self-updates require macOS")
  if (options.currentVersion && !newer(options.currentVersion, version)) {
    throw new Error(`OpenScience ${version} is not newer than the installed ${options.currentVersion}`)
  }
  const info = await release(version, options)
  await mkdir(options.cache, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(options.cache, "pending-"))
  const prepare = async () => {
    const archive = path.join(root, info.name)
    await download(info.url, archive, {
      fetch: options.fetch,
      version,
      signal: options.signal,
      onProgress: options.onProgress,
      expectedSize: info.size,
    })
    options.onProgress?.({ phase: "verifying", transferred: undefined, total: undefined })
    const digest = await checksum(archive)
    if (digest !== info.digest) throw new Error(`OpenScience update digest mismatch for ${info.name}`)
    const output = path.join(root, "app")
    await mkdir(output, { mode: 0o700 })
    options.onProgress?.({ phase: "extracting", transferred: undefined, total: undefined })
    await exec("/usr/bin/ditto", ["-x", "-k", archive, output], { signal: options.signal })
    const entries = await readdir(output, { withFileTypes: true })
    if (entries.length !== 1 || entries[0].name !== "OpenScience.app" || !entries[0].isDirectory()) {
      throw new Error("The OpenScience update archive must contain only OpenScience.app")
    }
    const bundle = path.join(output, entries[0].name)
    options.onProgress?.({ phase: "verifying", transferred: undefined, total: undefined })
    const trust = await verify(bundle, version, {
      trusted: options.trusted,
      current: options.current,
      signal: options.signal,
    })
    const manifest = {
      schema: 1,
      status: "ready",
      version,
      name: info.name,
      digest: info.digest,
      size: info.size,
      bundle,
      trust,
    }
    await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
    return { root, bundle, version, digest: info.digest, trust }
  }
  return prepare().catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
}

function contained(root, file) {
  const relative = path.relative(root, file)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function validEntry(value) {
  return (
    Number.isSafeInteger(value?.dev) &&
    value.dev >= 0 &&
    Number.isSafeInteger(value?.ino) &&
    value.ino > 0 &&
    value.type === "directory"
  )
}

function sameEntry(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.type === right.type)
}

function supervisedTransaction(transaction, options) {
  const supervised = options.supervised
  return Boolean(
    supervised &&
    (transaction.state === "activated" || transaction.state === "committed") &&
    transaction.token === supervised.token &&
    transaction.version === supervised.version &&
    transaction.health === supervised.receipt &&
    transaction.runtime === supervised.runtime &&
    transaction.target === options.current,
  )
}

export function trustedTransaction(value, required) {
  return Boolean(
    value?.trusted === true &&
    typeof required?.team === "string" &&
    required.team &&
    typeof required?.designated === "string" &&
    required.designated &&
    value.trust?.team === required.team &&
    value.trust?.designated === required.designated,
  )
}

async function directoryEntry(file) {
  const stats = await lstat(file).catch(() => undefined)
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return
  return { dev: stats.dev, ino: stats.ino, type: "directory" }
}

async function verifyPublisher(bundle, transaction) {
  await identity(bundle)
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])
  if (!transaction.trusted) return
  const received = await signature(bundle)
  if (received.team !== transaction.trust.team || received.designated !== transaction.trust.designated) {
    throw new Error("An interrupted update retained an app from a different publisher")
  }
}

function validateTransaction(cache, file, value) {
  const token = path.basename(file).match(/^transaction-([0-9a-f]{48})\.json$/)?.[1]
  if (!token || value?.schema !== 1 || value.token !== token || !valid(value.version)) return
  if (!Number.isInteger(value.helper_pid) || value.helper_pid <= 0) return
  if (!["copying", "incoming_ready", "activated", "committed", "rolled_back", "aborted"].includes(value.state)) {
    return
  }
  if (typeof value.replace !== "boolean" || typeof value.trusted !== "boolean") return
  for (const key of ["target", "incoming", "fallback", "root", "health", "runtime", "handoff", "ready", "result"]) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || path.normalize(value[key]) !== value[key]) {
      return
    }
  }
  if (
    path.dirname(value.root) !== cache ||
    !/^(?:pending|install)-/.test(path.basename(value.root)) ||
    path.basename(value.target) !== "OpenScience.app" ||
    path.dirname(value.incoming) !== path.dirname(value.target) ||
    !/^OpenScience\.incoming-[0-9a-f]{16}\.app$/.test(path.basename(value.incoming)) ||
    !value.fallback.endsWith(".app") ||
    path.dirname(value.health) !== cache ||
    path.basename(value.health) !== `health-${token}.json` ||
    path.dirname(value.runtime) !== cache ||
    path.basename(value.runtime) !== `runtime-${token}.json` ||
    path.dirname(value.handoff) !== cache ||
    path.basename(value.handoff) !== `handoff-${token}.json` ||
    path.dirname(value.ready) !== cache ||
    path.basename(value.ready) !== `helper-${token}.json` ||
    path.dirname(value.result) !== cache ||
    path.basename(value.result) !== "last-result.json" ||
    !validEntry(value.root_identity) ||
    !validEntry(value.new_identity) ||
    (value.replace && !validEntry(value.old_identity)) ||
    (value.trusted && (typeof value.trust?.team !== "string" || typeof value.trust?.designated !== "string"))
  ) {
    return
  }
  const updated = Date.parse(value.updated_at)
  if (!Number.isFinite(updated)) return
  return { ...value, file, updated }
}

async function removeTransactionPath(file, expected, executable) {
  const current = await directoryEntry(file)
  if (!current) return
  if (expected && !sameEntry(current, expected)) {
    throw new Error(`Interrupted update path changed before cleanup: ${file}`)
  }
  if (!expected || !executable) throw new Error(`Exact interrupted-update cleanup is unavailable for ${file}`)
  const request = Buffer.from(JSON.stringify({ action: "remove", target: file, target_identity: expected })).toString(
    "base64url",
  )
  await exec(executable, ["--desktop-update-swap", request])
  if (await directoryEntry(file)) throw new Error(`Interrupted update cleanup did not remove ${file}`)
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function durableJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  const handle = await open(temporary, "w", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  await syncDirectory(path.dirname(file))
}

async function removeDurable(file) {
  await rm(file, { force: true })
  await syncDirectory(path.dirname(file))
}

async function recordRecoveredResult(transaction, status, error) {
  await durableJson(transaction.result, {
    status,
    version: transaction.version,
    completed_at: new Date().toISOString(),
    error,
    recovered: true,
  })
}

async function rewriteTransaction(transaction, state) {
  const { file, updated: _updated, ...value } = transaction
  await durableJson(file, { ...value, state, updated_at: new Date().toISOString() })
}

async function invokeAtomicSwap(executable, transaction, target, incoming) {
  const request = Buffer.from(
    JSON.stringify({
      action: "swap",
      target: transaction.target,
      incoming: transaction.incoming,
      target_identity: target,
      incoming_identity: incoming,
    }),
  ).toString("base64url")
  await exec(executable, ["--desktop-update-swap", request])
}

export async function reconcileTransactions(cache, options = {}) {
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const requiredTrust = options.trusted
    ? await verify(options.current, options.currentVersion, { trusted: true, current: options.current })
    : undefined
  const names = (await readdir(cache)).filter((name) => /^transaction-[0-9a-f]{48}\.json$/.test(name))
  // Newest journals first, so the bounded pass never drops the most recent
  // interrupted update in favour of stale ones.
  const stamped = await Promise.all(
    names.map((name) =>
      lstat(path.join(cache, name)).then(
        (info) => ({ name, updated: info.mtimeMs }),
        () => ({ name, updated: 0 }),
      ),
    ),
  )
  const files = stamped
    .sort((left, right) => right.updated - left.updated)
    .slice(0, 16)
    .map((entry) => entry.name)
  let relaunch
  let inProgress = false
  for (const name of files) {
    const file = path.join(cache, name)
    const transaction = await readFile(file, "utf8")
      .then((value) => validateTransaction(cache, file, JSON.parse(value)))
      .catch(() => undefined)
    if (!transaction) continue
    if (requiredTrust && !trustedTransaction(transaction, requiredTrust)) {
      throw new Error("The interrupted update journal does not match the installed app publisher")
    }
    // The freshly activated app starts while its exact helper is still
    // supervising startup health. Its signed health token and cache-bound
    // receipt paths identify that one expected journal; every other live
    // helper remains a conflicting installation.
    if (processAlive(transaction.helper_pid)) {
      if (supervisedTransaction(transaction, options)) continue
      inProgress = true
      continue
    }

    const root = await directoryEntry(transaction.root)
    if (root && !sameEntry(root, transaction.root_identity)) {
      throw new Error(`Interrupted update root changed before recovery: ${transaction.root}`)
    }
    let [target, incoming] = await Promise.all([
      directoryEntry(transaction.target),
      directoryEntry(transaction.incoming),
    ])
    let phase = transaction.state

    if (phase === "copying") {
      if (transaction.replace ? !sameEntry(target, transaction.old_identity) : Boolean(target)) {
        throw new Error("Interrupted update target changed before activation")
      }
      if (incoming && !sameEntry(incoming, transaction.new_identity)) {
        throw new Error("Interrupted update copy changed before recovery")
      }
      await rewriteTransaction(transaction, "aborted")
      phase = "aborted"
    }

    // The filesystem exchange is the commit point. A process can die after
    // that atomic mutation but before it advances the journal, so derive the
    // real phase from the authenticated inode pair rather than trusting the
    // last label alone.
    const staged =
      sameEntry(incoming, transaction.new_identity) &&
      (transaction.replace ? sameEntry(target, transaction.old_identity) : !target)
    const activated =
      sameEntry(target, transaction.new_identity) &&
      (transaction.replace ? sameEntry(incoming, transaction.old_identity) : !incoming)

    const discarded = !incoming && (transaction.replace ? sameEntry(target, transaction.old_identity) : !target)

    if (phase === "incoming_ready") {
      if (activated) {
        phase = "activated"
      } else if (staged || discarded) {
        if (incoming) await verify(transaction.incoming, transaction.version, { trusted: transaction.trusted })
        if (transaction.replace) await verifyPublisher(transaction.target, transaction)
        await rewriteTransaction(transaction, "aborted")
        phase = "aborted"
      } else {
        throw new Error("Interrupted update slots have an unknown identity")
      }
    }

    if (phase === "activated") {
      if (staged) {
        await rewriteTransaction(transaction, "rolled_back")
        phase = "rolled_back"
      } else if (activated) {
        const health = await readFile(transaction.health, "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => undefined)
        const currentHealthy = options.healthyCurrent === true && options.current === transaction.target
        const healthy =
          health?.healthy === true && health.token === transaction.token && health.version === transaction.version
        const failed =
          health?.healthy === false &&
          health.safe_to_terminate === true &&
          health.token === transaction.token &&
          health.version === transaction.version

        if (healthy || currentHealthy) {
          await rewriteTransaction(transaction, "committed")
          phase = "committed"
        } else if (failed) {
          if (transaction.replace) {
            if (!options.swapExecutable) throw new Error("Atomic update recovery helper is unavailable")
            await invokeAtomicSwap(
              options.swapExecutable,
              transaction,
              transaction.new_identity,
              transaction.old_identity,
            )
            ;[target, incoming] = await Promise.all([
              directoryEntry(transaction.target),
              directoryEntry(transaction.incoming),
            ])
            if (!sameEntry(target, transaction.old_identity) || !sameEntry(incoming, transaction.new_identity)) {
              throw new Error("Interrupted update rollback did not restore the approved application")
            }
          }
          await rewriteTransaction(transaction, "rolled_back")
          phase = "rolled_back"
        } else {
          continue
        }
      } else {
        throw new Error("Interrupted update slots have an unknown identity")
      }
    }

    if (phase === "committed") {
      const committed =
        sameEntry(target, transaction.new_identity) &&
        (transaction.replace ? !incoming || sameEntry(incoming, transaction.old_identity) : !incoming)
      if (!committed) throw new Error("Committed update slots have an unknown identity")
      const received = await verify(transaction.target, transaction.version, { trusted: transaction.trusted })
      if (
        transaction.trusted &&
        (received?.team !== transaction.trust.team || received?.designated !== transaction.trust.designated)
      ) {
        throw new Error("Recovered update publisher identity does not match its journal")
      }
      if (incoming) await verifyPublisher(transaction.incoming, transaction)
      await recordRecoveredResult(transaction, "succeeded")
      if (incoming) await removeTransactionPath(transaction.incoming, transaction.old_identity, options.swapExecutable)
      await removeTransactionPath(transaction.root, transaction.root_identity, options.swapExecutable)
      await removeDurable(transaction.health)
      await removeDurable(transaction.runtime)
      await removeDurable(transaction.handoff)
      await removeDurable(transaction.ready)
      await removeDurable(file)
      continue
    }

    if (phase === "rolled_back") {
      if (transaction.replace) {
        if (
          !sameEntry(target, transaction.old_identity) ||
          (incoming && !sameEntry(incoming, transaction.new_identity))
        ) {
          throw new Error("Rolled-back update slots have an unknown identity")
        }
        await verifyPublisher(transaction.target, transaction)
      } else {
        if (incoming || (target && !sameEntry(target, transaction.new_identity))) {
          throw new Error("Rolled-back first-install slots have an unknown identity")
        }
        if (target) await removeTransactionPath(transaction.target, transaction.new_identity, options.swapExecutable)
        await verifyPublisher(transaction.fallback, transaction)
      }
      if (options.currentVersion === transaction.version) {
        relaunch = transaction.replace ? transaction.target : transaction.fallback
      }
      await recordRecoveredResult(transaction, "failed", "The interrupted update was rolled back before startup health")
      if (incoming) await removeTransactionPath(transaction.incoming, transaction.new_identity, options.swapExecutable)
      await removeTransactionPath(transaction.root, transaction.root_identity, options.swapExecutable)
      await removeDurable(transaction.health)
      await removeDurable(transaction.runtime)
      await removeDurable(transaction.handoff)
      await removeDurable(transaction.ready)
      await removeDurable(file)
      continue
    }

    if (phase === "aborted") {
      if (transaction.replace ? !sameEntry(target, transaction.old_identity) : Boolean(target)) {
        throw new Error("Aborted update target changed before recovery")
      }
      if (incoming && !sameEntry(incoming, transaction.new_identity)) {
        throw new Error("Aborted update copy changed before recovery")
      }
      if (incoming) await removeTransactionPath(transaction.incoming, transaction.new_identity, options.swapExecutable)
      await removeTransactionPath(transaction.root, transaction.root_identity, options.swapExecutable)
      await removeDurable(transaction.health)
      await removeDurable(transaction.runtime)
      await removeDurable(transaction.handoff)
      await removeDurable(transaction.ready)
      await removeDurable(file)
      continue
    }

    throw new Error(`Unsupported interrupted update phase: ${phase}`)
  }
  return { relaunch, inProgress }
}

export async function recover(cache, options = {}) {
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const entries = await readdir(cache, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("pending-")) continue
    const root = path.join(cache, entry.name)
    const candidate = await readFile(path.join(root, "manifest.json"), "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => undefined)
    const validManifest =
      candidate?.schema === 1 &&
      candidate?.status === "ready" &&
      valid(candidate?.version) &&
      /^[0-9a-f]{64}$/.test(candidate?.digest ?? "") &&
      Number.isSafeInteger(candidate?.size) &&
      candidate.size > 0 &&
      candidate.size <= MAX_ARCHIVE_BYTES &&
      typeof candidate?.bundle === "string" &&
      path.isAbsolute(candidate.bundle) &&
      contained(root, candidate.bundle) &&
      path.basename(candidate.bundle) === "OpenScience.app"
    if (!validManifest || (options.currentVersion && !newer(options.currentVersion, candidate.version))) {
      await rm(root, { recursive: true, force: true })
      continue
    }
    // A candidate that fails verification is discarded regardless of trust.
    // Untrusted verification still proves identifier, version, and a valid
    // code signature (it only skips notarization) and resolves without a
    // publisher identity, so success is tracked separately from its value.
    const verified = await verify(candidate.bundle, candidate.version, {
      trusted: options.trusted,
      current: options.current,
    }).then(
      (trust) => ({ trust }),
      () => undefined,
    )
    if (!verified) {
      await rm(root, { recursive: true, force: true })
      continue
    }
    candidates.push({
      root,
      bundle: candidate.bundle,
      version: candidate.version,
      digest: candidate.digest,
      size: candidate.size,
      trust: verified.trust,
    })
  }
  candidates.sort((left, right) =>
    newer(left.version, right.version) ? 1 : newer(right.version, left.version) ? -1 : 0,
  )
  const keep = candidates.at(-1)
  await Promise.all(
    candidates
      .filter((candidate) => candidate !== keep)
      .map((candidate) => rm(candidate.root, { recursive: true, force: true })),
  )
  return keep
}

export async function discard(update) {
  if (!update?.root || !path.isAbsolute(update.root)) throw new Error("The staged update root is invalid")
  await rm(update.root, { recursive: true, force: true })
}

export function current(executable = process.execPath) {
  const bundle = path.resolve(path.dirname(executable), "../..")
  if (!bundle.endsWith(".app")) throw new Error(`OpenScience is not running from an application bundle: ${bundle}`)
  return bundle
}

export function portable(bundle) {
  return bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")
}

async function writable(directory) {
  return access(directory, constants.W_OK).then(
    () => true,
    () => false,
  )
}

export async function destination(bundle, options = {}) {
  if (!portable(bundle)) {
    if (await writable(path.dirname(bundle))) return bundle
    if (!options.allowUserMigration) {
      throw new Error(
        "OpenScience cannot update this administrator-owned Applications folder. Move the app to your user Applications folder to continue.",
      )
    }
  }
  if (portable(bundle)) {
    const system = options.applications ?? "/Applications"
    if (await writable(system)) return path.join(system, "OpenScience.app")
  }
  const user = options.userApplications ?? path.join(os.homedir(), "Applications")
  await mkdir(user, { recursive: true, mode: 0o755 })
  await access(user, constants.W_OK)
  return path.join(user, "OpenScience.app")
}

async function replacement(bundle, options = {}) {
  const result = await lstat(bundle).then(
    (value) => value,
    (error) => error,
  )
  if (result instanceof Error) {
    if ("code" in result && result.code === "ENOENT") return
    throw result
  }
  if (!result.isDirectory() || result.isSymbolicLink()) {
    throw new Error(`OpenScience cannot replace the existing item at ${bundle}`)
  }
  if (!valid(options.version)) throw new Error("The replacement update version is invalid")
  const installedVersion = (
    await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(bundle, "Contents", "Info.plist"),
    ])
  ).stdout.trim()
  if (!valid(installedVersion) || !newer(installedVersion, options.version)) {
    throw new Error(
      `OpenScience ${installedVersion || "at this location"} is already the same version or newer than ${options.version}`,
    )
  }
  await identity(bundle)
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])
  if (options.trusted) {
    const current = await signature(bundle)
    if (current.team !== options.expected?.team || current.designated !== options.expected?.designated) {
      throw new Error("The existing OpenScience app is signed by a different publisher")
    }
  }
  const after = await lstat(bundle)
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== result.dev || after.ino !== result.ino) {
    throw new Error("The existing OpenScience application changed during replacement approval")
  }
  return { dev: result.dev, ino: result.ino, type: "directory" }
}

export async function stageCurrent(options = {}) {
  const bundle = options.current ?? current(options.executable)
  const plist = path.join(bundle, "Contents", "Info.plist")
  const value = await exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist])
  const version = value.stdout.trim()
  if (!valid(version)) throw new Error(`Invalid installed OpenScience version: ${version}`)
  await mkdir(options.cache, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(options.cache, "install-"))
  const staged = path.join(root, "app", "OpenScience.app")
  const prepare = async () => {
    await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 })
    await exec("/usr/bin/ditto", [bundle, staged])
    await copyQuarantine(bundle, staged)
    const trust = await verify(staged, version, { trusted: options.trusted, current: bundle })
    return { root, bundle: staged, version, trust }
  }
  return prepare().catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
}

export async function apply(update, options = {}) {
  const active = options.current ?? current(options.executable)
  const target = await destination(active, options)
  if (path.basename(target) !== "OpenScience.app") {
    throw new Error("In-app updates require the application to be named OpenScience.app")
  }
  const approvedTarget = await replacement(target, {
    trusted: Boolean(options.trusted),
    expected: update.trust,
    version: update.version,
  })
  const replace = Boolean(approvedTarget)
  const helper = path.join(update.root, "update-helper.mjs")
  await copyFile(new URL("./update-helper.mjs", import.meta.url), helper)
  await chmod(helper, 0o700)
  const token = randomBytes(24).toString("hex")
  const nonce = randomBytes(8).toString("hex")
  const cache = path.dirname(update.root)
  const handoff = path.join(cache, `handoff-${token}.json`)
  const ready = path.join(cache, `helper-${token}.json`)
  const payload = Buffer.from(
    JSON.stringify({
      parent: process.pid,
      target,
      incoming: path.join(path.dirname(target), `OpenScience.incoming-${nonce}.app`),
      fallback: active,
      staged: update.bundle,
      root: update.root,
      replace,
      old_identity: approvedTarget,
      version: update.version,
      health: path.join(cache, `health-${token}.json`),
      runtime: path.join(cache, `runtime-${token}.json`),
      handoff,
      ready,
      journal: path.join(cache, `transaction-${token}.json`),
      result: path.join(cache, "last-result.json"),
      token,
      trusted: Boolean(options.trusted),
      trust: update.trust,
    }),
  ).toString("base64url")
  return {
    target,
    installed: target !== active,
    helper,
    handoff,
    ready,
    token,
    version: update.version,
    parent: process.pid,
    executable: options.executable ?? process.execPath,
    payload,
  }
}

export async function launch(prepared) {
  if (
    !prepared ||
    prepared.parent !== process.pid ||
    typeof prepared.payload !== "string" ||
    !/^[0-9a-f]{48}$/.test(prepared.token ?? "") ||
    !valid(prepared.version) ||
    !path.isAbsolute(prepared.helper ?? "") ||
    !path.isAbsolute(prepared.handoff ?? "") ||
    path.basename(prepared.handoff) !== `handoff-${prepared.token}.json` ||
    !path.isAbsolute(prepared.ready ?? "") ||
    path.basename(prepared.ready) !== `helper-${prepared.token}.json`
  ) {
    throw new Error("The prepared desktop update handoff is invalid")
  }
  await durableJson(prepared.handoff, {
    schema: 1,
    authorized: true,
    token: prepared.token,
    version: prepared.version,
    parent: process.pid,
    authorized_at: new Date().toISOString(),
  })
  const child = spawn(prepared.executable, [prepared.helper, prepared.payload], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  })
  const waitForChild = (timeout) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (exited) => {
        clearTimeout(timer)
        child.off("exit", onExit)
        resolve(exited)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(false), timeout)
      child.once("exit", onExit)
    })
  }
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    let confirmed = false
    const deadline = Date.now() + HANDOFF_TIMEOUT
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The desktop update helper exited before accepting the safe handoff")
      }
      const receipt = await readFile(prepared.ready, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => undefined)
      if (
        receipt?.schema === 1 &&
        receipt?.ready === true &&
        receipt?.token === prepared.token &&
        receipt?.version === prepared.version &&
        receipt?.parent === process.pid &&
        receipt?.helper_pid === child.pid
      ) {
        confirmed = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!confirmed) throw new Error("The desktop update helper did not accept the safe handoff")
  } catch (error) {
    await Promise.all([
      removeDurable(prepared.handoff).catch(() => undefined),
      removeDurable(prepared.ready).catch(() => undefined),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      if (!(await waitForChild(2_000))) {
        child.kill("SIGKILL")
        if (!(await waitForChild(2_000))) {
          throw new AggregateError(
            [error, new Error("The rejected desktop update helper could not be revoked")],
            "OpenScience retained the current app because the update helper did not stop safely",
          )
        }
      }
    }
    throw error
  }
  child.unref()
  return { target: prepared.target, scheduled: true, installed: prepared.installed, helper_pid: child.pid }
}
