import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { ExecutionAuthority } from "../../src/project/execution"
import { Project } from "../../src/project/project"
import { ProjectTrust } from "../../src/project/trust"
import { Pty } from "../../src/pty"
import { TerminalKey } from "../../src/pty/key"
import { Shell } from "../../src/shell/shell"
import { Sandbox } from "../../src/sandbox/sandbox"
import { KernelRuntime } from "../../src/science/kernel/registry"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { BashTool } from "../../src/tool/bash"
import "../../src/tool/notebook"
import { sandboxedExecution, tmpdir } from "../fixture/fixture"

/** The cookie a launcher-opened browser holds after trading its launch code. */
async function personCookie() {
  const key = await TerminalKey.exchange(await TerminalKey.mintCode())
  if (!key) throw new Error("launch code was not accepted")
  return `${TerminalKey.cookieName("")}=${key}`
}

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
  await using _sandbox = await sandboxedExecution()
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
  const inspect = (cookie?: string) =>
    fetch(
      `http://openscience.internal/project/${project.project.id}/execution?sessionID=${encodeURIComponent(sessionID)}&capability=terminal`,
      {
        headers: {
          "x-openscience-project": project.project.id,
          ...(cookie ? { cookie } : {}),
        },
      },
    )

  // Without the person's key a terminal request may come from an agent process,
  // so it is reported under the agent's sandbox policy.
  const keyless = ExecutionAuthority.Decision.parse(await (await inspect()).json())
  expect(keyless).toMatchObject({
    capability: "terminal",
    mode: Sandbox.available() ? "sandboxed" : "read_only",
    sandbox: { enabled: true, enforced: Sandbox.available() },
  })

  const response = await inspect(await personCookie())
  expect(response.status).toBe(200)
  const decision = ExecutionAuthority.Decision.parse(await response.json())
  expect(decision).toMatchObject({
    allowed: true,
    reason: "allowed",
    capability: "terminal",
    mode: "host",
    projectID: project.project.id,
    sessionID,
    sandbox: {
      enabled: false,
      enforced: false,
      requireProjectTrust: false,
    },
  })
  const { requireProjectTrust, ...legacySandbox } = decision.sandbox
  expect(requireProjectTrust).toBe(false)
  expect(ExecutionAuthority.Decision.parse({ ...decision, sandbox: legacySandbox }).sandbox.requireProjectTrust).toBe(
    false,
  )
  // A fresh decision names the owned scratch directory beside the working
  // directory. Decisions persisted in compute job histories by earlier builds
  // have no such field and must keep parsing: one old record must never make a
  // project's history "corrupt" and take the credential barrier down with it.
  expect(decision.scratch).toBeDefined()
  const { scratch, ...persisted } = decision
  expect(scratch).toBe(decision.workspace)
  expect(ExecutionAuthority.Decision.parse(persisted).scratch).toBeUndefined()
})

