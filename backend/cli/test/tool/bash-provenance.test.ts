import { describe, expect, test } from "bun:test"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { OpenScience } from "../../src/openscience"
import { Provenance } from "../../src/science/provenance/store"
import { SessionFilesystem } from "../../src/session/filesystem"
import { executionSession, tmpdir } from "../fixture/fixture"

async function context() {
  const session = await executionSession()
  return {
    sessionID: session.id,
    messageID: "msg_bash_provenance",
    callID: "call_bash_provenance",
    agent: "research" as const,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

describe("tool.bash provenance", () => {
  test("records a run node for a completed command", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await context()
        const workspace = await SessionFilesystem.workspace(ctx.sessionID)
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo provenance",
            description: "Echo provenance",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        const id = result.metadata.provenanceID
        expect(id).toMatch(/^[a-f0-9]{16}$/)
        expect(await Provenance.get(id!)).toMatchObject({
          kind: "run",
          tool: "bash",
          sessionID: ctx.sessionID,
          status: "ok",
          inputs: {
            command: "echo provenance",
          },
          provenance: {
            format: "openscience.provenance.v1",
            kind: "local_compute",
            identity: {
              project_id: { status: "available", value: Instance.project.id },
              session_id: { status: "available", value: ctx.sessionID },
              run_id: { status: "available", value: expect.stringMatching(/^run-/) },
            },
            input: {
              code: { status: "available", value: "echo provenance" },
              cwd: { status: "available", value: workspace },
            },
            environment: {
              host: {
                status: "available",
                value: {
                  platform: process.platform,
                  arch: process.arch,
                },
              },
            },
            outputs: {
              status: "succeeded",
              items: [
                {
                  kind: "stream",
                  sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
              ],
            },
            timestamps: {
              created_at: { status: "available", value: expect.any(String) },
              started_at: { status: "available", value: expect.any(String) },
              completed_at: { status: "available", value: expect.any(String) },
            },
          },
          meta: {
            directory: tmp.path,
            projectID: Instance.project.id,
            messageID: ctx.messageID,
            callID: ctx.callID,
            exit: 0,
            cwd: workspace,
            stdout: "provenance\n",
            stderr: "",
          },
        })
      },
    })
  })

  test("records a failed command with stderr and exit code", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await context()
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo broken >&2; exit 7",
            description: "Fail with stderr",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(7)
        expect(await Provenance.get(result.metadata.provenanceID!)).toMatchObject({
          kind: "run",
          tool: "bash",
          status: "error",
          provenance: {
            kind: "local_compute",
            outputs: {
              status: "failed",
            },
          },
          meta: {
            exit: 7,
            stderr: "broken\n",
          },
        })
      },
    })
  })

  test("redacts registered secrets from command and captured streams", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await context()
        const secret = `bash-provenance-${crypto.randomUUID()}`
        OpenScience.registerSecretValues([secret])
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: `echo ${secret}`,
            description: "Echo a secret",
          },
          ctx,
        )
        const node = await Provenance.get(result.metadata.provenanceID!)
        expect(JSON.stringify(node)).not.toContain(secret)
        expect(node).toMatchObject({
          inputs: {
            command: "echo [REDACTED]",
          },
          meta: {
            stdout: "[REDACTED]\n",
          },
        })
        expect(await Bun.file(Provenance.path_).text()).not.toContain(secret)
      },
    })
  })
})
