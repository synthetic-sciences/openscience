import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
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
  const decision = ExecutionAuthority.Decision.parse(await response.json())
  expect(decision).toMatchObject({
    allowed: Sandbox.available(),
    reason: Sandbox.available() ? "allowed" : "sandbox_unavailable",
    capability: "terminal",
    mode: Sandbox.available() ? "sandboxed" : "read_only",
    projectID: project.project.id,
    sessionID,
    sandbox: {
      enabled: true,
      enforced: Sandbox.available(),
      requireProjectTrust: false,
    },
  })
  const { requireProjectTrust, ...legacySandbox } = decision.sandbox
  expect(requireProjectTrust).toBe(false)
  expect(ExecutionAuthority.Decision.parse({ ...decision, sandbox: legacySandbox }).sandbox.requireProjectTrust).toBe(
    false,
  )
})

test("untrusted projects run routine terminals, shells, and kernels only in an enforced sandbox", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      const session = await Session.create({})
      const shellMarker = path.join(tmp.path, "shell-spawned")
      const kernelMarker = path.join(tmp.path, "kernel-spawned")
      const decision = await ExecutionAuthority.decide({
        projectID: Instance.project.id,
        sessionID: session.id,
        capability: "terminal",
      })

      expect(decision).toMatchObject({
        allowed: Sandbox.available(),
        reason: Sandbox.available() ? "allowed" : "sandbox_unavailable",
        mode: Sandbox.available() ? "sandboxed" : "read_only",
        projectID: Instance.project.id,
        sessionID: session.id,
        trustRevision: 2,
        sandbox: {
          enabled: true,
          network: "deny",
          onUnavailable: "error",
          requireProjectTrust: false,
          enforced: Sandbox.available(),
        },
      })
      expect(decision.grantRevision).toBeGreaterThanOrEqual(1)
      expect(decision.directory).toBe(tmp.path)
      expect(decision.workspace).toBe(await SessionFilesystem.workspace(session.id))
      expect(decision.writable).toContain(tmp.path)

      const bash = await BashTool.init()
      const identity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "authority-probe",
        language: "python" as const,
      }
      if (!Sandbox.available()) {
        await expect(Pty.create({ sessionID: session.id })).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)
        await expect(
          bash.execute(
            {
              command: `printf spawned > ${JSON.stringify(shellMarker)}`,
              description: "Attempt unavailable sandbox spawn",
            },
            context(session.id),
          ),
        ).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)
        await expect(
          KernelRuntime.execute(identity, `open(${JSON.stringify(kernelMarker)}, "w").write("spawned")`),
        ).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)
        expect(await Bun.file(shellMarker).exists()).toBe(false)
        expect(await Bun.file(kernelMarker).exists()).toBe(false)
        return
      }

      const terminal = await Pty.create({ sessionID: session.id })
      try {
        expect(terminal.authority).toMatchObject({ allowed: true, mode: "sandboxed", sandbox: { enforced: true } })
        const result = await bash.execute(
          {
            command: `printf spawned > ${JSON.stringify(shellMarker)}`,
            description: "Run sandboxed untrusted shell",
          },
          context(session.id),
        )
        expect(result.metadata.exit).toBe(0)
        expect(await Bun.file(shellMarker).text()).toBe("spawned")

        await KernelRuntime.execute(identity, `open(${JSON.stringify(kernelMarker)}, "w").write("spawned")`)
        expect(KernelRuntime.status(identity)).toMatchObject({
          active: true,
          authority: { allowed: true, mode: "sandboxed", sandbox: { enforced: true } },
        })
        expect(await Bun.file(kernelMarker).text()).toBe("spawned")
      } finally {
        await Pty.remove(terminal.id)
        await KernelRuntime.removeSession(identity.projectID, identity.sessionID)
      }
    },
  })
})

test("non-routine remote execution still requires explicit project trust", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      const session = await Session.create({})
      const sandboxed = await ExecutionAuthority.decide({ sessionID: session.id, capability: "remote_job" })
      expect(sandboxed).toMatchObject({
        allowed: false,
        reason: Sandbox.available() ? "project_untrusted" : "sandbox_unavailable",
        mode: "read_only",
      })
      if (Sandbox.available()) {
        expect(sandboxed.message).toContain("Trust this project")
        expect(sandboxed.remediation?.code).toBe("trust_project_required")
      }
    },
  })
})

test("global policy can require project trust even for enforced sandbox execution", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: true, onUnavailable: "error", requireProjectTrust: true })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const session = await Session.create({})
        const decision = await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })
        expect(decision).toMatchObject({
          allowed: false,
          reason: Sandbox.available() ? "project_untrusted" : "sandbox_unavailable",
          mode: "read_only",
          sandbox: { requireProjectTrust: true },
        })
        if (Sandbox.available()) {
          expect(decision.message).toContain("global Sandbox policy requires explicit trust")
          expect(decision.remediation?.code).toBe("trust_project_required")
        }
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})

test("unsandboxed host execution requires trust, then runs only after trust is granted", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: false, requireProjectTrust: false })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const session = await Session.create({})
        const denied = await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })
        expect(denied).toMatchObject({
          allowed: false,
          reason: "project_untrusted",
          mode: "read_only",
          sandbox: { enabled: false, enforced: false },
        })
        expect(denied.message).toContain("without an enforced OS sandbox")
        const error = await ExecutionAuthority.require({ sessionID: session.id, capability: "shell" }).catch(
          (cause) => cause,
        )
        expect(error).toBeInstanceOf(ExecutionAuthority.DeniedError)
        expect(error.message).toBe(denied.message)
        expect(error.toObject()).toMatchObject({
          name: "ExecutionAuthorityDeniedError",
          data: { message: denied.message },
        })

        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
        expect(await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })).toMatchObject({
          allowed: true,
          reason: "allowed",
          mode: "host",
        })
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
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
