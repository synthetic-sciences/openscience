import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { JobBroker } from "../../src/compute/job-broker"
import { Instance } from "../../src/project/instance"
import { CapabilityRegistry } from "../../src/science/capability/registry"
import { CapabilityValidationTesting, validateCapabilitySmoke } from "../../src/science/capability/validation"
import { SessionFilesystem } from "../../src/session/filesystem"
import { executionSession, tmpdir } from "../fixture/fixture"

type ValidationFixture = {
  workspace: string
  root: string
  resultPath: string
  result: string
  manifest: NonNullable<ReturnType<typeof CapabilityRegistry.describe>>
  binding: JobBroker.CapabilityBinding
  job: JobBroker.Job
  sessionID: string
}

async function withValidationFixture(run: (fixture: ValidationFixture) => Promise<void>) {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const workspace = await SessionFilesystem.workspace(session.id)
      const root = path.join(workspace, "scientific-capabilities", "scipy", "validation")
      const resultPath = path.join(root, "capability-result.json")
      await fs.mkdir(root, { recursive: true })
      const result = JSON.stringify({
        schema_version: 1,
        capability_id: "scipy",
        ok: true,
        metrics: { x: 3, objective: 2 },
      })
      await fs.writeFile(resultPath, result)
      const bytes = await fs.readFile(resultPath)
      const captured = {
        path: "capability-result.json",
        size: bytes.byteLength,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        modified_at: new Date().toISOString(),
      }
      const manifest = CapabilityRegistry.describe("scipy")!
      const binding = CapabilityRegistry.binding({ manifest, profile: "smoke" })
      const job = JobBroker.Job.parse({
        id: "capability-validation-race",
        name: "SciPy bounded smoke",
        purpose: "Validate descriptor-backed smoke evidence",
        capability: binding,
        command: "python smoke.py",
        cwd: root,
        target: { kind: "local" },
        target_label: "Local",
        scheduler: "none",
        status: "succeeded",
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        exit_code: 0,
        artifacts: [captured],
        session_id: session.id,
      })
      await run({ workspace, root, resultPath, result, manifest, binding, job, sessionID: session.id })
    },
  })
}

describe("scientific capability smoke validation", () => {
  test("accepts exact captured evidence and rejects stale bindings, mutations, and escaped artifacts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const workspace = await SessionFilesystem.workspace(session.id)
        const root = path.join(workspace, "scientific-capabilities", "scipy", "validation")
        const resultPath = path.join(root, "capability-result.json")
        await fs.mkdir(root, { recursive: true })
        const result = JSON.stringify({
          schema_version: 1,
          capability_id: "scipy",
          ok: true,
          metrics: { x: 3, objective: 2 },
        })
        await fs.writeFile(resultPath, result)
        const bytes = await Bun.file(resultPath).arrayBuffer()
        const captured = {
          path: "capability-result.json",
          size: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          modified_at: new Date().toISOString(),
        }
        const manifest = CapabilityRegistry.describe("scipy")!
        const binding = CapabilityRegistry.binding({ manifest, profile: "smoke" })
        const job = JobBroker.Job.parse({
          id: "capability-validation",
          name: "SciPy bounded smoke",
          purpose: "Validate exact captured smoke evidence",
          capability: binding,
          command: "python smoke.py",
          cwd: root,
          target: { kind: "local" },
          target_label: "Local",
          scheduler: "none",
          status: "succeeded",
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          exit_code: 0,
          artifacts: [captured],
          session_id: session.id,
        })

        const valid = await validateCapabilitySmoke({
          manifest,
          job,
          sessionID: session.id,
          expectedBinding: binding,
        })
        expect(valid).toMatchObject({ ok: true, capability_id: "scipy", target: "local" })

        await expect(
          validateCapabilitySmoke({
            manifest,
            job: JobBroker.Job.parse({ ...job, capability: { ...binding, runtime_digest: "0".repeat(64) } }),
            sessionID: session.id,
            expectedBinding: binding,
          }),
        ).rejects.toThrow("not bound to the current SciPy smoke manifest")

        await fs.writeFile(
          resultPath,
          JSON.stringify({
            schema_version: 1,
            capability_id: "scipy",
            ok: true,
            metrics: { x: 3, objective: 9 },
          }),
        )
        await expect(
          validateCapabilitySmoke({ manifest, job, sessionID: session.id, expectedBinding: binding }),
        ).rejects.toThrow("changed after immutable capture")

        if (process.platform !== "win32") {
          const outside = path.join(workspace, "outside-capability-result.json")
          await fs.writeFile(outside, result)
          await fs.rm(resultPath)
          await fs.symlink(outside, resultPath)
          await expect(
            validateCapabilitySmoke({ manifest, job, sessionID: session.id, expectedBinding: binding }),
          ).rejects.toThrow("escaped its governed Session scratch directory")
        }
      },
    })
  })

  test("derives capture equality and semantic checks from one immutable byte snapshot", async () => {
    await withValidationFixture(async ({ resultPath, manifest, binding, job, sessionID }) => {
      const opened: string[] = []
      using _ = CapabilityValidationTesting.install({
        afterOpen(_target, relative) {
          opened.push(relative)
        },
        async afterSnapshot(target, relative) {
          if (relative !== "capability-result.json") return
          await fs.writeFile(
            target,
            JSON.stringify({
              schema_version: 1,
              capability_id: "scipy",
              ok: true,
              metrics: { x: 3, objective: 99 },
            }),
          )
        },
      })

      const valid = await validateCapabilitySmoke({ manifest, job, sessionID, expectedBinding: binding })
      expect(opened).toEqual(["capability-result.json"])
      expect(valid.metrics).toEqual({ x: 3, objective: 2 })
      expect(valid.artifacts[0]?.sha256).toBe(job.artifacts![0]!.sha256)
      expect(await fs.readFile(resultPath, "utf8")).toContain('"objective":99')
    })
  })

  test("rejects an in-place mutation while the descriptor-backed snapshot is being read", async () => {
    await withValidationFixture(async ({ manifest, binding, job, sessionID }) => {
      using _ = CapabilityValidationTesting.install({
        async afterOpen(target, relative) {
          if (relative !== "capability-result.json") return
          await fs.writeFile(
            target,
            JSON.stringify({
              schema_version: 1,
              capability_id: "scipy",
              ok: true,
              metrics: { x: 3, objective: 9 },
            }),
          )
        },
      })

      await expect(validateCapabilitySmoke({ manifest, job, sessionID, expectedBinding: binding })).rejects.toThrow(
        "changed during its immutable snapshot",
      )
    })
  })

  test.skipIf(process.platform === "win32")(
    "rejects a symlink swap after the governed artifact has been opened",
    async () => {
      await withValidationFixture(async ({ workspace, root, result, manifest, binding, job, sessionID }) => {
        const backup = path.join(root, "capability-result.original.json")
        const outside = path.join(workspace, "raced-capability-result.json")
        await fs.writeFile(outside, result)
        using _ = CapabilityValidationTesting.install({
          async afterOpen(target, relative) {
            if (relative !== "capability-result.json") return
            await fs.rename(target, backup)
            await fs.symlink(outside, target)
          },
        })

        await expect(validateCapabilitySmoke({ manifest, job, sessionID, expectedBinding: binding })).rejects.toThrow(
          "changed during its immutable snapshot",
        )
      })
    },
  )
})
