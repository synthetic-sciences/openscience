import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DarwinUpdateSwap } from "../../src/process/darwin-update-swap"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("the update-swap bootstrap does not initialize or mutate user CLI configuration", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-update-bootstrap-")))
  roots.push(root)
  const config = path.join(root, "config")
  await mkdir(config)
  const snapshot = path.join(config, "synced-env.json")
  const legacy = path.join(config, "atlas-gcp-service-account.json")
  const source = '{"AWS_ACCESS_KEY_ID":"must-remain-untouched"}\n'
  await Promise.all([writeFile(snapshot, source), writeFile(legacy, "must-remain")])

  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      path.join(import.meta.dir, "../../src/bootstrap.ts"),
      "--desktop-update-swap",
      "invalid",
    ],
    {
      env: { ...process.env, OPENSCIENCE_CONFIG_DIR: config },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(await child.exited).toBe(1)
  expect(await readFile(snapshot, "utf8")).toBe(source)
  expect(await readFile(legacy, "utf8")).toBe("must-remain")
})

describe.skipIf(process.platform !== "darwin")("atomic desktop update exchange", () => {
  test("atomically exchanges sibling application directories", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-update-swap-")))
    roots.push(root)
    const target = path.join(root, "OpenScience.app")
    const incoming = path.join(root, "OpenScience.incoming-0123456789abcdef.app")
    await Promise.all([mkdir(target), mkdir(incoming)])
    await Promise.all([
      writeFile(path.join(target, "identity"), "old"),
      writeFile(path.join(incoming, "identity"), "new"),
    ])

    const [targetStats, incomingStats] = await Promise.all([lstat(target), lstat(incoming)])
    await DarwinUpdateSwap.run(
      Buffer.from(
        JSON.stringify({
          action: "swap",
          target,
          incoming,
          target_identity: { dev: targetStats.dev, ino: targetStats.ino, type: "directory" },
          incoming_identity: { dev: incomingStats.dev, ino: incomingStats.ino, type: "directory" },
        }),
      ).toString("base64url"),
    )

    expect(await readFile(path.join(target, "identity"), "utf8")).toBe("new")
    expect(await readFile(path.join(incoming, "identity"), "utf8")).toBe("old")
  })

  test("atomically installs an approved incoming app without replacing a raced target", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-update-install-")))
    roots.push(root)
    const target = path.join(root, "OpenScience.app")
    const incoming = path.join(root, "OpenScience.incoming-1023456789abcdef.app")
    await mkdir(incoming)
    await writeFile(path.join(incoming, "identity"), "new")
    const incomingStats = await lstat(incoming)
    const request = () =>
      Buffer.from(
        JSON.stringify({
          action: "move",
          target,
          incoming,
          incoming_identity: { dev: incomingStats.dev, ino: incomingStats.ino, type: "directory" },
        }),
      ).toString("base64url")

    await DarwinUpdateSwap.run(request())
    expect(await readFile(path.join(target, "identity"), "utf8")).toBe("new")

    await rename(target, incoming)
    await mkdir(target)
    await writeFile(path.join(target, "identity"), "raced")
    await expect(DarwinUpdateSwap.run(request())).rejects.toThrow("exclusive rename")
    expect(await readFile(path.join(target, "identity"), "utf8")).toBe("raced")
    expect(await readFile(path.join(incoming, "identity"), "utf8")).toBe("new")
  })

  test("rejects a symlink in either exchange slot", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-update-swap-link-")))
    roots.push(root)
    const real = path.join(root, "real.app")
    const target = path.join(root, "OpenScience.app")
    const incoming = path.join(root, "OpenScience.incoming-fedcba9876543210.app")
    await Promise.all([mkdir(real), mkdir(incoming)])
    await symlink(real, target)

    const [targetStats, incomingStats] = await Promise.all([lstat(target), lstat(incoming)])
    await expect(
      DarwinUpdateSwap.run(
        Buffer.from(
          JSON.stringify({
            action: "swap",
            target,
            incoming,
            target_identity: { dev: targetStats.dev, ino: targetStats.ino, type: "directory" },
            incoming_identity: { dev: incomingStats.dev, ino: incomingStats.ino, type: "directory" },
          }),
        ).toString("base64url"),
      ),
    ).rejects.toThrow("real application directories")
  })

  test("recursively removes only the exact updater-owned directory identity", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-update-remove-")))
    roots.push(root)
    const target = path.join(root, "OpenScience.incoming-0011223344556677.app")
    await mkdir(path.join(target, "Contents", "Resources"), { recursive: true })
    await writeFile(path.join(target, "Contents", "Resources", "owned"), "owned")
    const stats = await lstat(target)

    await DarwinUpdateSwap.run(
      Buffer.from(
        JSON.stringify({
          action: "remove",
          target,
          target_identity: { dev: stats.dev, ino: stats.ino, type: "directory" },
        }),
      ).toString("base64url"),
    )

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("does not remove a replacement raced into an approved cleanup path", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-update-remove-race-")))
    roots.push(root)
    const target = path.join(root, "OpenScience.incoming-8899aabbccddeeff.app")
    const retained = path.join(root, "retained.app")
    await mkdir(target)
    await writeFile(path.join(target, "identity"), "approved")
    const stats = await lstat(target)
    await rename(target, retained)
    await mkdir(target)
    await writeFile(path.join(target, "identity"), "replacement")

    await expect(
      DarwinUpdateSwap.run(
        Buffer.from(
          JSON.stringify({
            action: "remove",
            target,
            target_identity: { dev: stats.dev, ino: stats.ino, type: "directory" },
          }),
        ).toString("base64url"),
      ),
    ).rejects.toThrow("identity mismatch")

    expect(await readFile(path.join(target, "identity"), "utf8")).toBe("replacement")
    expect(await readFile(path.join(retained, "identity"), "utf8")).toBe("approved")
  })
})