test("user terminals are independent of the enforced agent shell and kernel sandbox", async () => {
  await using _sandbox = await sandboxedExecution()
  await using tmp = await tmpdir({ git: true })
  await using outside = await tmpdir()
  // A login shell reads the host's startup files; an empty profile keeps the
  // test independent of whoever runs it (a plugin manager can swallow input).
  await using profile = await tmpdir()
  const previous = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR }
  process.env.HOME = profile.path
  process.env.ZDOTDIR = profile.path
  await using _profile = {
    async [Symbol.asyncDispose]() {
      for (const key of ["HOME", "ZDOTDIR"] as const) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    },
  }
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
        capability: "shell",
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
        const terminal = await Pty.create({ sessionID: session.id }, { key: true })
        expect(terminal.authority.mode).toBe("host")
        await Pty.remove(terminal.id)
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

      // A keyless request, as an agent process reaching the server would make,
      // gets the agent's sandbox rather than the person's shell.
      const agentReached = await Pty.create({ sessionID: session.id })
      try {
        expect(agentReached).toMatchObject({
          mode: "sandboxed",
          reason: "no_key",
          authority: { mode: "sandboxed", sandbox: { enabled: true, enforced: true, network: "deny" } },
        })
        const escaped = path.join(outside.path, "keyless-terminal")
        Pty.write(agentReached.id, `printf escaped > '${escaped}'\r`)
        await Bun.sleep(500)
        expect(await Bun.file(escaped).exists()).toBe(false)
      } finally {
        await Pty.remove(agentReached.id)
      }

      const terminal = await Pty.create({ sessionID: session.id }, { key: true })
      try {
        expect(terminal.mode).toBe("host")
        expect(terminal.authority).toMatchObject({
          allowed: true,
          mode: "host",
          sandbox: { enabled: false, enforced: false, network: "allow" },
        })
        const marker = path.join(outside.path, "user-terminal-config")
        // Keys typed before the login shell is ready can be lost, leaving only
        // the redirect's empty file; resend the idempotent command until the
        // text lands.
        const written = () =>
          Bun.file(marker)
            .text()
            .catch(() => "")
        for (let attempt = 0; attempt < 500 && (await written()) !== "user-terminal"; attempt++) {
          if (attempt % 50 === 0) Pty.write(terminal.id, `printf user-terminal > '${marker}'\r`)
          await Bun.sleep(20)
        }
        expect(await Bun.file(marker).text()).toBe("user-terminal")
        const denied = await bash.execute(
          {
            command: `printf agent-shell > '${marker}'`,
            description: "Check agent sandbox outside the project",
          },
          context(session.id),
        )
        expect(denied.metadata.exit).not.toBe(0)
        expect(await Bun.file(marker).text()).toBe("user-terminal")
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
}, 20_000)

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

test("Ask stays contained while a trusted legacy Full project may use the host", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: false, requireProjectTrust: false })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const session = await Session.create({})
        const contained = await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })
        expect(contained).toMatchObject({
          allowed: Sandbox.available(),
          reason: Sandbox.available() ? "allowed" : "sandbox_unavailable",
          mode: Sandbox.available() ? "sandboxed" : "read_only",
          accessMode: "ask",
          sandbox: { enabled: true, enforced: Sandbox.available() },
        })

        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
        expect(await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })).toMatchObject({
          allowed: true,
          reason: "allowed",
          mode: "host",
          accessMode: "full",
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

      // A launch prepared before the grant still holds: the grant widened
      // authority. A trust change or a root that disappeared narrows it.
      expect(ExecutionAuthority.narrowed(trusted, granted)).toBe(false)
      expect(ExecutionAuthority.narrowed(initial, trusted)).toBe(true)
      expect(ExecutionAuthority.narrowed(granted, trusted)).toBe(granted.readable.length > trusted.readable.length)
      expect(ExecutionAuthority.narrowed(granted, { ...granted, accessMode: "full" })).toBe(
        granted.accessMode !== "full",
      )
    },
  })
})

test("user terminal derives its ownership and teardown from the owning session", async () => {
  await using _sandbox = await sandboxedExecution()
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

      const terminal = await Pty.create(
        {
          sessionID: session.id,
          title: "Authority terminal",
        },
        { key: true },
      )
      try {
        expect(terminal).toMatchObject({
          title: "Authority terminal",
          mode: "host",
          projectID: Instance.project.id,
          sessionID: session.id,
          cwd: tmp.path,
          authority: {
            allowed: true,
            capability: "terminal",
            mode: "host",
            sandbox: {
              enabled: false,
              enforced: false,
              network: "allow",
            },
          },
          status: "running",
        })
        expect(terminal.command).toBeTruthy()
        expect(terminal.pid).toBeGreaterThan(0)

        // Only a client holding the person's key may attach to their shell.
        const socket = () => {
          const closed: (number | undefined)[] = []
          return {
            closed,
            ws: { readyState: 1, send() {}, close: (code?: number) => void closed.push(code) } as never,
          }
        }
        const keyless = socket()
        expect(Pty.connect(terminal.id, keyless.ws)).toBeUndefined()
        expect(keyless.closed).toEqual([Pty.KEY_REQUIRED])
        const keyed = socket()
        const handler = Pty.connect(terminal.id, keyed.ws, { key: true })
        expect(handler).toBeDefined()
        expect(keyed.closed).toEqual([])
        handler?.onClose()
        await Session.remove(session.id)
      } finally {
        await Pty.remove(terminal.id)
      }
      expect(Pty.list()).toEqual([])
    },
  })
})

