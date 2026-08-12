import { expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SshAdapter } from "../../src/compute/ssh/adapter"

test("accepts only Slurm COMPLETED 0:0 as a successful terminal result", async () => {
  expect(await SshAdapter.slurm("COMPLETED", "0:0")).toMatchObject({ state: "done", code: 0 })
  expect(await SshAdapter.slurm("CANCELLED by 1000", "0:15")).toMatchObject({ state: "cancelled" })
  expect(await SshAdapter.slurm("RUNNING", "0:0")).toMatchObject({ state: "running" })
  for (const [state, exit] of [
    ["FAILED", "1:0"],
    ["TIMEOUT", "0:9"],
    ["OUT_OF_MEMORY", "0:0"],
    ["NODE_FAIL", "0:0"],
    ["COMPLETED", "0:9"],
    ["COMPLETED", "2:0"],
  ] as const) {
    const result = await SshAdapter.slurm(state, exit)
    expect(result.state).toBe("done")
    expect(result.code).toBeGreaterThan(0)
  }
})

async function archive(root: string, relative: string, content: string) {
  const source = await fs.mkdtemp(path.join(root, "archive-source-"))
  const files = path.join(source, "files")
  const target = path.join(files, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  const manifest = {
    files: [
      {
        path: relative,
        size: Buffer.byteLength(content),
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      },
    ],
  }
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest))
  const targetArchive = path.join(root, `${crypto.randomUUID()}.tar`)
  const proc = Bun.spawn(["tar", "-cf", targetArchive, "-C", source, "manifest.json", "files"], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(error)
  await fs.rm(source, { recursive: true, force: true })
  return targetArchive
}

test("installs SSH outputs beneath an inode-pinned workspace while an ancestor name is swapped", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-delivery-"))
  const archivePath = await archive(root, "results/value.bin", Buffer.alloc(2 * 1024 * 1024, 7).toString("binary"))
  for (const attempt of Array.from({ length: 25 }, (_, index) => index)) {
    const workspace = path.join(root, `workspace-${attempt}`)
    const outside = path.join(root, `outside-${attempt}`)
    const alias = path.join(workspace, "results")
    const parked = path.join(workspace, "parked")
    await Promise.all([fs.mkdir(alias, { recursive: true }), fs.mkdir(outside)])
    const stop = new AbortController()
    let cycles = 0
    const swapped = (async () => {
      while (!stop.signal.aborted) {
        await fs.rename(alias, parked).catch(() => undefined)
        await fs.symlink(outside, alias).catch(() => undefined)
        await fs.rm(alias, { force: true }).catch(() => undefined)
        await fs.rename(parked, alias).catch(() => undefined)
        cycles++
      }
    })()
    const delivered = await SshAdapter.deliver(archivePath, workspace).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
    )
    stop.abort()
    await swapped
    expect(cycles).toBeGreaterThan(0)
    expect(await Bun.file(path.join(outside, "value.bin")).exists()).toBe(false)
    const accepted = [path.join(alias, "value.bin"), path.join(parked, "value.bin")]
    const published = (await Promise.all(accepted.map((item) => Bun.file(item).exists()))).filter(Boolean)
    if (delivered.ok) {
      expect(delivered.value.map((item) => item.path)).toEqual(["results/value.bin"])
      expect(published).toHaveLength(1)
    } else {
      expect(delivered.error).toContain("SSH output destination changed during delivery")
      expect(published).toHaveLength(0)
    }
    for (const folder of [alias, parked]) {
      const names = await fs.readdir(folder).catch(() => [])
      expect(names.some((name) => name.endsWith(".openscience.tmp"))).toBe(false)
    }
  }
  await fs.rm(root, { recursive: true, force: true })
}, 30_000)

test("SSH output delivery is idempotent but never replaces different workspace bytes", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-existing-"))
  const workspace = path.join(root, "workspace")
  const target = path.join(workspace, "results/value.txt")
  const archivePath = await archive(root, "results/value.txt", "remote-result\n")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, "local-work\n")
  await expect(SshAdapter.deliver(archivePath, workspace)).rejects.toThrow(
    "Refusing to replace an existing workspace file",
  )
  expect(await fs.readFile(target, "utf8")).toBe("local-work\n")
  await fs.writeFile(target, "remote-result\n")
  expect((await SshAdapter.deliver(archivePath, workspace)).map((item) => item.path)).toEqual(["results/value.txt"])
  expect(await fs.readFile(target, "utf8")).toBe("remote-result\n")
  await fs.rm(root, { recursive: true, force: true })
})
