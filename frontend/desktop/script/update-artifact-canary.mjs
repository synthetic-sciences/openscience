import { execFile } from "node:child_process"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { asset, checksum, discard, stage, verify } from "../src/updater.mjs"

const execute = promisify(execFile)

async function codeDirectoryHash(bundle) {
  const result = await execute("/usr/bin/codesign", ["-d", "--verbose=4", bundle])
  const hash = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/^CDHash=([0-9a-f]+)$/m)?.[1]
  if (!hash) throw new Error("Updater canary could not read the signed app CodeDirectory hash")
  return hash
}
const input = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid updater canary argument: ${key ?? ""}`)
  input.set(key.slice(2), value)
}

function required(key) {
  const value = input.get(key)
  if (!value) throw new Error(`Missing updater canary --${key}`)
  return value
}

const archive = path.resolve(required("zip"))
const current = path.resolve(required("current"))
const version = required("version")
const arch = required("arch")
const trusted = required("trusted") === "true"
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid updater canary version: ${version}`)
if (arch !== "arm64" && arch !== "x64") throw new Error(`Invalid updater canary architecture: ${arch}`)
if (process.arch !== arch) {
  throw new Error(`The ${arch} updater artifact must be verified on native ${arch} macOS, not ${process.arch}`)
}
if (path.basename(archive) !== asset(arch)) throw new Error(`Updater canary received the wrong archive for ${arch}`)

const archiveInfo = await lstat(archive)
if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size <= 0) {
  throw new Error("Updater canary archive is not a real, non-empty file")
}
const digest = await checksum(archive)
const workspace = await mkdtemp(path.join(os.tmpdir(), "openscience-update-artifact-"))
let prepared
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === `/releases/tags/v${version}`) {
      return Response.json({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: asset(arch),
            digest: `sha256:${digest}`,
            size: archiveInfo.size,
            browser_download_url: new URL("/asset", server.url).toString(),
          },
        ],
      })
    }
    if (url.pathname === "/asset") return new Response(Bun.file(archive))
    return new Response("Not found", { status: 404 })
  },
})

try {
  await verify(current, version, { trusted, current })
  prepared = await stage(version, {
    api: server.url.toString().replace(/\/$/, ""),
    arch,
    cache: workspace,
    current,
    trusted,
  })
  if (trusted) {
    const [installerHash, updaterHash] = await Promise.all([
      codeDirectoryHash(current),
      codeDirectoryHash(prepared.bundle),
    ])
    if (installerHash !== updaterHash) {
      throw new Error("The immutable DMG and updater ZIP do not contain the same signed OpenScience app")
    }
  }
  const sidecar = path.join(prepared.bundle, "Contents", "Resources", "sidecar", "openscience")
  const sidecarInfo = await lstat(sidecar)
  if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink()) {
    throw new Error("Updater canary archive has no real bundled runtime sidecar")
  }
  const isolated = path.join(workspace, "runtime")
  const result = await execute(sidecar, ["--version"], {
    timeout: 30_000,
    env: {
      ...process.env,
      OPENSCIENCE_CONFIG_DIR: path.join(isolated, "config"),
      OPENSCIENCE_DATA_DIR: path.join(isolated, "data"),
      OPENSCIENCE_TEST_HOME: path.join(isolated, "home"),
    },
  })
  if (result.stdout.trim() !== version) {
    throw new Error(`Updater canary sidecar reported ${result.stdout.trim() || "no version"}, expected ${version}`)
  }
  console.log(`verified ${path.basename(archive)} against ${current}`)
} finally {
  server.stop(true)
  if (prepared) await discard(prepared).catch(() => undefined)
  await rm(workspace, { recursive: true, force: true })
}
