import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BashTool, normalizeBashInput } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { executionSession, tmpdir } from "../fixture/fixture"
import { PermissionNext } from "../../src/permission/next"
import { Truncate } from "../../src/tool/truncation"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Shell } from "../../src/shell/shell"
import { Config } from "../../src/config/config"

async function context() {
  const session = await executionSession()
  return {
    sessionID: session.id,
    messageID: "",
    callID: "",
    agent: "research",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

const projectRoot = path.join(__dirname, "../..")

describe("tool.bash", () => {
  test("normalizes common provider argument dialects", () => {
    expect(normalizeBashInput({ cmd: "pwd" })).toMatchObject({
      command: "pwd",
      description: "Run pwd",
    })
    expect(
      normalizeBashInput({
        arguments: {
          script: "echo hello",
          purpose: "Print greeting",
          cwd: "/tmp",
          timeout_ms: 1200,
        },
      }),
    ).toMatchObject({
      command: "echo hello",
      description: "Print greeting",
      workdir: "/tmp",
      timeout: 1200,
    })
  })

  test("keeps an empty provider call invalid", () => {
    expect(normalizeBashInput({})).toEqual({})
  })

  test("documents process containment and the durable local job path", async () => {
    const bash = await BashTool.init()
    expect(bash.description).toContain("All Bash children stop when the call ends")
    for (const escape of ["`&`", "`nohup`", "`disown`", "`setsid`"]) {
      expect(bash.description).toContain(escape)
    }
    expect(bash.description).toContain("`compute_job` action `start`")
    expect(bash.description).toContain('target `{"kind":"local"}`')
    expect(bash.description).toContain("`wait`, `status`, or `logs`")
  })

  test("basic", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo 'test'",
            description: "Echo test message",
          },
          await context(),
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      },
    })
  })

  test("reports an upstream pipeline failure", async () => {
    if (!/^(bash|zsh)(\.exe)?$/i.test(path.basename(Shell.acceptable()))) return
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "false | true",
            description: "Checks pipeline failure status",
          },
          await context(),
        )
        expect(result.metadata.exit).not.toBe(0)
      },
    })
  })
})

