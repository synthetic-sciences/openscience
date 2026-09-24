import {
  CORE_SCIENCE_LOCK_DIGEST,
  CORE_SCIENCE_REQUIREMENTS,
  CORE_SCIENCE_RUNTIME,
  coreScienceCondaLocks,
} from "../../src/science/capability/pack"
import fs from "node:fs/promises"
import path from "node:path"
import { Log } from "../../src/util/log"
import { AtomicRename } from "../../src/util/atomic-rename"
import { spyOn } from "bun:test"
import { FileLease } from "../../src/util/file-lease"

await Log.init({ print: false, dev: true })

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

if (process.argv[2] === "status-corruption") {
  await ManagedEnvironments.bootstrap()
  const conda = path.join(process.env.OPENSCIENCE_DATA_DIR!, "conda")
  const state = path.join(conda, "state.json")
  const original = await fs.readFile(state, "utf8")
  await fs.writeFile(
    path.join(conda, "envs", "r", "bin", "Rscript"),
    "#!/bin/sh\necho 'R package tidyverse is missing' >&2\nexit 1\n",
  )
  const failed = await ManagedEnvironments.status()
  const preserved = (await fs.readFile(state, "utf8")) === original
  await fs.writeFile(
    state,
    JSON.stringify({
      ...JSON.parse(original),
      status: "failed",
      phase: "failed:r",
      error: "Previous environment remains in rollback after restore failed",
    }),
  )
  const recorded = await ManagedEnvironments.status()
  await ManagedEnvironments.repair()
  const repaired = await ManagedEnvironments.status()
  console.log(JSON.stringify({ failed, preserved, recorded, repaired }))
} else if (process.argv[2] === "status-before-repair" || process.argv[2] === "repair-before-status") {
  await ManagedEnvironments.bootstrap()
  const conda = path.join(process.env.OPENSCIENCE_DATA_DIR!, "conda")
  const prefix = path.join(conda, "envs", "r")
  const binary = path.join(prefix, "bin", "Rscript")
  const started = path.join(conda, "probe-started")
  const release = path.join(conda, "probe-release")
  const calls = path.join(conda, "probe-calls")
  const script = `#!/bin/sh\necho probe >> "${calls}"\nif mkdir "${started}" 2>/dev/null; then\nwhile [ ! -f "${release}" ]; do sleep 0.01; done\nfi\nexit 1\n`
  await fs.writeFile(binary, script)
  const wait = async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await fs.stat(started).catch(() => undefined)) return
      await Bun.sleep(10)
    }
    throw new Error("The controlled R probe did not start")
  }
  const count = async () => (await fs.readFile(calls, "utf8")).trim().split("\n").length
  if (process.argv[2] === "status-before-repair") {
    const status = ManagedEnvironments.status()
    await wait()
    const acquire = FileLease.acquire
    const requested = Promise.withResolvers<void>()
    using attempt = spyOn(FileLease, "acquire").mockImplementation((file, timeout, signal) => {
      if (file === path.join(conda, "starter-r.lock") && (timeout ?? 0) > 0) requested.resolve()
      return acquire(file, timeout, signal)
    })
    const held = await acquire(path.join(conda, "starter-r.lock"), 0).then(
      async (lease) => {
        await lease[Symbol.asyncDispose]()
        return false
      },
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith("Timed out waiting for another OpenScience process to release "),
    )
    const repair = ManagedEnvironments.repair()
    try {
      await requested.promise
      console.log(
        JSON.stringify({ held, calls: await count(), unchanged: (await fs.readFile(binary, "utf8")) === script }),
      )
    } finally {
      await fs.writeFile(release, "release")
      await Promise.all([status, repair])
    }
  } else {
    const repair = ManagedEnvironments.repair()
    await wait()
    const status = ManagedEnvironments.status()
    try {
      const result = await Promise.race([status, Bun.sleep(1_000).then(() => undefined)])
      console.log(
        JSON.stringify({
          returned: !!result,
          status: result?.status,
          phase: result?.phase,
          r: result?.environments.find((item) => item.language === "r"),
          calls: await count(),
        }),
      )
    } finally {
      await fs.writeFile(release, "release")
      await Promise.all([status, repair])
    }
  }
} else if (process.argv[2] === "state-sharing" || process.argv[2] === "state-locked") {
  await ManagedEnvironments.bootstrap()
  const state = path.join(process.env.OPENSCIENCE_DATA_DIR!, "conda", "state.json")
  const original = await fs.readFile(state, "utf8")
  const sibling = `${state}.other-writer.tmp`
  await fs.writeFile(sibling, "another writer")
  const rename = fs.rename.bind(fs)
  const replace = AtomicRename.replace
  const staged: string[] = []
  let intact = true
  using policy = spyOn(AtomicRename, "replace").mockImplementation((source, destination) =>
    replace(source, destination, true),
  )
  using failures = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(destination) !== state) return rename(source, destination)
    staged.push(String(source))
    intact &&= (await fs.readFile(destination, "utf8")) === original
    const code = process.argv[2] === "state-locked" ? "EPERM" : ["EPERM", "EACCES", "EBUSY"][staged.length - 1]
    if (code) throw Object.assign(new Error(`injected ${code}: ${state}`), { code })
    return rename(source, destination)
  })
  const started = performance.now()
  const error = await ManagedEnvironments.bootstrap().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  console.log(
    JSON.stringify({
      error,
      elapsed: performance.now() - started,
      attempts: staged.length,
      staged: [...new Set(staged)],
      intact,
      preserved: (await fs.readFile(state, "utf8")) === original,
      committed: JSON.parse(await fs.readFile(state, "utf8")),
      sibling: await fs.readFile(sibling, "utf8"),
      leftovers: (await fs.readdir(path.dirname(state))).filter((name) => name.startsWith("state.json.")),
    }),
  )
} else if (process.argv[2] === "repair-cached") {
  await ManagedEnvironments.bootstrap()
  const prefix = path.join(process.env.OPENSCIENCE_DATA_DIR!, "conda", "envs", "r")
  const binary = path.join(prefix, "bin", "Rscript")
  const original = await fs.readFile(binary, "utf8")
  await fs.writeFile(binary, "#!/bin/sh\nexit 1\n")
  const before = await fs.readFile(process.env.OPENSCIENCE_R_PROBE_LOG!, "utf8")
  await ManagedEnvironments.runtime("r")
  const cached = (await fs.readFile(process.env.OPENSCIENCE_R_PROBE_LOG!, "utf8")) === before
  const installs = (await fs.readFile(process.env.OPENSCIENCE_PREFIX_LOG!, "utf8")).trim().split("\n").length
  await Promise.all([ManagedEnvironments.repair(), ManagedEnvironments.repair(), ManagedEnvironments.repair()])
  const repaired = (await fs.readFile(binary, "utf8")) === original
  const after = await fs.readFile(process.env.OPENSCIENCE_R_PROBE_LOG!, "utf8")
  await ManagedEnvironments.runtime("r")
  console.log(
    JSON.stringify({
      cached,
      repaired,
      installs: (await fs.readFile(process.env.OPENSCIENCE_PREFIX_LOG!, "utf8")).trim().split("\n").length - installs,
      probes: after.trim().split("\n").length - before.trim().split("\n").length,
      runtimeCached: (await fs.readFile(process.env.OPENSCIENCE_R_PROBE_LOG!, "utf8")) === after,
    }),
  )
} else if (process.argv[2] === "repair-rollback") {
  await ManagedEnvironments.bootstrap()
  const conda = path.join(process.env.OPENSCIENCE_DATA_DIR!, "conda")
  const prefix = path.join(conda, "envs", "r")
  await fs.writeFile(path.join(prefix, "bin", "Rscript"), "#!/bin/sh\nexit 1\n")
  await fs.writeFile(path.join(prefix, "user-package.txt"), "keep installed package")
  process.env.OPENSCIENCE_TEST_R_PROBE_FAILS = "1"
  const rename = fs.rename.bind(fs)
  using failures = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source).startsWith(path.join(conda, ".rollback")) && String(destination) === prefix) {
      throw Object.assign(new Error(`injected EIO restoring ${source} to ${destination}`), { code: "EIO" })
    }
    return rename(source, destination)
  })
  const error = await ManagedEnvironments.repair().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  const previous = (await fs.readdir(path.join(conda, ".rollback"))).map((name) => path.join(conda, ".rollback", name))
  console.log(
    JSON.stringify({
      error,
      previous,
      preserved: await fs.readFile(path.join(previous[0]!, "user-package.txt"), "utf8"),
      targetExists: await Bun.file(path.join(prefix, "bin", "Rscript")).exists(),
    }),
  )
} else if (process.argv[2] === "runtime") {
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

await Log.flush()
