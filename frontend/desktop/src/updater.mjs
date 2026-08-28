import { createHash, randomBytes } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

const exec = promisify(execFile)
const api = "https://api.github.com/repos/synthetic-sciences/openscience"
const id = "ai.syntheticsciences.openscience"

function valid(version) {
  return /^\d+\.\d+\.\d+$/.test(version)
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
  const response = await (options.fetch ?? fetch)(`${base}/releases/tags/v${version}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `OpenScience/${version}`,
    },
    signal: AbortSignal.timeout(30_000),
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
  if (!URL.canParse(found.browser_download_url ?? "")) throw new Error(`${name} has no valid download URL`)
  return {
    version,
    name,
    url: found.browser_download_url,
    digest: found.digest.slice("sha256:".length),
  }
}

async function download(url, file, options = {}) {
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "User-Agent": `OpenScience/${options.version}` },
    redirect: "follow",
    signal: AbortSignal.timeout(30 * 60_000),
  })
  if (!response.ok || !response.body) throw new Error(`OpenScience update download failed (${response.status})`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { mode: 0o600 }))
}

export async function verify(bundle, version) {
  const plist = path.join(bundle, "Contents", "Info.plist")
  const [identifier, current] = await Promise.all([
    exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist]),
    exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]),
  ])
  if (identifier.stdout.trim() !== id) throw new Error("The downloaded update has the wrong application identifier")
  if (current.stdout.trim() !== version) throw new Error("The downloaded update has the wrong application version")
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])
}

export async function stage(version, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Desktop self-updates require macOS")
  const info = await release(version, options)
  await mkdir(options.cache, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(options.cache, "pending-"))
  const prepare = async () => {
    const archive = path.join(root, info.name)
    await download(info.url, archive, { fetch: options.fetch, version })
    const digest = await checksum(archive)
    if (digest !== info.digest) throw new Error(`OpenScience update digest mismatch for ${info.name}`)
    const output = path.join(root, "app")
    await mkdir(output, { mode: 0o700 })
    await exec("/usr/bin/ditto", ["-x", "-k", archive, output])
    const bundles = (await readdir(output, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    )
    if (bundles.length !== 1) throw new Error("The OpenScience update archive must contain exactly one app")
    const bundle = path.join(output, bundles[0].name)
    await verify(bundle, version)
    return { root, bundle, version }
  }
  return prepare().catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
}

export function current(executable = process.execPath) {
  const bundle = path.resolve(path.dirname(executable), "../..")
  if (!bundle.endsWith(".app")) throw new Error(`OpenScience is not running from an application bundle: ${bundle}`)
  return bundle
}

export async function apply(update, options = {}) {
  const active = options.current ?? current(options.executable)
  if (active.startsWith("/Volumes/")) {
    throw new Error("Move OpenScience to Applications before installing an update")
  }
  await access(path.dirname(active), constants.W_OK)
  const helper = path.join(update.root, "update-helper.mjs")
  await copyFile(new URL("./update-helper.mjs", import.meta.url), helper)
  await chmod(helper, 0o700)
  const payload = Buffer.from(
    JSON.stringify({
      parent: process.pid,
      current: active,
      staged: update.bundle,
      backup: `${active.slice(0, -4)}.previous-${randomBytes(8).toString("hex")}.app`,
      root: update.root,
    }),
  ).toString("base64url")
  const child = spawn(options.executable ?? process.execPath, [helper, payload], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  })
  child.unref()
}
