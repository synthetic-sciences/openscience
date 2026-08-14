import { expect, test } from "bun:test"
import path from "node:path"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { ProviderTokenCommand } from "../../src/provider/token-command"
import { tmpdir, trustProject } from "../fixture/fixture"

const posixTest = process.platform === "win32" ? test.skip : test
const darwinTest = process.platform === "darwin" ? test : test.skip

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function waitText(file: string): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (value?.trim()) return value.trim()
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

test("token helper environment excludes ambient provider and injection secrets", () => {
  const env = ProviderTokenCommand.environment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "en_US.UTF-8",
    AWS_PROFILE: "research",
    OPENAI_API_KEY: "provider-secret",
    OPENSCIENCE_TOKEN: "control-secret",
    LD_PRELOAD: "/tmp/inject.so",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    NODE_OPTIONS: "--require=/tmp/inject.js",
    PYTHONPATH: "/tmp/inject-python",
  })
  expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/tmp/home", LANG: "en_US.UTF-8", AWS_PROFILE: "research" })
  expect(env).not.toHaveProperty("OPENAI_API_KEY")
  expect(env).not.toHaveProperty("OPENSCIENCE_TOKEN")
  expect(env).not.toHaveProperty("LD_PRELOAD")
  expect(env).not.toHaveProperty("DYLD_INSERT_LIBRARIES")
  expect(env).not.toHaveProperty("NODE_OPTIONS")
  expect(env).not.toHaveProperty("PYTHONPATH")
})

posixTest("token helper enforces stdout bounds and reaps the owned process", async () => {
  await using tmp = await tmpdir({
    init: async (directory) => {
      const script = path.join(directory, "large-token.js")
      await Bun.write(script, `process.stdout.write("x".repeat(${ProviderTokenCommand.MAX_STDOUT_BYTES + 1}))`)
      return script
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      try {
        await expect(
          ProviderTokenCommand.run({
            command: `${quote(process.execPath)} ${quote(tmp.extra)}`,
            projectDeclared: false,
          }),
        ).rejects.toThrow(`stdout exceeded ${ProviderTokenCommand.MAX_STDOUT_BYTES} bytes`)
      } finally {
        await ProviderTokenCommand.revoke(Instance.project.id)
        await Instance.dispose()
      }
    },
  })
})

posixTest("token helper timeout kills its durable process tree", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const started = Date.now()
      try {
        await expect(
          ProviderTokenCommand.run({
            command: "sleep 600",
            projectDeclared: false,
            timeoutMs: 100,
          }),
        ).rejects.toThrow("tokenCommand timed out after 100ms")
        expect(Date.now() - started).toBeLessThan(5_000)
      } finally {
        await ProviderTokenCommand.revoke(Instance.project.id)
        await Instance.dispose()
      }
    },
  })
})

posixTest("credential revision revokes an in-flight token helper", async () => {
  await using tmp = await tmpdir({ init: async (directory) => path.join(directory, "helper.pid") })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let pid = 0
      let identity: string | undefined
      const running = ProviderTokenCommand.run({
        command: `printf %s $$ > ${quote(tmp.extra)}; sleep 600`,
        projectDeclared: false,
        timeoutMs: 20_000,
      }).then(
        (token) => ({ ok: true as const, token }),
        (error) => ({ ok: false as const, error }),
      )
      try {
        const reportedPID = Number(await waitText(tmp.extra))
        if (process.platform === "linux") {
          const entries = (await Bun.file(CredentialProcessLedger.pathForTests()).json()) as Array<{
            kind: string
            pid: number
            identity: string
            project_id?: string
          }>
          const entry = entries.find((item) => item.kind === "provider" && item.project_id === Instance.project.id)
          if (!entry) throw new Error("Missing durable provider process entry")
          pid =
            (await CredentialProcessLedger.resolveLinuxNamespacePID({
              leaderPID: entry.pid,
              leaderIdentity: entry.identity,
              namespacePID: reportedPID,
            })) ?? 0
          if (!pid) throw new Error("Could not resolve token helper sandbox PID")
        } else {
          pid = reportedPID
        }
        identity = await CredentialProcessLedger.identity(pid)
        expect(identity).toMatch(/^[a-f0-9]{64}$/)
        await CredentialLifecycle.mutate("token-command-process-test", async () => undefined)
        expect((await running).ok).toBe(false)
        expect(await CredentialProcessLedger.owns(pid, identity)).toBe(false)
      } finally {
        await ProviderTokenCommand.revoke(Instance.project.id).catch(() => undefined)
        if (pid && (await CredentialProcessLedger.owns(pid, identity))) process.kill(pid, "SIGKILL")
        await Instance.dispose()
      }
    },
  })
})

darwinTest(
  "project trust revocation reaps a fully reparented token-helper daemon",
  async () => {
    const python = Bun.which("python3")
    if (!python) return
    await using tmp = await tmpdir({
      init: async (directory) => {
        const marker = path.join(directory, "daemon.pid")
        const script = path.join(directory, "daemon.py")
        await Bun.write(
          script,
          [
            "import os, signal, time",
            "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
            "if os.fork(): os._exit(0)",
            "os.setsid()",
            "if os.fork(): os._exit(0)",
            `with open(${JSON.stringify(marker)}, "w") as handle: handle.write(str(os.getpid()))`,
            "time.sleep(600)",
          ].join("\n"),
        )
        return { marker, script }
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await trustProject()
        const projectID = Instance.project.id
        let daemon = 0
        let identity: string | undefined
        const running = ProviderTokenCommand.run({
          command: `${quote(python)} ${quote(tmp.extra.script)}; sleep 600`,
          projectDeclared: true,
          timeoutMs: 20_000,
        }).then(
          (token) => ({ ok: true as const, token }),
          (error) => ({ ok: false as const, error }),
        )
        try {
          daemon = Number(await waitText(tmp.extra.marker))
          identity = await CredentialProcessLedger.identity(daemon)
          expect(identity).toMatch(/^[a-f0-9]{64}$/)

          await ProjectTrust.update(Instance.project, { trusted: false })
          const result = await running
          expect(result.ok).toBe(false)
          expect(await CredentialProcessLedger.owns(daemon, identity)).toBe(false)
        } finally {
          await ProviderTokenCommand.revoke(projectID).catch(() => undefined)
          if (daemon && (await CredentialProcessLedger.owns(daemon, identity))) process.kill(daemon, "SIGKILL")
          await Instance.dispose()
        }
      },
    })
  },
  30_000,
)
