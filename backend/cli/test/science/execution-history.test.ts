import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ExecutionHistory } from "../../src/science/execution/history"
import { ProvenanceEnvelope } from "../../src/science/provenance/envelope"
import { Provenance } from "../../src/science/provenance/store"
import { tmpdir } from "../fixture/fixture"
import { KernelRuntime } from "../../src/science/kernel/registry"
import { AtlasEnvironment } from "../../src/science/kernel/types"
import "../../src/tool/notebook"

test("execution history projects ordered, restart-aware runs and their saved results", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      const record = async (id: string, at: number, incarnation: number, stdout: string, executionSequence?: number) =>
        Provenance.recordOwned(scope, {
          id,
          kind: "run",
          label: "Python execution",
          tool: "python",
          sessionID: "ses_history",
          inputs: { language: "python", code: stdout },
          status: "ok",
          provenance: ProvenanceEnvelope.create({
            kind: "kernel",
            projectID: Instance.project.id,
            sessionID: "ses_history",
            runID: id,
            code: stdout,
            kernel: {
              id: "kernel-history",
              language: "python",
              environmentName: "analysis",
              interpreter: { name: "Python", binary: "/usr/bin/python3", version: "3.12" },
              incarnation,
            },
            status: "succeeded",
            outputs: [
              ProvenanceEnvelope.output({
                kind: "artifact",
                label: "result.csv",
                path: "result.csv",
                content: stdout,
                createdAt: at + 25,
              }),
            ],
            createdAt: at,
            startedAt: at,
            completedAt: at + 25,
          }),
          meta: {
            stdout,
            stderr: "",
            result: stdout,
            resources: { memory_bytes: 4096 },
            ...(executionSequence !== undefined ? { executionSequence } : {}),
          },
        } as Parameters<typeof Provenance.record>[0])

      const first = await record("run_history_1", 1_000, 1, "first")
      const second = await record("run_history_2", 2_000, 2, "second")
      const artifact = await Provenance.recordOwned(scope, {
        id: "artifact-version:result",
        kind: "artifact",
        label: "Result · version 1",
        artifactType: "dataset",
        contentHash: "a".repeat(64),
        size: 12,
        meta: { artifactID: "art_result", versionID: "ver_result" },
      } as Parameters<typeof Provenance.record>[0])
      await Provenance.linkOwned(scope, { from: second.id, to: artifact.id, relation: "produced" })

      const history = await ExecutionHistory.list(scope, "ses_history")
      expect(history).toHaveLength(2)
      expect(history[0]).toMatchObject({
        id: "run_history_1",
        sequence: 1,
        language: "python",
        environment: { restart_boundary: false, incarnation: { status: "available", value: 1 } },
        timing: { duration_ms: { status: "available", value: 25 } },
        resources: { status: "available", value: { memory_bytes: 4096 } },
      })
      expect(history[1]).toMatchObject({
        id: "run_history_2",
        sequence: 2,
        environment: { restart_boundary: true, incarnation: { status: "available", value: 2 } },
        artifacts: [{ id: artifact.id, artifact_id: "art_result", version_id: "ver_result" }],
      })
      expect(history[1]!.files).toEqual([
        { path: "result.csv", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), size: 6 },
      ])
      expect(first.id).toBe("run_history_1")
    },
  })
})

test("execution history keeps a persisted cross-language order when timestamps tie", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      const tied = 1_000
      for (const [id, tool, sequence] of [
        ["run_z_first", "python", 1],
        ["run_a_second", "r", 2],
      ] as const) {
        await Provenance.recordOwned(scope, {
          id,
          kind: "run",
          label: `${tool} execution`,
          tool,
          sessionID: "ses_tied",
          inputs: { language: tool, code: id },
          status: "ok",
          provenance: ProvenanceEnvelope.create({
            kind: "kernel",
            projectID: Instance.project.id,
            sessionID: "ses_tied",
            runID: id,
            code: id,
            kernel: { id: `kernel-${tool}`, language: tool, incarnation: 1 },
            status: "succeeded",
            outputs: [],
            createdAt: tied,
            startedAt: tied,
            completedAt: tied,
          }),
          meta: { executionSequence: sequence },
        } as Parameters<typeof Provenance.record>[0])
      }

      const history = await ExecutionHistory.list(scope, "ses_tied")
      expect(history.map((item) => [item.id, item.sequence])).toEqual([
        ["run_z_first", 1],
        ["run_a_second", 2],
      ])
    },
  })
})

test("restore converts a dead backend's running execution into a durable interrupted record", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_execution_crash_recovery"
      const queued = await ExecutionHistory.submit({
        sessionID,
        language: "python",
        environmentName: "analysis",
        kernelName: "python",
        code: "important_value = expensive_step()",
        messageID: "message_crash",
        callID: "call_crash",
      })
      await ExecutionHistory.start(queued, {
        startedAt: 1_000,
        kernelID: "kernel-crash-history",
        incarnation: 3,
        environment: {
          cwd: tmp.path,
          interpreter: { name: "analysis", binary: "/usr/bin/python3", version: "Python 3.12" },
          atlas: AtlasEnvironment,
          sandbox: {
            requested: true,
            enforced: false,
            backend: "none",
            network: "deny",
            platform: process.platform,
            available: false,
          },
        },
      })

      const running = await ExecutionHistory.list(
        { projectID: Instance.project.id, directory: Instance.directory },
        sessionID,
      )
      expect(running).toMatchObject([
        {
          id: queued.id,
          sequence: 1,
          status: "running",
          code: { status: "available", value: "important_value = expensive_step()" },
          environment: {
            name: { status: "available", value: "analysis" },
            kernel_id: { status: "available", value: "kernel-crash-history" },
            incarnation: { status: "available", value: 3 },
            interpreter: {
              status: "available",
              value: { name: "analysis", binary: "/usr/bin/python3" },
            },
          },
          provenance_id: null,
          message_id: "message_crash",
          call_id: "call_crash",
        },
      ])

      await ExecutionHistory.orphanForTests(sessionID, queued.sequence)
      await KernelRuntime.restoreSession(Instance.project.id, sessionID)
      const recovered = await ExecutionHistory.list(
        { projectID: Instance.project.id, directory: Instance.directory },
        sessionID,
      )
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({
        id: queued.id,
        sequence: 1,
        status: "interrupted",
        result: {
          summary: "Execution interrupted during backend recovery",
          error: expect.stringContaining("stopped before this execution recorded a terminal result"),
        },
        timing: {
          started_at: { status: "available", value: new Date(1_000).toISOString() },
          completed_at: { status: "available", value: expect.any(String) },
          duration_ms: { status: "available", value: expect.any(Number) },
        },
        provenance_id: null,
      })
    },
  })
})
