import { expect, spyOn, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { KernelRuntime, type KernelIdentity } from "../../../src/science/kernel/registry"
import type { KernelManager } from "../../../src/science/kernel/types"
import { Session } from "../../../src/session"
import { Storage } from "../../../src/storage/storage"
import { tmpdir } from "../../fixture/fixture"

// A restore never starts an interpreter, so the manager is only consulted for
// its presence. Registering it under a private language keeps the module-level
// registry out of the languages the real managers own.
const language = "restore-record-test"
const released: string[] = []
const manager: KernelManager = {
  language,
  async get() {
    throw new Error("a restore must not start an interpreter")
  },
  async release(sessionID) {
    released.push(sessionID)
  },
  async shutdownAll() {},
}

const record = (identity: KernelIdentity, executionCount: number) => ({
  version: 1 as const,
  identity,
  state: "stopped" as const,
  incarnation: 3,
  execution_count: executionCount,
  last_activity_at: 1_700_000_000_000,
  ownership_id: null,
  process: null,
})

test("one unreadable registry record does not abort the whole restore", async () => {
  KernelRuntime.register(manager)
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const projectID = Instance.project.id
      const readable: KernelIdentity = {
        projectID,
        sessionID: session.id,
        name: "readable",
        language,
      }
      const unreadable: KernelIdentity = {
        projectID,
        sessionID: session.id,
        name: "unreadable",
        language,
      }
      await Storage.write(["kernel_registry", projectID, session.id, "readable"], record(readable, 7))
      await Storage.write(["kernel_registry", projectID, session.id, "unreadable"], record(unreadable, 9))

      // A record deleted or truncated between Storage.list and Storage.read is
      // the whole trigger: hydrate() tolerates exactly this read failing, but
      // restoreSession() did not, so one bad record discarded every good one.
      const reads = spyOn(Storage, "read").mockImplementation(async (key: string[]) => {
        if (key.at(-1) === "unreadable") throw new Storage.NotFoundError({ message: `No such key: ${key.join("/")}` })
        return record(readable, 7) as never
      })
      try {
        await KernelRuntime.restoreSession(projectID)
      } finally {
        reads.mockRestore()
      }

      // The readable record is restored rather than lost to its neighbour.
      expect(KernelRuntime.status(readable).execution_count).toBe(7)
    },
  })
}, 30_000)

test("releaseProject still releases the project's kernels when a record is unreadable", async () => {
  KernelRuntime.register(manager)
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const projectID = Instance.project.id
      const identity: KernelIdentity = {
        projectID,
        sessionID: session.id,
        name: "release-project",
        language,
      }
      await Storage.write(["kernel_registry", projectID, session.id, "release-project"], record(identity, 2))

      const reads = spyOn(Storage, "read").mockImplementation(async (key: string[]) => {
        if (key.at(-1) === "release-project") {
          throw new Storage.NotFoundError({ message: `No such key: ${key.join("/")}` })
        }
        return undefined as never
      })
      try {
        released.length = 0
        // releaseProject awaits restoreSession first, so the unreadable read
        // used to reject here and skip releaseEntries entirely — leaving every
        // live kernel in the project running.
        await KernelRuntime.releaseProject(projectID)
      } finally {
        reads.mockRestore()
      }

      expect(KernelRuntime.status(identity).active).toBe(false)
    },
  })
}, 30_000)

test("a genuine read failure that is not a missing record still surfaces", async () => {
  KernelRuntime.register(manager)
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const projectID = Instance.project.id
      await Storage.write(
        ["kernel_registry", projectID, session.id, "permission"],
        record({ projectID, sessionID: session.id, name: "permission", language }, 1),
      )

      // Only NotFoundError is absorbed, matching hydrate(): an unreadable
      // volume is a real fault and must not be reported as a clean project.
      const reads = spyOn(Storage, "read").mockImplementation(async () => {
        throw new Error("EIO: i/o error, read")
      })
      try {
        await expect(KernelRuntime.restoreSession(projectID)).rejects.toThrow("EIO")
      } finally {
        reads.mockRestore()
      }
    },
  })
}, 30_000)