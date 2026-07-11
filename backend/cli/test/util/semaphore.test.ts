import { expect, test } from "bun:test"
import { Semaphore } from "../../src/util/semaphore"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("bounds concurrency to max", async () => {
  const sem = new Semaphore(2)
  let running = 0
  let peak = 0
  const run = async () => {
    await sem.acquire()
    running++
    peak = Math.max(peak, running)
    await sleep(10)
    running--
    sem.release()
  }
  await Promise.all(Array.from({ length: 6 }, run))
  expect(peak).toBe(2)
})

test("release wakes blocked waiters in FIFO order", async () => {
  const sem = new Semaphore(1)
  const order: number[] = []
  await sem.acquire() // hold the only slot
  const p1 = sem.acquire().then(() => order.push(1))
  const p2 = sem.acquire().then(() => order.push(2))
  await sleep(1)
  sem.release() // -> p1
  await p1
  sem.release() // -> p2
  await p2
  expect(order).toEqual([1, 2])
})

test("max floors at 1 (never zero-slot deadlock)", async () => {
  const sem = new Semaphore(0)
  await sem.acquire()
  expect(true).toBe(true) // resolved, did not hang
})

test("acquire rejects immediately when the signal is already aborted", async () => {
  const sem = new Semaphore(1)
  const ac = new AbortController()
  ac.abort()
  await expect(sem.acquire(ac.signal)).rejects.toBeDefined()
  // the slot was not consumed by the rejected call
  await sem.acquire()
  expect(true).toBe(true)
})

test("abort while queued rejects and does not leak the slot", async () => {
  const sem = new Semaphore(1)
  await sem.acquire() // hold the only slot
  const ac = new AbortController()
  const queued = sem.acquire(ac.signal)
  await sleep(1)
  ac.abort()
  await expect(queued).rejects.toBeDefined()
  // the aborted waiter left the queue, so release returns the slot to the pool
  sem.release()
  await sem.acquire() // resolves rather than hanging on a ghost waiter
  expect(true).toBe(true)
})

test("aborting one queued waiter still serves a live waiter (no lost slot)", async () => {
  const sem = new Semaphore(1)
  await sem.acquire() // hold slot
  const ac = new AbortController()
  const aborted = sem.acquire(ac.signal).then(
    () => "resolved",
    () => "rejected",
  )
  const order: string[] = []
  const live = sem.acquire().then(() => order.push("live"))
  await sleep(1)
  ac.abort() // drop the first waiter
  expect(await aborted).toBe("rejected")
  sem.release() // must go to the live waiter, not the dead one
  await live
  expect(order).toEqual(["live"])
})
