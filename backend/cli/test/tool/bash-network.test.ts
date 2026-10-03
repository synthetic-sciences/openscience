import { describe, expect, test } from "bun:test"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { executionSession, tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { Sandbox } from "../../src/sandbox/sandbox"

async function harness() {
  const session = await executionSession()
  const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
  return {
    requests,
    ctx: {
      sessionID: session.id,
      messageID: "",
      callID: "",
      agent: "research",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => {},
      ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
        requests.push(request)
      },
    },
  }
}

describe("tool.bash network escalation", () => {
  test("a command that reaches the network asks for its destination before running", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const { ctx, requests } = await harness()
        // Connection refused fails fast on a closed local port; the approval
        // path is exercised regardless of what the destination answers.
        await bash
          .execute({ command: "curl -sS -m 2 http://127.0.0.1:9/health", description: "Probe a closed port" }, ctx)
          .catch(() => undefined)
        const network = requests.find((request) => request.permission === "network")
        if (!Sandbox.describe().available) {
          // Without an enforced sandbox the network is already reachable; no
          // approval is asked and no escalation is needed.
          expect(network).toBeUndefined()
          return
        }
        expect(network).toBeDefined()
        expect(network?.patterns).toEqual(["127.0.0.1"])
        expect(network?.always).toEqual(["127.0.0.1"])
        expect(network?.metadata.network).toMatchObject({ host: "127.0.0.1", hosts: ["127.0.0.1"] })
        expect(String((network?.metadata.network as { commands: string[] }).commands[0])).toContain(
          "curl -sS -m http://127.0.0.1:9/health".replace(" -m ", " -m "),
        )
        expect(network?.metadata.shell).toEqual({ command: "curl -sS -m 2 http://127.0.0.1:9/health" })
      },
    })
  })

  test("a network grant never extends to the rest of the script", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        if (!Sandbox.describe().available) return
        const bash = await BashTool.init()
        const { ctx, requests } = await harness()
        const marker = `${tmp.path}/rode-along`
        const scripts = [
          `curl -sS -m 2 http://127.0.0.1:9/health && touch ${marker}`,
          `curl -sS -m 2 http://127.0.0.1:9/install.sh | sh`,
          `export GIT_SSH_COMMAND="touch ${marker}"; git push origin main`,
          `GIT_SSH_COMMAND="touch ${marker}" git push origin main`,
        ]
        for (const command of scripts) {
          await expect(bash.execute({ command, description: "Mixed network script" }, ctx)).rejects.toThrow(
            "Network access is granted only to the network command itself",
          )
        }
        // `git -c` is not read as a push at all, so it never asks for the
        // network and runs inside the socket-denying sandbox.
        await bash
          .execute({ command: `git -c core.sshCommand="touch ${marker}" push origin main`, description: "Push" }, ctx)
          .catch(() => undefined)
        // Refused before any approval card, and nothing ran.
        expect(requests.some((request) => request.permission === "network")).toBe(false)
        expect(await Bun.file(marker).exists()).toBe(false)

        // Inert builtins beside the network command still share it.
        await bash
          .execute({ command: "cd . && curl -sS -m 2 http://127.0.0.1:9/health", description: "Probe" }, ctx)
          .catch(() => undefined)
        expect(requests.filter((request) => request.permission === "network")).toHaveLength(1)
      },
    })
  })

  test("local work never asks for the network", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const { ctx, requests } = await harness()
        await bash.execute({ command: "git status --short && echo done", description: "Inspect the tree" }, ctx)
        expect(requests.some((request) => request.permission === "network")).toBe(false)
      },
    })
  })

  test("a named remote resolves to its host for the approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.$`git remote add origin https://github.com/acme/repo.git`.cwd(tmp.path).quiet()
        const bash = await BashTool.init()
        const { ctx, requests } = await harness()
        await bash
          .execute(
            {
              command: "git ls-remote origin HEAD",
              description: "Check the remote",
              timeout: 3_000,
              workdir: tmp.path,
            },
            ctx,
          )
          .catch(() => undefined)
        const network = requests.find((request) => request.permission === "network")
        if (!Sandbox.describe().available) return
        expect(network?.patterns).toEqual(["github.com"])
      },
    })
  })
})
