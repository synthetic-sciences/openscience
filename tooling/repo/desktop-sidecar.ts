#!/usr/bin/env bun

import path from "node:path"
import os from "node:os"
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { $ } from "bun"

const sidecars = {
  "backend/cli/dist/@synsci/openscience-darwin-arm64/bin/openscience": "openscience-darwin-arm64.zip",
  "backend/cli/dist/@synsci/openscience-darwin-x64/bin/openscience": "openscience-darwin-x64.zip",
  "backend/cli/dist/@synsci/openscience-windows-x64/bin/openscience.exe": "openscience-windows-x64.zip",
  "backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience": "openscience-linux-x64.tar.gz",
  "backend/cli/dist/@synsci/openscience-linux-arm64/bin/openscience": "openscience-linux-arm64.tar.gz",
} as const

export function selectSidecar(sidecar: string, manifest: string, source: string, version: string) {
  if (!Object.hasOwn(sidecars, sidecar)) throw new Error("Sidecar is not a desktop matrix target")
  if (!/^[0-9a-f]{40}$/i.test(source) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Sidecar requires an immutable release source and stable version")
  }
  const receipt = JSON.parse(manifest) as { source: string; version: string; checksums: Record<string, string> }
  if (receipt.source !== source || receipt.version !== version)
    throw new Error("Sidecar manifest source/version mismatch")
  const asset = sidecars[sidecar as keyof typeof sidecars]
  const digest = receipt.checksums[asset]
  if (!/^[0-9a-f]{64}$/.test(digest ?? "")) throw new Error("Sidecar manifest is missing its SHA-256 digest")
  return { asset, digest, member: path.basename(sidecar), destination: path.resolve(sidecar) }
}

export function verifySidecarAsset(asset: { state: string; size: number; digest: string } | undefined, digest: string) {
  if (
    !asset ||
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.digest !== `sha256:${digest}`
  ) {
    throw new Error("Native release asset does not match the source-bound sidecar digest")
  }
}

export async function extractSidecar(archive: string, destination: string, member: string, digest: string) {
  const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
  if (actual !== digest) throw new Error("Downloaded sidecar archive failed SHA-256 verification")
  if (!["openscience", "openscience.exe"].includes(member)) throw new Error("Unexpected sidecar archive member")
  // Native bsdtar handles Windows ZIPs; GNU tar handles Linux tar.gz files.
  // Extract exactly one member to stdout, never arbitrary paths from an archive.
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe") : "tar"
  const proc = Bun.spawn([tar, "-xOf", archive, member], { stdout: "pipe", stderr: "pipe" })
  const [bytes, error, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0 || bytes.byteLength <= 0) throw new Error(`Could not extract the native sidecar: ${error}`)
  await Bun.write(destination, bytes)
}

if (import.meta.main) {
  const source = process.env.OPENSCIENCE_ARTIFACT_SOURCE ?? ""
  const version = process.env.OPENSCIENCE_VERSION ?? ""
  const selected = selectSidecar(
    process.env.OPENSCIENCE_DESKTOP_SIDECAR ?? "",
    process.env.OPENSCIENCE_SIDECAR_MANIFEST ?? "",
    source,
    version,
  )
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error("GITHUB_REPOSITORY is required")
  const release = await $`gh release view ${`v${version}`} --repo ${repository} --json assets`.json()
  const assets = release.assets.filter((asset: { name: string }) => asset.name === selected.asset)
  if (assets.length !== 1) throw new Error("Release must contain exactly one selected native asset")
  verifySidecarAsset(assets[0], selected.digest)
  const directory = await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-sidecar-"))
  try {
    await $`gh release download ${`v${version}`} --repo ${repository} --pattern ${selected.asset} --dir ${directory}`
    const binary = path.join(directory, selected.member)
    await extractSidecar(path.join(directory, selected.asset), binary, selected.member, selected.digest)
    await mkdir(path.dirname(selected.destination), { recursive: true })
    await copyFile(binary, selected.destination)
    await chmod(selected.destination, 0o755)
    console.log(`Verified ${selected.asset} for v${version} from ${source}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
