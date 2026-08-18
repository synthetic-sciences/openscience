import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DataRoot } from "../../src/global/data-root"
import { DataRootBarrier } from "../../src/global/data-root-barrier"
import { FileLease } from "../../src/util/file-lease"
import { tmpdir } from "../fixture/fixture"

async function waitForFile(filepath: string) {
  const deadline = Date.now() + 2_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

test("a waiter follows exact-owner progress instead of timing out a healthy lease queue", async () => {
  await using tmp = await tmpdir()
  const filepath = path.join(tmp.path, "progress.lock")
  const record = (token: string) => JSON.stringify({ pid: process.pid, token, created: Date.now() })

  await fs.writeFile(filepath, record("owner-a"))
  const waiting = FileLease.acquire(filepath, 500)
  await Bun.sleep(300)
  await fs.writeFile(filepath, record("owner-b"))
  await Bun.sleep(300)
  await fs.rm(filepath)

  await using lease = await waiting
  expect(await Bun.file(filepath).exists()).toBe(true)
  void lease
}, 5_000)

test("a waiter still fails closed when one live owner stops making progress", async () => {
  await using tmp = await tmpdir()
  const filepath = path.join(tmp.path, "stuck.lock")
  await fs.writeFile(filepath, JSON.stringify({ pid: process.pid, token: "unchanged-owner", created: Date.now() }))

  await expect(FileLease.acquire(filepath, 75)).rejects.toThrow(
    "Timed out waiting for another OpenScience process to release",
  )
}, 5_000)

test("a structured lease admits a nested writer after relocation intent without a coverage gap", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const data = path.join(tmp.path, "data")
  const managed = await DataRoot.ensure(config, data, false)
  DataRootBarrier.configure({ root: managed.path, config })
  const lease = await FileLease.acquire(path.join(managed.path, "leases", "writer.lock"), 2_000)
  const scopeReady = Promise.withResolvers<void>()
  const startNested = Promise.withResolvers<void>()
  const nestedDone = Promise.withResolvers<void>()
  const command = lease.during(async () => {
    scopeReady.resolve()
    await startNested.promise
    await using nested = await DataRootBarrier.enter(path.join(managed.path, "nested.json"), 2_000)
    nestedDone.resolve()
    void nested
  })
  let switching: Promise<AsyncDisposable> | undefined

  try {
    await scopeReady.promise
    switching = DataRootBarrier.exclusive(2_000)
    await waitForFile(path.join(config, "data-root-switch.intent"))
    startNested.resolve()
    expect(await Promise.race([nestedDone.promise.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true)
    await command
    expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
    await lease[Symbol.asyncDispose]()
    const exclusive = await switching
    await exclusive[Symbol.asyncDispose]()
  } finally {
    startNested.resolve()
    await command.catch(() => undefined)
    await Promise.resolve(lease[Symbol.asyncDispose]()).catch(() => undefined)
    const exclusive = await switching?.catch(() => undefined)
    await exclusive?.[Symbol.asyncDispose]()
  }
})

test("disposing a lease keeps its lock published until the active callback settles", async () => {
  await using tmp = await tmpdir()
  const filepath = path.join(tmp.path, "draining.lock")
  const first = await FileLease.acquire(filepath, 2_000)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const critical = first.during(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const disposing = first[Symbol.asyncDispose]()
  let peerEntered = false
  const waiting = FileLease.acquire(filepath, 2_000).then((lease) => {
    peerEntered = true
    return lease
  })

  try {
    await expect(first.during(async () => undefined)).rejects.toThrow("Cannot scope work under a closing file lease")
    await Bun.sleep(50)
    expect(peerEntered).toBe(false)
    expect(await Bun.file(filepath).exists()).toBe(true)

    release.resolve()
    await critical
    await disposing
    const peer = await waiting
    expect(peerEntered).toBe(true)
    await peer[Symbol.asyncDispose]()
  } finally {
    release.resolve()
    await critical.catch(() => undefined)
    await Promise.resolve(disposing).catch(() => undefined)
    const peer = await waiting.catch(() => undefined)
    await peer?.[Symbol.asyncDispose]()
  }
})