test("terminals follow the selected connected working folder and explicit scratch choice", async () => {
  await using _sandbox = await sandboxedExecution()
  await using project = await tmpdir({ git: true })
  await using folder = await tmpdir()
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionFilesystem.grant({
        sessionID: session.id,
        path: folder.path,
        access: "write",
        scope: "session",
        source: "api",
      })
      const connected = await Pty.create({ sessionID: session.id })
      try {
        expect(connected.cwd).toBe(folder.path)
        expect(connected.authority.workspace).toBe(folder.path)
      } finally {
        await Pty.remove(connected.id)
      }
      await SessionFilesystem.setWorkingRoot(session.id, "scratch")
      const scratch = await Pty.create({ sessionID: session.id })
      try {
        expect(scratch.cwd).toBe(await SessionFilesystem.workspace(session.id))
        expect(scratch.cwd).not.toBe(folder.path)
      } finally {
        await Pty.remove(scratch.id)
      }
      await Session.remove(session.id)
    },
  })
})

test.skipIf(process.platform === "win32")(
  "Claude launcher runs the installed command once in the selected folder",
  async () => {
    await using project = await tmpdir({ git: true })
    await using folder = await tmpdir()
    await using profile = await tmpdir()
    const shell = Shell.preferred()
    if (!/\/(zsh|bash)$/.test(shell)) return
    const script = `${profile.path}/bin/claude`
    await Bun.write(
      script,
      "#!/bin/sh\npwd > .claude-launch-test.tmp\nmv .claude-launch-test.tmp .claude-launch-test\nprintf 'CLI_LAUNCHED\\n'\n",
    )
    await Bun.$`chmod +x ${script}`.quiet()
    const config = `export PATH='${profile.path}/bin':$PATH\n`
    await Bun.write(`${profile.path}/.zprofile`, config)
    await Bun.write(`${profile.path}/.bash_profile`, config)
    const previous = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR }
    process.env.HOME = profile.path
    process.env.ZDOTDIR = profile.path
    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const session = await Session.create({})
          await SessionFilesystem.grant({
            sessionID: session.id,
            path: folder.path,
            access: "write",
            scope: "session",
            source: "api",
          })
          await expect(Pty.create({ sessionID: session.id, program: "claude" })).rejects.toBeInstanceOf(
            Pty.KeyRequiredError,
          )
          const terminal = await Pty.create({ sessionID: session.id, program: "claude" }, { key: true })
          try {
            expect(terminal.title).toBe("Claude Code")
            expect(terminal.program).toBe("claude")
            expect(terminal.cwd).toBe(folder.path)
            const marker = `${folder.path}/.claude-launch-test`
            for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(50)
            expect((await Bun.file(marker).text()).trim().split("\n")).toEqual([folder.path])
            expect(Pty.get(terminal.id)?.status).toBe("running")
            expect(Pty.CreateInput.safeParse({ sessionID: session.id, program: "claude; injected" }).success).toBe(
              false,
            )
          } finally {
            await Pty.remove(terminal.id)
            await Session.remove(session.id)
          }
        },
      })
    } finally {
      for (const key of ["HOME", "ZDOTDIR"] as const) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  },
)
