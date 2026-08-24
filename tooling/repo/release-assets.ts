#!/usr/bin/env bun

import path from "path"
import os from "os"
import { mkdtemp, readdir } from "node:fs/promises"
import { $ } from "bun"
import { Script } from "@synsci/script"
import cli from "../../backend/cli/package.json"
import { NativeTargets, nativePackageName } from "../../backend/cli/script/native-targets"

async function sha256(file: string) {
  const bytes = await Bun.file(file).arrayBuffer()
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

const directory = path.resolve(process.argv[2] ?? "backend/cli/dist")
const files = (await readdir(directory))
  .filter(
    (file) =>
      file === "checksums.txt" ||
      (file.startsWith("openscience-") && (file.endsWith(".zip") || file.endsWith(".tar.gz"))),
  )
  .sort()
const expected = [
  "checksums.txt",
  ...NativeTargets.map((target) => {
    const name = nativePackageName(cli.name, target).replace(`${cli.name}-`, "openscience-")
    return `${name}${target.os === "linux" ? ".tar.gz" : ".zip"}`
  }),
].sort()
if (files.length !== expected.length || expected.some((file, index) => files[index] !== file)) {
  throw new Error(`Release assets must contain exactly: ${expected.join(", ")}`)
}

const tag = `v${Script.version}`
const existing = new Set(
  await $`gh release view ${tag} --json assets --jq '.assets[].name'`.text().then((value) =>
    value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
)

for (const name of files) {
  const local = path.join(directory, name)
  if (!existing.has(name)) {
    await $`gh release upload ${tag} ${local}`
    console.log(`uploaded immutable release asset ${name}`)
    continue
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "openscience-release-asset-"))
  await $`gh release download ${tag} --pattern ${name} --dir ${temp}`
  const remote = path.join(temp, name)
  const [localHash, remoteHash] = await Promise.all([sha256(local), sha256(remote)])
  if (localHash !== remoteHash) {
    throw new Error(`Draft release asset ${name} already exists with different bytes; refusing to clobber it`)
  }
  console.log(`verified immutable release asset ${name}`)
}
