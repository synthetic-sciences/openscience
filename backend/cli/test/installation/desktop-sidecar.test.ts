import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { extractSidecar, selectSidecar, verifySidecarAsset } from "../../../../tooling/repo/desktop-sidecar"

const source = "a".repeat(40)
const digest = "b".repeat(64)
const matrix = [
  ["darwin-arm64", "openscience", "zip"],
  ["darwin-x64", "openscience", "zip"],
  ["windows-x64", "openscience.exe", "zip"],
  ["linux-x64", "openscience", "tar.gz"],
  ["linux-arm64", "openscience", "tar.gz"],
] as const
const manifest = JSON.stringify({
  source,
  version: "2.0.62",
  checksums: Object.fromEntries(matrix.map(([target, , extension]) => [`openscience-${target}.${extension}`, digest])),
})

test.each(matrix)("desktop %s selects only its source-bound native archive", (target, member, extension) => {
  const sidecar = `backend/cli/dist/@synsci/openscience-${target}/bin/${member}`
  const selected = selectSidecar(sidecar, manifest, source, "2.0.62")
  expect(selected.asset as string).toBe(`openscience-${target}.${extension}`)
  expect(selected.digest).toBe(digest)
  expect(selected.member).toBe(member)
  expect(selected.destination).toBe(path.resolve(sidecar))
})

test("sidecar selection rejects unrelated paths, releases, and asset digests", () => {
  const sidecar = "backend/cli/dist/@synsci/openscience-darwin-arm64/bin/openscience"
  expect(() => selectSidecar(`../${sidecar}`, manifest, source, "2.0.62")).toThrow("matrix")
  expect(() => selectSidecar(sidecar, manifest, "c".repeat(40), "2.0.62")).toThrow("mismatch")
  expect(() => selectSidecar(sidecar, manifest, source, "2.0.63")).toThrow("mismatch")
  expect(() => selectSidecar(sidecar, manifest.replace(digest, "invalid"), source, "2.0.62")).toThrow("digest")
  expect(() => verifySidecarAsset(undefined, digest)).toThrow("source-bound")
  expect(() => verifySidecarAsset({ state: "uploaded", size: 12, digest: `sha256:${source}` }, digest)).toThrow(
    "source-bound",
  )
  expect(() => verifySidecarAsset({ state: "new", size: 12, digest: `sha256:${digest}` }, digest)).toThrow(
    "source-bound",
  )
  verifySidecarAsset({ state: "uploaded", size: 12, digest: `sha256:${digest}` }, digest)
})

test.each(process.platform === "linux" ? ["tar.gz"] : ["zip", "tar.gz"])(
  "extracts only the verified binary from a real %s archive",
  async (extension) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openscience-sidecar-test-"))
    try {
      await Bun.write(path.join(directory, "openscience"), "native fixture")
      await Bun.write(path.join(directory, "unrelated"), "must not be extracted")
      const archive = path.join(directory, `fixture.${extension}`)
      if (extension === "zip") await Bun.$`zip ${archive} openscience unrelated`.cwd(directory).quiet()
      if (extension === "tar.gz") await Bun.$`tar -czf ${archive} openscience unrelated`.cwd(directory).quiet()
      const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
      const output = path.join(directory, "extracted")
      await extractSidecar(archive, output, "openscience", digest)
      expect(await Bun.file(output).text()).toBe("native fixture")
      const rejected = path.join(directory, "rejected")
      await expect(extractSidecar(archive, rejected, "openscience", "0".repeat(64))).rejects.toThrow("SHA-256")
      expect(await Bun.file(rejected).exists()).toBe(false)
      await expect(extractSidecar(archive, rejected, "../openscience", digest)).rejects.toThrow("member")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
