import { expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { KernelEnvironmentMutation, rankPython } from "../../../src/science/kernel/environment-mutation"
import { KernelRuntime, type KernelIdentity } from "../../../src/science/kernel/registry"
import { PythonTool } from "../../../src/tool/notebook"
import { RTool } from "../../../src/tool/rkernel"
import type { PermissionNext } from "../../../src/permission/next"
import { executionSession, tmpdir } from "../../fixture/fixture"
import fs from "node:fs/promises"

test("recognizes Python and R package/environment mutations as exact immutable plans", () => {
  const python = KernelEnvironmentMutation.detect({
    language: "python",
    environment: "python",
    code: `subprocess.check_call([sys.executable, "-m", "pip", "install", "numpy==2.3.2"])`,
  })
  const r = KernelEnvironmentMutation.detect({
    language: "r",
    environment: "r",
    code: `install.packages("survival")`,
  })

  expect(python).toMatchObject({
    language: "python",
    environment: "python",
    operation: "package_install",
    manager: "pip",
    restart: true,
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(r).toMatchObject({
    language: "r",
    environment: "r",
    operation: "package_install",
    manager: "install.packages",
    restart: true,
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(
    KernelEnvironmentMutation.detect({ language: "python", environment: "python", code: "import numpy as np" }),
  ).toBeUndefined()
  expect(python?.digest).not.toBe(r?.digest)
})

test("recognizes pip flags without backtracking on adversarial separators", () => {
  expect(
    KernelEnvironmentMutation.detect({
      language: "python",
      environment: "python",
      code: `subprocess.check_call([sys.executable, "-m", "pip", "--quiet", "--no-cache-dir", "install", "numpy"])`,
    }),
  ).toMatchObject({ operation: "package_install", manager: "pip" })
  expect(
    KernelEnvironmentMutation.detect({
      language: "python",
      environment: "python",
      code: `subprocess.check_call([sys.executable, "-m", "pip", "--yes", "uninstall", "numpy"])`,
    }),
  ).toMatchObject({ operation: "package_remove", manager: "pip" })

  expect(
    KernelEnvironmentMutation.detect({
      language: "python",
      environment: "python",
      code: `pip ${"--pip ".repeat(50_000)}ordinary_code`,
    }),
  ).toBeUndefined()
})

test("prefers an installed scientific stack over a newer sparse Python", () => {
  expect(
    rankPython([
      {
        binary: "/python-3.14",
        major: 3,
        minor: 14,
        packages: { numpy: true, scipy: true, sklearn: false },
      },
      {
        binary: "/python-3.12",
        major: 3,
        minor: 12,
        packages: { numpy: true, scipy: true, sklearn: true },
      },
    ]),
  ).toBe("/python-3.12")
  expect(
    rankPython([
      { binary: "/python-3.11", major: 3, minor: 11, packages: { numpy: true } },
      { binary: "/python-3.13", major: 3, minor: 13, packages: { numpy: true } },
    ]),
  ).toBe("/python-3.13")
})

test("re-provisions missing default Python and R managed roots on ordinary starts", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const python = KernelEnvironmentMutation.managedRoot("python", "python")
      const r = KernelEnvironmentMutation.managedRoot("r", "r")
      await Promise.all([fs.rm(python, { recursive: true, force: true }), fs.rm(r, { recursive: true, force: true })])
      const pythonRuntime = await KernelEnvironmentMutation.pythonRuntime("python")
      const rRuntime = await KernelEnvironmentMutation.rRuntime()
      expect((await fs.stat(`${python}/site-packages`)).isDirectory()).toBe(true)
      expect((await fs.stat(`${r}/library`)).isDirectory()).toBe(true)
      expect(pythonRuntime.extraWritable).toBeUndefined()
      expect(rRuntime.extraWritable).toBeUndefined()
    },
  })
})

test("the Python tool starts the canonical host runtime for omitted and legacy default input", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Promise.all([
        fs.rm(`${tmp.path}/.venv`, { recursive: true, force: true }),
        fs.rm(KernelEnvironmentMutation.managedRoot("python", "python"), { recursive: true, force: true }),
      ])
      const session = await executionSession()
      const tool = await PythonTool.init()
      const identity: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "python",
        language: "python",
      }
      const context = (callID: string) => ({
        sessionID: session.id,
        messageID: "message_default_python",
        callID,
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      })

      try {
        const omitted = await tool.execute(
          { code: "print('python-omitted')", timeout: 30_000 },
          context("call_omitted"),
        )
        const legacy = await tool.execute(
          { code: "print('python-default')", environment: "default", timeout: 30_000 },
          context("call_default"),
        )
        expect(omitted.output.trim()).toBe("python-omitted")
        expect(legacy.output.trim()).toBe("python-default")
        expect(KernelRuntime.status(identity)).toMatchObject({ active: true, execution_count: 2 })
        expect(KernelRuntime.status(identity).environment?.interpreter.binary).not.toContain(".venv/default")
      } finally {
        await KernelRuntime.release(identity)
      }
    },
  })
}, 60_000)

