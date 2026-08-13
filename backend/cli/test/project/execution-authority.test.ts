import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { ExecutionAuthority } from "../../src/project/execution"
import { Project } from "../../src/project/project"
import { ProjectTrust } from "../../src/project/trust"
import { Pty } from "../../src/pty"
import { Sandbox } from "../../src/sandbox/sandbox"
import { KernelRuntime } from "../../src/science/kernel/registry"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { BashTool } from "../../src/tool/bash"
import "../../src/tool/notebook"
import { tmpdir } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "msg_authority",
  callID: "call_authority",
  agent: "research" as const,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

test("session execution authority is inspectable through the project route", async () => {
  await using tmp = await tmpdir({ git: true })
  const project = await Project.fromDirectory(tmp.path)
  const sessionID = await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      return (await Session.create({})).id
    },
  })
  const fetch = Server.internalFetch()
  const response = await fetch(
    `http://openscience.internal/project/${project.project.id}/execution?sessionID=${encodeURIComponent(sessionID)}&capability=terminal`,
    {
      headers: {
        "x-openscience-project": project.project.id,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(ExecutionAuthority.Decision.parse(await response.json())).toMatchObject({
    allowed: false,
    reason: "project_untrusted",
    capability: "terminal",
    mode: "read_only",
    projectID: project.project.id,
    sessionID,
  })
})

test("read-only project authority rejects terminal, shell, and kernel before process spawn", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      const session = await Session.create({})
      const marker = path.join(tmp.path, "process-spawned")
      const decision = await ExecutionAuthority.decide({
        projectID: Instance.project.id,
        sessionID: session.id,
        capability: "terminal",
      })

      expect(decision).toMatchObject({
        allowed: false,
        reason: "project_untrusted",
        mode: "read_only",
        projectID: Instance.project.id,
        sessionID: session.id,
        trustRevision: 2,
        sandbox: {
          enabled: true,
          network: "deny",
          onUnavailable: "error",
        },
      })
      expect(decision.grantRevision).toBeGreaterThanOrEqual(1)
      expect(decision.directory).toBe(tmp.path)
      expect(decision.workspace).toBe(await SessionFilesystem.workspace(session.id))
      expect(decision.writable).toContain(tmp.path)

      await expect(Pty.create({ sessionID: session.id })).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)
      expect(Pty.list()).toEqual([])

      const bash = await BashTool.init()
      await expect(
        bash.execute(
          {
            command: `printf spawned > ${JSON.stringify(marker)}`,
            description: "Attempt read-only spawn",
          },
          context(session.id),
        ),
      ).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)

      const identity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "authority-probe",
        language: "python" as const,
      }
      await expect(
        KernelRuntime.execute(identity, `open(${JSON.stringify(marker)}, "w").write("spawned")`),
      ).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)
      expect(KernelRuntime.status(identity)).toMatchObject({
        active: false,
        process_id: null,
      })
      expect(await Bun.file(marker).exists()).toBe(false)
    },
  })
})

test("authority generations change with trust and filesystem revisions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const initial = await ExecutionAuthority.decide({
        sessionID: session.id,
        capability: "kernel",
      })
      const trust = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, {
        trusted: true,
        root: trust.root,
      })
      const trusted = await ExecutionAuthority.decide({
        sessionID: session.id,
        capability: "kernel",
      })

      expect(trusted.trustRevision).toBeGreaterThan(initial.trustRevision)
      expect(trusted.generation).not.toBe(initial.generation)
      expect(trusted.allowed).toBe(trusted.sandbox.available)
      expect(trusted.reason).toBe(trusted.sandbox.available ? "allowed" : "sandbox_unavailable")

      await SessionFilesystem.grant({
        sessionID: session.id,
        path: tmp.path,
        access: "read",
        scope: "session",
      })
      const granted = await ExecutionAuthority.decide({
        sessionID: session.id,
        capability: "kernel",
      })
      expect(granted.grantRevision).toBeGreaterThan(trusted.grantRevision)
      expect(granted.generation).not.toBe(trusted.generation)
    },
  })
})

test("trusted terminal derives its process contract from the owning session", async () => {
  if (!Sandbox.available()) return
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const trust = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, {
        trusted: true,
        root: trust.root,
      })

      const terminal = await Pty.create({
        sessionID: session.id,
        title: "Authority terminal",
      })
      try {
        expect(terminal).toMatchObject({
          title: "Authority terminal",
          projectID: Instance.project.id,
          sessionID: session.id,
          cwd: await SessionFilesystem.workspace(session.id),
          authority: {
            allowed: true,
            capability: "terminal",
            mode: "sandboxed",
            sandbox: {
              enabled: true,
              enforced: true,
              network: "deny",
            },
          },
          status: "running",
        })
        expect(terminal.command).toBeTruthy()
        expect(terminal.pid).toBeGreaterThan(0)
        await Session.remove(session.id)
      } finally {
        await Pty.remove(terminal.id)
      }
      expect(Pty.list()).toEqual([])
    },
  })
})
