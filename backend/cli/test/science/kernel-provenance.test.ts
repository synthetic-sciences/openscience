import { expect, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import { Instance } from "../../src/project/instance"
import { KernelExecutionError, KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import { Provenance } from "../../src/science/provenance/store"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import "../../src/tool/notebook"
import { tmpdir, trustProject } from "../fixture/fixture"

test("canonical runtime records agent kernel executions with outputs", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const identity: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "agent",
        language: "python",
      }
      try {
        const result = await KernelRuntime.execute(identity, "40 + 2", {
          origin: { messageID: "msg_kernel_origin", callID: "call_kernel_origin" },
        })
        expect(result.provenanceID).toMatch(/^[a-f0-9]{16}$/)
        expect(await Provenance.get(result.provenanceID!)).toMatchObject({
          kind: "run",
          tool: "python",
          sessionID: identity.sessionID,
          status: "ok",
          provenance: {
            format: "openscience.provenance.v1",
            kind: "kernel",
            identity: {
              project_id: { status: "available", value: Instance.project.id },
              session_id: { status: "available", value: session.id },
              run_id: { status: "available", value: expect.stringMatching(/^run-/) },
            },
            input: {
              code: { status: "available", value: "40 + 2" },
              cwd: { status: "available", value: await SessionFilesystem.workspace(session.id) },
              code_state: {
                status: "available",
                value: {
                  commit: { status: "available", value: expect.stringMatching(/^[a-f0-9]{40}$/) },
                  dirty: { status: "available", value: false },
                },
              },
            },
            environment: {
              host: {
                status: "available",
                value: {
                  platform: process.platform,
                  arch: process.arch,
                },
              },
              kernel: {
                status: "available",
                value: {
                  language: "python",
                  environment_name: { status: "available", value: "python" },
                  interpreter: {
                    status: "available",
                    value: {
                      name: "python",
                      binary: expect.any(String),
                      version: { status: "available", value: expect.stringMatching(/^Python /) },
                    },
                  },
                  incarnation: { status: "available", value: 1 },
                  process_id: { status: "available", value: expect.any(Number) },
                  process_started_at: { status: "available", value: expect.any(String) },
                },
              },
            },
            outputs: {
              status: "succeeded",
              items: [
                {
                  kind: "result",
                  sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                  version_id: { status: "unavailable", reason: "not_applicable" },
                  version: { status: "unavailable", reason: "not_applicable" },
                },
              ],
            },
            timestamps: {
              created_at: { status: "available", value: expect.any(String) },
              started_at: { status: "available", value: expect.any(String) },
              completed_at: { status: "available", value: expect.any(String) },
            },
            handoff: {
              atlas_compute_id: { status: "unavailable", reason: "not_implemented" },
              atlas_run_id: { status: "unavailable", reason: "not_published" },
            },
          },
          inputs: {
            kernel: "agent",
            language: "python",
            code: "40 + 2",
          },
          meta: {
            directory: tmp.path,
            projectID: Instance.project.id,
            messageID: "msg_kernel_origin",
            callID: "call_kernel_origin",
            kernelName: "agent",
            kernelEnvironment: "python",
            interpreter: {
              name: "python",
              binary: expect.any(String),
              version: expect.stringMatching(/^Python /),
            },
            executionCount: 1,
            stdout: "",
            stderr: "",
            result: "42",
          },
        })

        const failed = await KernelRuntime.execute(identity, "raise ValueError('bad sample')")
        expect(failed.ok).toBe(false)
        expect(await Provenance.get(failed.provenanceID!)).toMatchObject({
          kind: "run",
          sessionID: identity.sessionID,
          status: "error",
          provenance: {
            outputs: {
              status: "failed",
              items: [
                {
                  kind: "error",
                  sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
              ],
            },
          },
          inputs: {
            kernel: "agent",
            language: "python",
            code: "raise ValueError('bad sample')",
          },
          meta: {
            executionCount: 2,
            error: expect.stringContaining("ValueError: bad sample"),
          },
        })

        const firstFile = await KernelRuntime.execute(identity, "open('first-result.txt', 'w').write('one')")
        const secondFile = await KernelRuntime.execute(identity, "open('second-result.txt', 'w').write('two')")
        const firstNode = await Provenance.get(firstFile.provenanceID!)
        const secondNode = await Provenance.get(secondFile.provenanceID!)
        const paths = (node: typeof firstNode) => {
          if (!node || !("tool" in node)) return []
          return (node.provenance?.outputs.items ?? []).flatMap((item) =>
            item.path.status === "available" ? [item.path.value] : [],
          )
        }
        expect(paths(firstNode)).toContain("first-result.txt")
        expect(paths(firstNode)).not.toContain("second-result.txt")
        expect(paths(secondNode)).toContain("second-result.txt")
        expect(paths(secondNode)).not.toContain("first-result.txt")

        const secret = `kernel-provenance-${crypto.randomUUID()}`
        OpenScience.registerSecretValues([secret])
        const emitted = await KernelRuntime.execute(
          identity,
          `import sys\nvalue = "${secret}"\nprint(value)\nprint(value, file=sys.stderr)\nvalue`,
        )
        const emittedNode = await Provenance.get(emitted.provenanceID!)
        expect(JSON.stringify(emittedNode)).not.toContain(secret)
        expect(emittedNode).toMatchObject({
          inputs: {
            code: 'import sys\nvalue = "[REDACTED]"\nprint(value)\nprint(value, file=sys.stderr)\nvalue',
          },
          meta: {
            stdout: "[REDACTED]\n",
            stderr: "[REDACTED]\n",
          },
        })

        const returnedSecret = await KernelRuntime.execute(identity, `"${secret}"`)
        const resultNode = await Provenance.get(returnedSecret.provenanceID!)
        expect(JSON.stringify(resultNode)).not.toContain(secret)
        expect(resultNode).toMatchObject({
          inputs: { code: '"[REDACTED]"' },
          meta: { result: "'[REDACTED]'" },
        })

        const secretFailure = await KernelRuntime.execute(identity, `raise ValueError("${secret}")`)
        const failureNode = await Provenance.get(secretFailure.provenanceID!)
        expect(JSON.stringify(failureNode)).not.toContain(secret)
        expect(failureNode).toMatchObject({
          inputs: { code: 'raise ValueError("[REDACTED]")' },
          meta: { error: expect.stringContaining("[REDACTED]") },
        })
        expect(await Bun.file(Provenance.path_).text()).not.toContain(secret)

        const abort = new AbortController()
        setTimeout(() => abort.abort(), 50)
        const interrupted = await KernelRuntime.execute(identity, "import time\ntime.sleep(10)", {
          signal: abort.signal,
        }).catch((error) => error)
        expect(interrupted).toBeInstanceOf(KernelExecutionError)
        expect(interrupted.provenanceID).toMatch(/^[a-f0-9]{16}$/)
        expect(await Provenance.get(interrupted.provenanceID)).toMatchObject({
          kind: "run",
          sessionID: identity.sessionID,
          status: "error",
          provenance: {
            outputs: {
              status: "cancelled",
              items: [
                {
                  kind: "error",
                  sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
              ],
            },
          },
          inputs: {
            kernel: "agent",
            language: "python",
            code: "import time\ntime.sleep(10)",
          },
          meta: {
            error: expect.stringContaining("Execution aborted"),
          },
        })
      } finally {
        await KernelRuntime.release(identity)
      }
    },
  })
}, 30_000)
