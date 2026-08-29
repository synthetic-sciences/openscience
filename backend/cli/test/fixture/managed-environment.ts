import {
  CORE_SCIENCE_LOCK_DIGEST,
  CORE_SCIENCE_REQUIREMENTS,
  CORE_SCIENCE_RUNTIME,
  coreScienceCondaLocks,
} from "../../src/science/capability/pack"
import fs from "node:fs/promises"
import path from "node:path"

const support = {
  micromambaSha256: process.env.OPENSCIENCE_TEST_MICROMAMBA_SHA256,
  ownershipFile: process.env.OPENSCIENCE_TEST_TRUSTED_OWNERSHIP,
  attestationLog: process.env.OPENSCIENCE_TEST_ATTESTATION_LOG,
}
if (process.env.OPENSCIENCE_TEST_DISABLE_MANAGED_ENVIRONMENT_SUPPORT !== "1") {
  ;(globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("openscience.managed-environment.test-support.v1")
  ] = support
}

const [{ ManagedEnvironments }, { CapabilityRegistry }, { CapabilityRuntime }] = await Promise.all([
  import("../../src/science/kernel/environment-manager"),
  import("../../src/science/capability/registry"),
  import("../../src/science/capability/runtime"),
])

const spec = {
  channels: ["conda-forge"],
  packages: [`python=${CORE_SCIENCE_RUNTIME.python}`, "pip=25.1.1"],
  conda_locks: coreScienceCondaLocks(),
  pip_packages: [...CORE_SCIENCE_RUNTIME.packages],
  pip_requirements: CORE_SCIENCE_REQUIREMENTS,
  lock_digest: CORE_SCIENCE_LOCK_DIGEST,
}
const expected = {
  conda_lock:
    coreScienceCondaLocks()[
      process.platform === "darwin" ? "osx-arm64" : process.arch === "arm64" ? "linux-aarch64" : "linux-64"
    ],
  lock_digest: CORE_SCIENCE_RUNTIME.lock_digest,
  pip_packages: CORE_SCIENCE_RUNTIME.packages,
  pip_requirements: CORE_SCIENCE_RUNTIME.pip_requirements,
  python: CORE_SCIENCE_RUNTIME.python,
}
const attestationLines = async () =>
  (
    await Bun.file(process.env.OPENSCIENCE_TEST_ATTESTATION_LOG ?? "")
      .text()
      .catch(() => "")
  )
    .split("\n")
    .filter(Boolean)

if (process.argv[2] === "runtime") {
  await ManagedEnvironments.runtime("python")
  await ManagedEnvironments.runtime("python")
  console.log("runtime-ok")
} else if (process.argv[2] === "bootstrap") {
  await ManagedEnvironments.bootstrap()
  console.log("bootstrap-ok")
} else if (process.argv[2] === "task") {
  await ManagedEnvironments.ensureTask(CORE_SCIENCE_RUNTIME.pack_id, spec)
  console.log(
    JSON.stringify(
      await ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, {
        ...expected,
      }),
    ),
  )
} else if (process.argv[2] === "doctor") {
  console.log(JSON.stringify(await CapabilityRuntime.doctor(CapabilityRegistry.describe("scipy")!)))
} else if (process.argv[2] === "partial") {
  console.log(
    JSON.stringify(
      await ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, {
        python: CORE_SCIENCE_RUNTIME.python,
        pip_packages: CORE_SCIENCE_RUNTIME.packages,
      }),
    ),
  )
} else if (process.argv[2] === "concurrent") {
  const before = await attestationLines()
  await Promise.all(
    Array.from({ length: 5 }, () => ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, expected)),
  )
  const after = await attestationLines()
  console.log(JSON.stringify(after.slice(before.length)))
} else if (process.argv[2] === "sequential") {
  const before = await attestationLines()
  await ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, expected)
  await ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, expected)
  const after = await attestationLines()
  console.log(JSON.stringify(after.slice(before.length)))
} else if (process.argv[2] === "status-twice") {
  const before = await attestationLines()
  await ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, expected, { verification: "status" })
  await ManagedEnvironments.inspect(CORE_SCIENCE_RUNTIME.pack_id, expected, { verification: "status" })
  const after = await attestationLines()
  console.log(JSON.stringify(after.slice(before.length)))
} else if (process.argv[2] === "compile") {
  await CapabilityRegistry.compileTask("scipy", {
    name: "Locked local task",
    purpose: "Verify the exact managed environment readiness gate.",
    command: "python analysis.py",
    target: "local",
  })
  console.log("compile-ok")
} else if (process.argv[2] === "approval-dispatch") {
  const planned = process.env.OPENSCIENCE_TEST_APPROVAL_PLANNED
  const approved = process.env.OPENSCIENCE_TEST_APPROVAL_GRANTED
  const project = process.env.OPENSCIENCE_TEST_APPROVAL_PROJECT
  if (!planned || !approved || !project) throw new Error("Expected approval-dispatch fixture paths")
  const [{ Instance }, { executionSession }, { SessionFilesystem }, { ScientificCapabilityTool }] = await Promise.all([
    import("../../src/project/instance"),
    import("./fixture"),
    import("../../src/session/filesystem"),
    import("../../src/tool/scientific-capability"),
  ])
  await fs.mkdir(project, { recursive: true })
  const outcome = await Instance.provide({
    directory: project,
    fn: async () => {
      const session = await executionSession()
      const workspace = await SessionFilesystem.workspace(session.id)
      const marker = path.join(workspace, "workload-executed.marker")
      const tool = await ScientificCapabilityTool.init()
      const context = {
        sessionID: session.id,
        messageID: "msg_approval_boundary",
        callID: "call_approval_boundary",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {
          await fs.writeFile(planned, "planned", { mode: 0o600 })
          for (let attempt = 0; attempt < 3_000; attempt++) {
            if (await Bun.file(approved).exists()) return
            await Bun.sleep(10)
          }
          throw new Error("Timed out waiting for the deterministic test approval")
        },
      }
      try {
        const result = await tool.execute(
          {
            action: "start",
            id: "scipy",
            name: "Approval boundary regression",
            purpose: "Prove exact runtime integrity is checked again after approval.",
            command: "printf executed > workload-executed.marker",
            target: "local",
          },
          context,
        )
        const job = result.metadata.job as { id: string } | undefined
        if (!job) throw new Error("Capability dispatch did not return its governed job")
        const waited = await tool.execute({ action: "wait", job_id: job.id, seconds: 10 }, context)
        const finished = JSON.parse(waited.output) as { status: string; error?: string }
        return {
          outcome: "completed" as const,
          status: finished.status,
          error: finished.error ?? null,
          marker: await Bun.file(marker).exists(),
        }
      } catch (error) {
        return {
          outcome: "rejected" as const,
          error: error instanceof Error ? error.message : String(error),
          marker: await Bun.file(marker).exists(),
        }
      }
    },
  })
  console.log(JSON.stringify(outcome))
} else if (process.argv[2] === "invalid-lock") {
  const locks = coreScienceCondaLocks()
  await ManagedEnvironments.ensureTask("invalid-lock", {
    ...spec,
    conda_locks: {
      ...locks,
      "osx-arm64": locks["osx-arm64"].replace("/osx-arm64/", "/linux-64/"),
    },
  })
} else {
  throw new Error("Expected a managed environment fixture mode")
}