test.skipIf(!Bun.which("Rscript"))(
  "the R tool starts the canonical host runtime for omitted and legacy default input",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fs.rm(KernelEnvironmentMutation.managedRoot("r", "r"), { recursive: true, force: true })
        const session = await executionSession()
        const tool = await RTool.init()
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "r",
          language: "r",
        }
        const context = (callID: string) => ({
          sessionID: session.id,
          messageID: "message_default_r",
          callID,
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        })

        try {
          const omitted = await tool.execute({ code: "cat('r-omitted')", timeout: 30_000 }, context("call_r_omitted"))
          const legacy = await tool.execute(
            { code: "cat('r-default')", environment: "default", timeout: 30_000 },
            context("call_r_default"),
          )
          expect(omitted.output.trim()).toBe("r-omitted")
          expect(legacy.output.trim()).toBe("r-default")
          expect(KernelRuntime.status(identity)).toMatchObject({ active: true, execution_count: 2 })
        } finally {
          await KernelRuntime.release(identity)
        }
      },
    })
  },
  60_000,
)

test("an approved Python environment change restarts only the affected warm process", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await PythonTool.init()
      const ordinaryRuntime = await KernelEnvironmentMutation.pythonRuntime("python")
      const mutationRuntime = await KernelEnvironmentMutation.pythonRuntime("python", true)
      const identity: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "python",
        language: "python",
      }
      const approvals: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const context = (callID: string) => ({
        sessionID: session.id,
        messageID: "message_environment_mutation",
        callID,
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask(request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) {
          approvals.push(request)
        },
      })

      try {
        expect(ordinaryRuntime.sandboxNetwork).toBeUndefined()
        expect(mutationRuntime).toMatchObject({ sandboxNetwork: "allow", extraWritable: [expect.any(String)] })
        await tool.execute({ code: "warm_state = 42", timeout: 30_000 }, context("call_warm"))
        const before = KernelRuntime.status(identity)
        const changed = await tool.execute(
          {
            code: `import subprocess, sys\nif False:\n    subprocess.check_call([sys.executable, "-m", "pip", "install", "never-run"])\nprint("change approved")`,
            timeout: 30_000,
          },
          context("call_change"),
        )
        const after = KernelRuntime.status(identity)
        const state = await tool.execute(
          { code: `print("warm_state" in globals())`, timeout: 30_000 },
          context("call_state"),
        )

        expect(approvals).toHaveLength(3)
        expect(approvals[0]).toMatchObject({ permission: "bash", patterns: ["python"] })
        expect(approvals[1]).toMatchObject({
          permission: "environment_mutation",
          patterns: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          always: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          metadata: {
            environment_mutation: {
              language: "python",
              environment: "python",
              operation: "package_install",
              manager: "pip",
              restart: true,
              warning: expect.stringContaining("package repositories"),
            },
          },
        })
        expect(approvals[2]).toMatchObject({ permission: "bash", patterns: ["python"] })
        expect(changed.metadata.restarted).toBe(true)
        expect(changed.output).toContain("Python restarted with cleared in-memory state")
        expect(after.incarnation).toBeGreaterThan(before.incarnation ?? 0)
        expect(after.process_id).not.toBe(before.process_id)
        expect(state.output.trim()).toBe("False")
      } finally {
        await KernelRuntime.release(identity)
      }
    },
  })
}, 60_000)

test.skipIf(!Bun.which("Rscript"))(
  "an approved R package change restarts the affected warm process",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const tool = await RTool.init()
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "r",
          language: "r",
        }
        const approvals: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const context = (callID: string) => ({
          sessionID: session.id,
          messageID: "message_r_environment_mutation",
          callID,
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask(request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) {
            approvals.push(request)
          },
        })

        try {
          expect(await KernelEnvironmentMutation.rRuntime(true)).toMatchObject({
            sandboxNetwork: "allow",
            extraWritable: [expect.any(String)],
          })
          await tool.execute({ code: "warm_state <- 42", timeout: 30_000 }, context("call_r_warm"))
          const before = KernelRuntime.status(identity)
          const changed = await tool.execute(
            {
              code: `if (FALSE) install.packages("never-run")\ncat("change approved\\n")`,
              timeout: 30_000,
            },
            context("call_r_change"),
          )
          const after = KernelRuntime.status(identity)
          const state = await tool.execute(
            { code: `cat(exists("warm_state"))`, timeout: 30_000 },
            context("call_r_state"),
          )

          expect(approvals).toHaveLength(3)
          expect(approvals[1]).toMatchObject({
            permission: "environment_mutation",
            metadata: {
              environment_mutation: {
                language: "r",
                environment: "r",
                operation: "package_install",
                manager: "install.packages",
                restart: true,
              },
            },
          })
          expect(changed.metadata.restarted).toBe(true)
          expect(changed.output).toContain("R restarted with cleared in-memory state")
          expect(after.incarnation).toBeGreaterThan(before.incarnation ?? 0)
          expect(after.process_id).not.toBe(before.process_id)
          expect(state.output.trim()).toBe("FALSE")
        } finally {
          await KernelRuntime.release(identity)
        }
      },
    })
  },
  60_000,
)
