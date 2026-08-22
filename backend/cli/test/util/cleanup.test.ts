import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cleanup } from "../../src/util/cleanup"
import { tmpdir } from "../fixture/fixture"

test("removes a large real tree through a small observable worker pool", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "large-tree")
  await fs.mkdir(root)
  for (const directory of Array.from({ length: 24 }, (_, index) => `batch-${index}`)) {
    const nested = path.join(root, directory, "nested")
    await fs.mkdir(nested, { recursive: true })
    for (const file of Array.from({ length: 20 }, (_, index) => `result-${index}.txt`)) {
      await fs.writeFile(path.join(nested, file), file)
    }
  }

  const result = await Cleanup.remove(root)

  expect(result.completed).toBe(24 * 22 + 1)
  expect(result.peak).toBeGreaterThan(1)
  expect(result.peak).toBeLessThanOrEqual(Cleanup.CONCURRENCY)
  expect(await Bun.file(root).exists()).toBe(false)
})

test.skipIf(process.platform === "win32")("unlinks a tree symlink without following its target", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "tree")
  const kept = path.join(tmp.path, "kept")
  await fs.mkdir(root)
  await fs.mkdir(kept)
  await fs.writeFile(path.join(kept, "result.txt"), "recoverable")
  await fs.symlink(kept, path.join(root, "connected"))

  await Cleanup.remove(root)

  expect(await Bun.file(root).exists()).toBe(false)
  expect(await Bun.file(path.join(kept, "result.txt")).text()).toBe("recoverable")
})

test("drains an async cleanup stream without scheduling the whole set", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "stream")
  await fs.mkdir(root)
  for (const index of Array.from({ length: 300 }, (_, index) => index)) {
    await fs.writeFile(path.join(root, `${index}.partial`), "partial")
  }
  const files = async function* () {
    const directory = await fs.opendir(root)
    for await (const entry of directory) yield path.join(root, entry.name)
  }

  const result = await Cleanup.each(files(), (file) => fs.rm(file, { force: true }))

  expect(result).toMatchObject({ completed: 300 })
  expect(result.peak).toBeGreaterThan(1)
  expect(result.peak).toBeLessThanOrEqual(Cleanup.CONCURRENCY)
  expect(await fs.readdir(root)).toEqual([])
})

test("waits for the bounded set to drain before reporting a cleanup failure", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "failure-drain")
  const blocked = path.join(root, "non-empty")
  await fs.mkdir(blocked, { recursive: true })
  await fs.writeFile(path.join(blocked, "kept.txt"), "kept")
  const files: string[] = []
  for (const index of Array.from({ length: 120 }, (_, index) => index)) {
    const file = path.join(root, `${index}.partial`)
    await fs.writeFile(file, "partial")
    files.push(file)
  }

  await expect(Cleanup.each([blocked, ...files], (target) => fs.rm(target, { force: true }))).rejects.toBeInstanceOf(
    AggregateError,
  )

  expect(await Bun.file(path.join(blocked, "kept.txt")).text()).toBe("kept")
  expect(await fs.readdir(root)).toEqual(["non-empty"])
})