describe("tool.bash permissions", () => {
  test("asks for bash permission with correct pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...(await context()),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo hello")
        expect(requests[0].metadata).toEqual({ shell: { command: "echo hello" } })
      },
    })
  })

  test("asks for bash permission with multiple commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...(await context()),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo foo && echo bar",
            description: "Echo twice",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo foo")
        expect(requests[0].patterns).toContain("echo bar")
        expect(requests[0].metadata).toEqual({ shell: { command: "echo foo && echo bar" } })
      },
    })
  })

  test("asks for external_directory permission when cd leaves the workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const target = path.join(outside.path, "target")
    await fs.mkdir(target)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const base = await context()
        const testCtx = {
          ...base,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
            const filesystem = req.metadata.filesystem
            if (!filesystem) return
            await SessionFilesystem.grant({
              sessionID: base.sessionID,
              path: filesystem.path,
              access: filesystem.access,
              scope: "session",
              source: "permission",
            })
          },
        }
        await bash.execute(
          {
            command: `cd ${target}`,
            description: "Change to an external directory",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
      },
    })
  })

  test("allows an external workdir when Full access is active", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const sandbox = await Config.trustedSandbox()
    await Config.setSandbox({ enabled: false })
    await using restore = {
      async [Symbol.asyncDispose]() {
        await Config.setSandbox(sandbox)
      },
    }
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...(await context()),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        const result = await bash.execute(
          {
            command: "pwd",
            workdir: outside.path,
            description: "Print external working directory",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
        expect(result.output).toContain(outside.path)
      },
    })
  })

  test("does not ask for external_directory permission when rm inside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...(await context()),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }

        await Bun.write(path.join(tmp.path, "tmpfile"), "x")

        await bash.execute(
          {
            command: "rm tmpfile",
            description: "Remove tmpfile",
          },
          testCtx,
        )

        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
      },
    })
  })

  test("includes always patterns for auto-approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...(await context()),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "git log --oneline -5",
            description: "Git log",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].always.length).toBeGreaterThan(0)
        expect(requests[0].always.some((p) => p.endsWith("*"))).toBe(true)
      },
    })
  })

  test("preserves exact source at the authorization boundary for cd-only commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...(await context()),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "cd .",
            description: "Stay in current directory",
          },
          testCtx,
        )
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toMatchObject({
          patterns: ["cd ."],
          metadata: { shell: { command: "cd ." } },
        })
      },
    })
  })

  test("Ask risky allows an audited read through the real Bash permission boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const base = await context()
        const command = process.platform === "win32" ? "cd" : "pwd"
        const result = await bash.execute(
          {
            command,
            description: "Read the current working directory",
          },
          {
            ...base,
            ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) =>
              PermissionNext.ask({
                ...request,
                sessionID: base.sessionID,
                ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
                mode: "approve",
              }),
          },
        )
        expect(result.metadata.exit).toBe(0)
        expect(path.isAbsolute(result.output.trim())).toBe(true)
        expect((await PermissionNext.list()).some((item) => item.sessionID === base.sessionID)).toBe(false)
      },
    })
  })

  test("Ask risky blocks a destructive command before Bash changes the workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const victim = path.join(tmp.path, "victim")
        await Bun.write(victim, "keep")
        const bash = await BashTool.init()
        const base = await context()
        const execution = bash
          .execute(
            {
              command: "rm -rf victim",
              description: "Remove test victim",
            },
            {
              ...base,
              ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) =>
                PermissionNext.ask({
                  ...request,
                  id: "permission_bash_risky_boundary",
                  sessionID: base.sessionID,
                  ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
                  mode: "approve",
                }),
            },
          )
          .catch((error) => error)

        let pending: PermissionNext.Request | undefined
        for (let attempt = 0; attempt < 100 && !pending; attempt++) {
          pending = (await PermissionNext.list()).find((item) => item.id === "permission_bash_risky_boundary")
          if (!pending) await Bun.sleep(5)
        }
        expect(pending).toMatchObject({
          permission: "bash",
          metadata: { shell: { command: "rm -rf victim" } },
        })
        expect(await Bun.file(victim).exists()).toBe(true)

        await PermissionNext.reply({ requestID: "permission_bash_risky_boundary", reply: "reject" })
        expect(await execution).toBeInstanceOf(PermissionNext.RejectedError)
        expect(await Bun.file(victim).exists()).toBe(true)
      },
    })
  })
})

describe("tool.bash truncation", () => {
  test("truncates output exceeding line limit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await bash.execute(
          {
            command: `seq 1 ${lineCount}`,
            description: "Generate lines exceeding limit",
          },
          await context(),
        )
        expect((result.metadata as any).truncated).toBe(true)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  test("truncates output exceeding byte limit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await bash.execute(
          {
            command: `head -c ${byteCount} /dev/zero | tr '\\0' 'a'`,
            description: "Generate bytes exceeding limit",
          },
          await context(),
        )
        expect((result.metadata as any).truncated).toBe(true)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  test("does not truncate small output", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          await context(),
        )
        expect((result.metadata as any).truncated).toBe(false)
        expect(result.output).toBe("hello\n")
      },
    })
  })

  test("full output is saved to file when truncated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await bash.execute(
          {
            command: `seq 1 ${lineCount}`,
            description: "Generate lines for file check",
          },
          await context(),
        )
        expect((result.metadata as any).truncated).toBe(true)

        const filepath = (result.metadata as any).outputPath
        expect(filepath).toBeTruthy()

        const saved = await Bun.file(filepath).text()
        const lines = saved.trim().split("\n")
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      },
    })
  })
})
