import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ComputeJobs } from "../../src/compute/jobs"
import { Bus } from "../../src/bus"
import { File } from "../../src/file"
import { PermissionNext } from "../../src/permission/next"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { Sandbox } from "../../src/sandbox/sandbox"
import { FileRoutes } from "../../src/server/routes/file"
import { SessionRoutes } from "../../src/server/routes/session"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Storage } from "../../src/storage/storage"
import { executionSession, tmpdir } from "../fixture/fixture"
import { Truncate } from "../../src/tool/truncation"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"

async function withSession<T>(directory: string, fn: (session: Session.Info) => Promise<T>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const session = await Session.create({})
      return fn(session).finally(() => Session.remove(session.id))
    },
  })
}

async function wait(sessionID: string, attempt = 0): Promise<PermissionNext.Request | undefined> {
  const request = (await PermissionNext.list()).find((item) => item.sessionID === sessionID)
  if (request || attempt >= 100) return request
  await Bun.sleep(5)
  return wait(sessionID, attempt + 1)
}

describe("session filesystem grants", () => {
  test("only the tool-output broker can mint an exact managed-output grant", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "tool-output.txt"), "evidence"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const output = path.join(external.path, "tool-output.txt")
      const changes: SessionFilesystem.Grant[] = []
      const unsubscribe = Bus.subscribe(SessionFilesystem.Event.Changed, (event) => {
        if (event.properties.sessionID === session.id) changes.push(event.properties.grant)
      })
      await expect(
        SessionFilesystem.grant({
          sessionID: session.id,
          path: output,
          access: "read",
          scope: "session",
          source: "tool",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.InvalidPathError)
      const before = await SessionFilesystem.snapshot(session.id)
      const grant = await SessionFilesystem.grantToolOutput({ sessionID: session.id, path: output })
      const after = await SessionFilesystem.snapshot(session.id)
      await expect(
        SessionFilesystem.authorize({ sessionID: session.id, path: output, access: "read" }),
      ).resolves.toMatchObject({
        grant: expect.objectContaining({ source: "tool", access: "read", scope: "session" }),
      })
      await expect(
        SessionFilesystem.authorize({ sessionID: session.id, path: external.path, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      expect(changes).toEqual([])
      expect(after.revision).toBe(before.revision)
      expect(after.workspace.grantRevision).toBe(before.workspace.grantRevision)
      expect(await SessionFilesystem.processReadRoots(session.id)).not.toContain(output)

      await SessionFilesystem.revoke(session.id, grant.id)
      expect(changes).toEqual([])
      expect((await SessionFilesystem.snapshot(session.id)).revision).toBe(before.revision)
      await expect(
        SessionFilesystem.authorize({ sessionID: session.id, path: output, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      unsubscribe()
    })
  })

  test("normal API and permission approvals cannot grant the managed tool-output broker", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const output = path.join(Truncate.DIR, "tool_00000000000000000000000000")
      await Bun.write(output, "sibling broker secret")
      const physicalBroker = await fs.realpath(Truncate.DIR)
      expect(physicalBroker).not.toBe(Truncate.DIR)

      await expect(
        SessionFilesystem.grant({
          sessionID: session.id,
          path: Truncate.DIR,
          access: "read",
          scope: "session",
          source: "api",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.InvalidPathError)
      await expect(
        SessionFilesystem.grant({
          sessionID: session.id,
          path: physicalBroker,
          access: "read",
          scope: "session",
          source: "api",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.InvalidPathError)
      await expect(
        SessionFilesystem.grant({
          sessionID: session.id,
          path: path.dirname(physicalBroker),
          access: "read",
          scope: "session",
          source: "api",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.InvalidPathError)
      const request = PermissionNext.ask({
        sessionID: session.id,
        permission: "external_directory",
        patterns: [Truncate.DIR],
        always: [Truncate.DIR],
        metadata: { filesystem: { path: Truncate.DIR, access: "read" } },
        ruleset: PermissionNext.fromConfig({ external_directory: "ask" }),
      })
      const prompt = await wait(session.id)
      expect(prompt).toBeDefined()
      const [asked, replied] = await Promise.allSettled([
        request,
        PermissionNext.reply({ requestID: prompt!.id, reply: "session" }),
      ])
      expect(asked.status).toBe("rejected")
      expect(replied.status).toBe("rejected")
      if (asked.status === "rejected") expect(asked.reason).toBeInstanceOf(SessionFilesystem.InvalidPathError)
      if (replied.status === "rejected") expect(replied.reason).toBeInstanceOf(SessionFilesystem.InvalidPathError)
      await expect(
        SessionFilesystem.authorize({ sessionID: session.id, path: output, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      expect(await SessionFilesystem.processReadRoots(session.id)).not.toContain(Truncate.DIR)
      await fs.unlink(output).catch(() => undefined)
    })
  })

  test("the managed broker enclave ignores historical broad grants and accepts only an exact owner capability", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({})
        const sibling = await Session.create({})
        const output = path.join(Truncate.DIR, `tool_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`)
        await Bun.write(output, "owner secret")
        try {
          const injectLegacyParent = (sessionID: string) =>
            Storage.update<SessionFilesystem.State>(["session_filesystem", Instance.project.id, sessionID], (draft) => {
              draft.grants.push({
                id: `fsg_legacy_${sessionID}`,
                path: Global.Path.data,
                access: "write",
                scope: "session",
                source: "api",
                time: { created: 1 },
              })
              draft.revision++
            })
          await Promise.all([injectLegacyParent(owner.id), injectLegacyParent(sibling.id)])
          await SessionFilesystem.grantToolOutput({ sessionID: owner.id, path: output })

          await expect(
            SessionFilesystem.authorize({ sessionID: owner.id, path: output, access: "read" }),
          ).resolves.toMatchObject({ grant: { source: "tool" } })
          await expect(
            SessionFilesystem.authorize({ sessionID: owner.id, path: output, access: "write" }),
          ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
          await expect(
            SessionFilesystem.authorize({ sessionID: sibling.id, path: output, access: "read" }),
          ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
          expect(await SessionFilesystem.allows({ sessionID: sibling.id, path: output, access: "read" })).toBe(false)

          // The broad legacy parent can remain useful for non-enclave files;
          // native processes mask the broker root independently.
          expect(await SessionFilesystem.processReadRoots(sibling.id)).toContain(Global.Path.data)
          expect(OpenScience.kernelSensitivePaths()).toContain(Truncate.DIR)
        } finally {
          await Promise.all([Session.remove(owner.id), Session.remove(sibling.id)])
          await fs.unlink(output).catch(() => undefined)
        }
      },
    })
  })

  test("rejects an imported project root that contains the managed broker enclave", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(
          SessionFilesystem.initialize("ses_managed_broker_parent", Global.Path.data),
        ).rejects.toBeInstanceOf(SessionFilesystem.InvalidPathError)
      },
    })
  })

  test("does not broadcast a revocation for a new session's initial workspace", async () => {
    await using external = await tmpdir()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes: string[] = []
        const unsubscribe = Bus.subscribe(SessionFilesystem.Event.Changed, (event) => {
          changes.push(event.properties.sessionID)
        })
        const session = await Session.create({})
        await using cleanup = {
          [Symbol.asyncDispose]: () => Session.remove(session.id),
        }
        const workspace = await SessionFilesystem.workspace(session.id)

        expect(changes).toEqual([])
        expect(await SessionFilesystem.list(session.id)).toContainEqual(
          expect.objectContaining({
            path: workspace,
            access: "write",
            scope: "session",
            source: "workspace",
          }),
        )
        expect(await SessionFilesystem.list(session.id)).toContainEqual(
          expect.objectContaining({ path: tmp.path, access: "write", scope: "session", source: "api" }),
        )

        const grant = await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "read",
          scope: "session",
        })
        expect(changes).toEqual([session.id])
        await SessionFilesystem.revoke(session.id, grant.id)
        expect(changes).toEqual([session.id, session.id])
        unsubscribe()
      },
    })
  })

  test("creates a durable read-write workspace grant with each session", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const workspace = await SessionFilesystem.workspace(session.id)
      const grants = await SessionFilesystem.list(session.id)
      expect(grants).toContainEqual(
        expect.objectContaining({
          path: workspace,
          access: "write",
          scope: "session",
          source: "workspace",
        }),
      )
      expect(grants).toContainEqual(
        expect.objectContaining({ path: tmp.path, access: "write", scope: "session", source: "api" }),
      )
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: path.join(tmp.path, "new.txt"),
          access: "write",
        }),
      ).resolves.toMatchObject({ path: path.join(tmp.path, "new.txt") })
    })
  })

  test("keeps read and write authority directional", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      await SessionFilesystem.grant({
        sessionID: session.id,
        path: external.path,
        access: "read",
        scope: "session",
      })
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: path.join(external.path, "data.txt"),
          access: "read",
        }),
      ).resolves.toBeDefined()
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: path.join(external.path, "data.txt"),
          access: "write",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      expect(await SessionFilesystem.processReadRoots(session.id)).toContain(external.path)
      expect(await SessionFilesystem.processWriteRoots(session.id)).not.toContain(external.path)
    })
  })

  test("consumes one-shot access exactly once", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const target = path.join(external.path, "data.txt")
      const grant = await SessionFilesystem.grant({
        sessionID: session.id,
        path: external.path,
        access: "read",
        scope: "once",
      })
      expect(await SessionFilesystem.processReadRoots(session.id)).not.toContain(external.path)
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: target,
          access: "read",
        }),
      ).resolves.toMatchObject({ grant: { id: grant.id } })
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: target,
          access: "read",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      expect(
        (await SessionFilesystem.list(session.id)).find((item) => item.id === grant.id)?.time.consumed,
      ).toBeNumber()
    })
  })

  test("revocation immediately removes authority", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const before = await SessionFilesystem.state(session.id)
      const grant = await SessionFilesystem.grant({
        sessionID: session.id,
        path: external.path,
        access: "write",
        scope: "session",
      })
      const granted = await SessionFilesystem.state(session.id)
      expect(granted.revision).toBe(before.revision + 1)
      await SessionFilesystem.revoke(session.id, grant.id)
      expect((await SessionFilesystem.state(session.id)).revision).toBe(granted.revision + 1)
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: path.join(external.path, "data.txt"),
          access: "read",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
    })
  })

  test("keeps process read and write grants directional", async () => {
    await using external = await tmpdir()
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      await SessionFilesystem.grant({
        sessionID: session.id,
        path: external.path,
        access: "write",
        scope: "session",
      })
      const roots = await SessionFilesystem.processWriteRoots(session.id)
      expect(roots).toContain(await SessionFilesystem.workspace(session.id))
      expect(roots).toContain(tmp.path)
      expect(roots).toContain(external.path)
      expect(await SessionFilesystem.processReadRoots(session.id)).toContain(external.path)
      expect((await SessionFilesystem.snapshot(session.id)).enforcement).toEqual({
        broker: "enforced",
        processWrite: "grant_only",
        processRead: Sandbox.describe().readIsolation === "grant_only" ? "grant_only" : "policy_only",
      })
    })
  })

  test("blocks traversal and symlink escapes from an otherwise granted root", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "secret.txt"), "secret"),
    })
    await using granted = await tmpdir({
      init: (dir) => fs.symlink(external.path, path.join(dir, "escape")),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      await SessionFilesystem.grant({
        sessionID: session.id,
        path: granted.path,
        access: "read",
        scope: "session",
      })
      for (const target of [
        path.join(granted.path, "..", path.basename(external.path), "secret.txt"),
        path.join(granted.path, "escape", "secret.txt"),
      ]) {
        await expect(
          SessionFilesystem.authorize({
            sessionID: session.id,
            path: target,
            access: "read",
          }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      }
    })
  })

  test("does not share grants across sessions", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await Session.create({})
        const second = await Session.create({})
        await using _ = {
          [Symbol.asyncDispose]: async () => {
            await Promise.all([Session.remove(first.id), Session.remove(second.id)])
          },
        }
        await SessionFilesystem.grant({
          sessionID: first.id,
          path: external.path,
          access: "read",
          scope: "session",
        })
        await expect(
          SessionFilesystem.authorize({
            sessionID: first.id,
            path: path.join(external.path, "data.txt"),
            access: "read",
          }),
        ).resolves.toBeDefined()
        await expect(
          SessionFilesystem.authorize({
            sessionID: second.id,
            path: path.join(external.path, "data.txt"),
            access: "read",
          }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      },
    })
  })

  test("shares project grants with existing and new project sessions through real file access", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await Session.create({})
        const existing = await Session.create({})
        await using _ = {
          [Symbol.asyncDispose]: async () => {
            await Promise.all([Session.remove(first.id), Session.remove(existing.id)])
          },
        }
        const grant = await SessionFilesystem.grant({
          sessionID: first.id,
          path: external.path,
          access: "read",
          scope: "project",
        })
        const stored = await Storage.read<SessionFilesystem.ProjectState>(["project_filesystem", Instance.project.id])
        expect(stored.grants).toContainEqual(expect.objectContaining({ id: grant.id, scope: "project" }))

        const created = await Session.create({})
        await using cleanup = {
          [Symbol.asyncDispose]: () => Session.remove(created.id),
        }
        const target = path.join(external.path, "data.txt")
        expect((await File.read(target, { sessionID: first.id })).content).toBe("external")
        expect((await File.read(target, { sessionID: existing.id })).content).toBe("external")
        expect((await File.read(target, { sessionID: created.id })).content).toBe("external")
        await expect(File.write(target, "mutated", { sessionID: created.id })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
        expect(await Bun.file(target).text()).toBe("external")
      },
    })
  })

  test("revokes a project grant from every session and keeps it out of other projects", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using first = await tmpdir()
    await using second = await tmpdir()
    const source = await Instance.provide({
      directory: first.path,
      fn: async () => {
        const owner = await Session.create({})
        const peer = await Session.create({})
        const grant = await SessionFilesystem.grant({
          sessionID: owner.id,
          path: external.path,
          access: "write",
          scope: "project",
        })
        const target = path.join(external.path, "data.txt")
        await File.write(target, "published", { sessionID: peer.id })
        expect(await Bun.file(target).text()).toBe("published")
        await SessionFilesystem.revoke(peer.id, grant.id)
        await expect(File.read(target, { sessionID: owner.id })).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        await expect(File.write(target, "mutated", { sessionID: peer.id })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
        await Promise.all([Session.remove(owner.id), Session.remove(peer.id)])
        return { grant, projectID: Instance.project.id }
      },
    })

    await Instance.provide({
      directory: second.path,
      fn: async () => {
        expect(Instance.project.id).not.toBe(source.projectID)
        const session = await Session.create({})
        await using _ = {
          [Symbol.asyncDispose]: () => Session.remove(session.id),
        }
        expect((await SessionFilesystem.list(session.id)).some((grant) => grant.id === source.grant.id)).toBeFalse()
        await expect(File.read(path.join(external.path, "data.txt"), { sessionID: session.id })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      },
    })
  })

  test("materializes Always as installation scope across projects and revokes it everywhere", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "shared.txt"), "installation"),
    })
    await using first = await tmpdir()
    await using second = await tmpdir()

    const grantID = await Instance.provide({
      directory: first.path,
      fn: async () => {
        const session = await Session.create({})
        const request = PermissionNext.ask({
          sessionID: session.id,
          permission: "external_directory",
          patterns: [path.join(external.path, "*")],
          always: [path.join(external.path, "*")],
          metadata: {
            filesystem: {
              path: external.path,
              access: "read",
            },
          },
          ruleset: [],
        })
        const prompt = await wait(session.id)
        if (!prompt) throw new Error("installation permission was not requested")
        await PermissionNext.reply({ requestID: prompt.id, reply: "always" })
        await request
        const grant = (await SessionFilesystem.list(session.id)).find(
          (item) => item.path === external.path && item.scope === "installation",
        )
        expect(grant).toBeDefined()
        expect((await File.read(path.join(external.path, "shared.txt"), { sessionID: session.id })).content).toBe(
          "installation",
        )
        await Session.remove(session.id)
        return grant!.id
      },
    })

    await Instance.provide({
      directory: second.path,
      fn: async () => {
        const session = await Session.create({})
        const target = path.join(external.path, "shared.txt")
        expect((await File.read(target, { sessionID: session.id })).content).toBe("installation")
        const revoked = await SessionFilesystem.revoke(session.id, grantID)
        expect(revoked).toMatchObject({ id: grantID, scope: "installation", time: { revoked: expect.any(Number) } })
        await expect(File.read(target, { sessionID: session.id })).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        await Session.remove(session.id)
      },
    })
  })

  test("stops live compute in every project when installation authority changes", async () => {
    if (!Sandbox.available()) return
    await using external = await tmpdir()
    await using first = await tmpdir()
    await using second = await tmpdir()
    const roots = {
      first: path.join(first.path, ".jobs"),
      second: path.join(second.path, ".jobs"),
    }
    const one = await Instance.provide({
      directory: first.path,
      init: InstanceBootstrap,
      fn: async () => {
        const session = await executionSession()
        const workspace = await SessionFilesystem.workspace(session.id)
        const job = await ComputeJobs.start(
          {
            sessionID: session.id,
            name: "first installation scope",
            command: "sleep 30",
            target: { kind: "local" },
          },
          { root: roots.first, workspace },
        )
        return { session, job, workspace }
      },
    })
    const two = await Instance.provide({
      directory: second.path,
      init: InstanceBootstrap,
      fn: async () => {
        const session = await executionSession()
        const workspace = await SessionFilesystem.workspace(session.id)
        const job = await ComputeJobs.start(
          {
            sessionID: session.id,
            name: "second installation scope",
            command: "sleep 30",
            target: { kind: "local" },
          },
          { root: roots.second, workspace },
        )
        return { session, job, workspace }
      },
    })

    const grant = await Instance.provide({
      directory: first.path,
      fn: async () =>
        SessionFilesystem.grant({
          sessionID: one.session.id,
          path: external.path,
          access: "read",
          scope: "installation",
        }),
    })
    const stopped = await Promise.all([
      ComputeJobs.wait(one.job.id, { root: roots.first, workspace: one.workspace, timeout: 5_000 }),
      ComputeJobs.wait(two.job.id, { root: roots.second, workspace: two.workspace, timeout: 5_000 }),
    ])
    expect(stopped.map((job) => job.status)).toEqual(["cancelled", "cancelled"])

    await Instance.provide({
      directory: first.path,
      fn: async () => {
        await SessionFilesystem.revoke(one.session.id, grant.id)
        await Session.remove(one.session.id)
        await Instance.dispose()
      },
    })
    await Instance.provide({
      directory: second.path,
      fn: async () => {
        await Session.remove(two.session.id)
        await Instance.dispose()
      },
    })
  })

  test("accepts project scope through the session filesystem routes", async () => {
    await using external = await tmpdir()
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const granted = await SessionRoutes().request(`/${session.id}/filesystem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: external.path,
          access: "read",
          scope: "project",
        }),
      })
      expect(granted.status).toBe(200)
      const grant = SessionFilesystem.Grant.parse(await granted.json())
      expect(grant).toMatchObject({ access: "read", scope: "project" })

      const snapshot = await SessionRoutes().request(`/${session.id}/filesystem`)
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({
        projectID: Instance.project.id,
        grants: expect.arrayContaining([expect.objectContaining({ path: external.path, scope: "project" })]),
      })

      const revoked = await SessionRoutes().request(`/${session.id}/filesystem/${grant.id}`, {
        method: "DELETE",
      })
      expect(revoked.status).toBe(200)
      expect(await revoked.json()).toMatchObject({ id: grant.id, time: { revoked: expect.any(Number) } })
    })
  })

  test("materializes permission replies as enforceable grants", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const pending = PermissionNext.ask({
        sessionID: session.id,
        permission: "external_directory",
        patterns: [path.join(external.path, "*")],
        always: [path.join(external.path, "*")],
        metadata: {
          filesystem: {
            path: external.path,
            access: "read",
          },
        },
        ruleset: [],
      })
      const request = await wait(session.id)
      expect(request).toBeDefined()
      await PermissionNext.reply({ requestID: request!.id, reply: "once" })
      await pending

      const grants = await SessionFilesystem.list(session.id)
      expect(grants).toContainEqual(
        expect.objectContaining({
          path: external.path,
          access: "read",
          scope: "once",
          source: "permission",
        }),
      )
    })
  })

  test("does not let a concurrent request claim another request's one-shot grant", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const glob = path.join(external.path, "*")
      const request = () =>
        PermissionNext.ask({
          sessionID: session.id,
          permission: "external_directory",
          patterns: [glob],
          always: [glob],
          metadata: {
            filesystem: {
              path: external.path,
              access: "read",
            },
          },
          ruleset: [],
        })

      const first = request()
      const prompt = await wait(session.id)
      if (!prompt) throw new Error("external read permission was not requested")
      await PermissionNext.reply({ requestID: prompt.id, reply: "once" })
      await first

      const second = request()
      const pending = await wait(session.id)
      expect(pending).toBeDefined()
      await SessionFilesystem.authorize({
        sessionID: session.id,
        path: path.join(external.path, "data.txt"),
        access: "read",
      })

      await PermissionNext.reply({ requestID: pending!.id, reply: "reject" })
      await expect(second).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    })
  })

  test("does not escalate an always-approved read into external write authority", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const glob = path.join(external.path, "*")
      const request = (access: "read" | "write") =>
        PermissionNext.ask({
          sessionID: session.id,
          permission: "external_directory",
          patterns: [glob],
          always: [glob],
          metadata: {
            filesystem: {
              path: external.path,
              access,
            },
          },
          ruleset: [],
        })

      const read = request("read")
      const prompt = await wait(session.id)
      if (!prompt) throw new Error("external read permission was not requested")
      await PermissionNext.reply({ requestID: prompt.id, reply: "always" })
      await read

      await expect(request("read")).resolves.toBeUndefined()
      const write = request("write")
      const promptWrite = await wait(session.id)
      expect(promptWrite).toBeDefined()
      await expect(
        SessionFilesystem.authorize({
          sessionID: session.id,
          path: path.join(external.path, "data.txt"),
          access: "write",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)

      await PermissionNext.reply({ requestID: promptWrite!.id, reply: "reject" })
      await expect(write).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    })
  })
})

describe("file access uses session grants", () => {
  test("File and File HTTP reads accept an explicit read grant but writes do not", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const target = path.join(external.path, "data.txt")
      await SessionFilesystem.grant({
        sessionID: session.id,
        path: external.path,
        access: "read",
        scope: "session",
      })
      expect((await File.read(target, { sessionID: session.id })).content).toBe("external")
      await expect(File.write(target, "mutated", { sessionID: session.id })).rejects.toBeInstanceOf(
        SessionFilesystem.DeniedError,
      )
      expect(await Bun.file(target).text()).toBe("external")

      const response = await FileRoutes().request(
        `/file/content?path=${encodeURIComponent(target)}&sessionID=${encodeURIComponent(session.id)}`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ content: "external" })
    })
  })

  test("HTTP writes require a session and the wrong session cannot read or write a grant", async () => {
    await using external = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "data.txt"), "external"),
    })
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({})
        const other = await Session.create({})
        await using _ = {
          [Symbol.asyncDispose]: async () => {
            await Promise.all([Session.remove(owner.id), Session.remove(other.id)])
          },
        }
        await SessionFilesystem.grant({
          sessionID: owner.id,
          path: external.path,
          access: "write",
          scope: "session",
        })

        const fetch = Server.internalFetch()
        const target = path.join(external.path, "data.txt")
        const url = (route: string) =>
          `http://openscience.internal${route}?directory=${encodeURIComponent(tmp.path)}&path=${encodeURIComponent(target)}`
        const write = (sessionID?: string) =>
          fetch(url("/file/content"), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              path: target,
              content: "mutated",
              ...(sessionID && { sessionID }),
            }),
          })

        expect((await write()).status).toBe(400)
        expect((await write(other.id)).status).toBe(403)
        expect((await fetch(`${url("/file/content")}&sessionID=${encodeURIComponent(other.id)}`)).status).toBe(403)
        expect((await write(owner.id)).status).toBe(200)
        expect(await Bun.file(target).text()).toBe("mutated")
      },
    })
  })
})
