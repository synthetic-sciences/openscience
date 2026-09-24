import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"
import { AuthoritySignal } from "../../src/project/authority-signal"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { Sandbox } from "../../src/sandbox/sandbox"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { executionSession, tmpdir } from "../fixture/fixture"

test("a sibling project instance keeps compute on read addition and stops it on access replacement", async () => {
  if (!Sandbox.available()) return
  await using fixture = await tmpdir({ git: true })
  await using external = await tmpdir()
  const directory = path.join(fixture.path, "child")
  await fs.mkdir(directory)
  const source = await Instance.provide({
    directory: fixture.path,
    init: InstanceBootstrap,
    fn: async () => ({ session: await executionSession(), projectID: Instance.project.id }),
  })
  const sibling = await Instance.provide({
    directory,
    projectID: source.projectID,
    init: InstanceBootstrap,
    fn: async () => {
      const session = await executionSession()
      await SessionFilesystem.setWorkingRoot(session.id, "scratch")
      const scope = { root: path.join(fixture.path, ".jobs"), workspace: await SessionFilesystem.workspace(session.id) }
      const job = await ComputeJobs.start(
        { sessionID: session.id, name: "before folder addition", command: "sleep 30", target: { kind: "local" } },
        scope,
      )
      return { session, scope, job }
    },
  })
  const jobs = [sibling.job.id]
  try {
    await Instance.provide({
      directory: fixture.path,
      fn: () => SessionFilesystem.connectProject({ path: external.path, access: "read" }),
    })
    // Both the cross-instance bus and the 200 ms durable poller have a chance
    // to observe the addition before the narrowing transition below.
    await Bun.sleep(500)
    expect((await ComputeJobs.get(sibling.job.id, sibling.scope))?.status).toBe("running")

    await Instance.provide({
      directory: fixture.path,
      fn: () => SessionFilesystem.connectProject({ path: external.path, access: "write" }),
    })
    expect((await ComputeJobs.wait(sibling.job.id, { ...sibling.scope, timeout: 5_000 })).status).toBe("cancelled")
    const granted = await Instance.provide({
      directory,
      fn: () =>
        ComputeJobs.start(
          { sessionID: sibling.session.id, name: "with write grant", command: "sleep 30", target: { kind: "local" } },
          sibling.scope,
        ),
    })
    jobs.push(granted.id)
    const replacement = await Instance.provide({
      directory: fixture.path,
      fn: () => SessionFilesystem.connectProject({ path: external.path, access: "read" }),
    })
    expect(replacement.access).toBe("read")
    expect(replacement.time.revoked).toBeUndefined()
    expect((await ComputeJobs.wait(granted.id, { ...sibling.scope, timeout: 5_000 })).status).toBe("cancelled")
  } finally {
    for (const id of jobs) await ComputeJobs.cancel(id, sibling.scope)
    await Instance.provide({
      directory,
      fn: async () => {
        await Session.remove(sibling.session.id)
        await Instance.dispose()
      },
    })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        await Session.remove(source.session.id)
        await Instance.dispose()
      },
    })
  }
}, 15_000)

test("the first write folder changes the automatic working root and cancels live compute", async () => {
  if (!Sandbox.available()) return
  await using fixture = await tmpdir({ git: true })
  await using external = await tmpdir()
  await Instance.provide({
    directory: fixture.path,
    init: InstanceBootstrap,
    fn: async () => {
      const session = await executionSession()
      const scope = { root: path.join(fixture.path, ".jobs"), workspace: await SessionFilesystem.workspace(session.id) }
      expect(await SessionFilesystem.toolDirectory(session.id)).toBe(scope.workspace)
      const job = await ComputeJobs.start(
        { sessionID: session.id, name: "automatic working root", command: "sleep 30", target: { kind: "local" } },
        scope,
      )
      try {
        await SessionFilesystem.connectProject({ path: external.path, access: "write" })
        expect(await SessionFilesystem.toolDirectory(session.id)).toBe(external.path)
        expect((await ComputeJobs.wait(job.id, { ...scope, timeout: 5_000 })).status).toBe("cancelled")
      } finally {
        await ComputeJobs.cancel(job.id, scope)
        await Session.remove(session.id)
        await Instance.dispose()
      }
    },
  })
}, 15_000)

test("a legacy durable filesystem event without narrowing still cancels live compute", async () => {
  if (!Sandbox.available()) return
  await using fixture = await tmpdir({ git: true })
  await Instance.provide({
    directory: fixture.path,
    init: InstanceBootstrap,
    fn: async () => {
      const session = await executionSession()
      const scope = { root: path.join(fixture.path, ".jobs"), workspace: await SessionFilesystem.workspace(session.id) }
      const job = await ComputeJobs.start(
        { sessionID: session.id, name: "legacy filesystem event", command: "sleep 30", target: { kind: "local" } },
        scope,
      )
      try {
        // A durable record from an older process has no direction marker and
        // no local bus delivery. The real bootstrap watcher must fail closed.
        await AuthoritySignal.publish({
          kind: "filesystem",
          projectID: Instance.project.id,
          sessionID: session.id,
          scope: "session",
        })
        expect((await ComputeJobs.wait(job.id, { ...scope, timeout: 5_000 })).status).toBe("cancelled")
      } finally {
        await ComputeJobs.cancel(job.id, scope)
        await Session.remove(session.id)
        await Instance.dispose()
      }
    },
  })
}, 15_000)
