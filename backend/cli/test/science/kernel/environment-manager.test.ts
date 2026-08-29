import { expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CORE_SCIENCE_CONDA_LOCKS } from "../../../src/science/capability/conda-locks"
import { CORE_SCIENCE_RUNTIME, capabilityCondaPlatform, capabilityPlatform } from "../../../src/science/capability/pack"
import { Sandbox } from "../../../src/sandbox/sandbox"

const fixture = path.resolve(import.meta.dir, "../../fixture/managed-environment.ts")

async function executable(file: string, source: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, source)
  await fs.chmod(file, 0o755)
}

async function profile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-managed-environment-"))
  const data = path.join(root, "data")
  const conda = path.join(data, "conda")
  const pythonLog = path.join(root, "python-probes.log")
  const rLog = path.join(root, "r-probes.log")
  const prefixLog = path.join(root, "prefixes.log")
  const argsLog = path.join(root, "micromamba-args.log")
  const lockLog = path.join(root, "selected-conda-lock.txt")
  const trustedOwnership = path.join(root, "trusted-ownership.json")
  const attestationLog = path.join(root, "attestations.log")
  const startupMarker = path.join(root, "unsafe-python-startup")
  const packages = Object.fromEntries(
    CORE_SCIENCE_RUNTIME.packages.map((pin) => {
      const offset = pin.indexOf("==")
      return [pin.slice(0, offset), pin.slice(offset + 2)]
    }),
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSCIENCE_TEST_HOME: root,
    OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS: "1",
    OPENSCIENCE_DATA_DIR: data,
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENSCIENCE_PYTHON_PROBE_LOG: pythonLog,
    OPENSCIENCE_R_PROBE_LOG: rLog,
    OPENSCIENCE_PREFIX_LOG: prefixLog,
    OPENSCIENCE_MICROMAMBA_ARGS_LOG: argsLog,
    OPENSCIENCE_CONDA_LOCK_LOG: lockLog,
    OPENSCIENCE_TEST_TRUSTED_OWNERSHIP: trustedOwnership,
    OPENSCIENCE_TEST_ATTESTATION_LOG: attestationLog,
    OPENSCIENCE_UNSAFE_STARTUP_MARKER: startupMarker,
    OPENSCIENCE_FAKE_PYTHON_ATTESTATION: JSON.stringify({
      python: CORE_SCIENCE_RUNTIME.python,
      packages,
      integrity: true,
    }),
  }
  const micromamba = path.join(conda, "bin", process.platform === "win32" ? "micromamba.exe" : "micromamba")
  await executable(
    micromamba,
    `#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
const args = process.argv.slice(2)
const prefix = args[args.indexOf("-p") + 1]
const lockedFiles = []
fs.appendFileSync(process.env.OPENSCIENCE_MICROMAMBA_ARGS_LOG, JSON.stringify(args) + "\\n")
fs.appendFileSync(process.env.OPENSCIENCE_PREFIX_LOG, prefix + "\\n")
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true })
const file = args[args.indexOf("--file") + 1]
if (args.includes("--file")) {
  const lock = fs.readFileSync(file, "utf8")
  fs.writeFileSync(process.env.OPENSCIENCE_CONDA_LOCK_LOG, lock)
  fs.mkdirSync(path.join(prefix, "conda-meta"), { recursive: true })
  for (const [index, entry] of lock.split("\\n").slice(1).entries()) {
    const url = new URL(entry)
    const sha256 = url.hash.slice("#sha256=".length)
    url.hash = ""
    const relative = path.join(".fake-conda", index + ".txt")
    const target = path.join(prefix, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry)
    lockedFiles.push(relative)
    const installed = crypto.createHash("sha256").update(entry).digest("hex")
    fs.writeFileSync(
      path.join(prefix, "conda-meta", index + ".json"),
      JSON.stringify({
        url: url.toString(),
        sha256,
        paths_data: { paths: [{ _path: relative, sha256_in_prefix: installed }] },
      }),
    )
  }
}
const language = path.basename(prefix) === "r" ? "r" : "python"
const binary = path.join(prefix, "bin", language === "r" ? "Rscript" : "python")
const log = language === "r" ? process.env.OPENSCIENCE_R_PROBE_LOG : process.env.OPENSCIENCE_PYTHON_PROBE_LOG
fs.mkdirSync(path.join(prefix, "lib"), { recursive: true })
fs.writeFileSync(path.join(prefix, "lib", "fake-module.py"), "locked\\n")
lockedFiles.push(path.join("lib", "fake-module.py"))
const output = language === "r"
  ? "echo ok"
  : "case \\\"$*\\\" in *importlib.metadata*) if grep -qx locked \\\"$(dirname \\\"$0\\\")/../lib/fake-module.py\\\"; then printf '%s\\\\n' \\\"$OPENSCIENCE_FAKE_PYTHON_ATTESTATION\\\"; else printf '%s\\\\n' \\\"$OPENSCIENCE_FAKE_PYTHON_ATTESTATION\\\" | sed 's/\\\"integrity\\\":true/\\\"integrity\\\":false/'; fi ;; *) echo ok ;; esac"
fs.writeFileSync(binary, "#!/bin/sh\\necho task-probe >> \\\"" + log + "\\\"\\necho python >> \\\"$OPENSCIENCE_TEST_ATTESTATION_LOG\\\"\\nif [ -n \\\"$PYTHONPATH$PYTHONHOME\\\" ] || [ -f \\\"$(dirname \\\"$0\\\")/../lib/python3.12/site-packages/inject.pth\\\" ]; then printf executed > \\\"$OPENSCIENCE_UNSAFE_STARTUP_MARKER\\\"; fi\\n" + output + "\\n")
fs.chmodSync(binary, 0o755)
	if (args.includes("--file")) {
	  lockedFiles.push(path.join("bin", "python"))
  const record = path.join("lib", "python3.12", "site-packages", "fake-1.dist-info", "RECORD")
  fs.mkdirSync(path.dirname(path.join(prefix, record)), { recursive: true })
  fs.writeFileSync(path.join(prefix, record), "lib/fake-module.py,,\\n")
  lockedFiles.push(record)
	  if (process.env.OPENSCIENCE_TEST_INJECT_UNOWNED_PTH === "1") {
	    fs.writeFileSync(path.join(prefix, "lib", "python3.12", "site-packages", "inject.pth"), "import os\\n")
	  }
	  const nativeRelative = path.join("lib", "fake-native.dylib")
	  const native = Buffer.alloc(272)
	  native.writeUInt32LE(0xfeedfacf, 0)
	  native.writeUInt32LE(0x0100000c, 4)
	  native.writeUInt32LE(6, 12)
	  native.writeUInt32LE(2, 16)
	  native.writeUInt32LE(88, 20)
	  native.writeUInt32LE(0x19, 32)
	  native.writeUInt32LE(72, 36)
	  native.write("__LINKEDIT", 40, "ascii")
	  native.writeBigUInt64LE(16384n, 64)
	  native.writeBigUInt64LE(128n, 72)
	  native.writeBigUInt64LE(144n, 80)
	  native.writeUInt32LE(1, 88)
	  native.writeUInt32LE(1, 92)
	  native.writeUInt32LE(0x1d, 104)
	  native.writeUInt32LE(16, 108)
	  native.writeUInt32LE(256, 112)
	  native.writeUInt32LE(16, 116)
	  native.fill(0xa5, 120, 256)
	  native.fill(0x5a, 256)
	  fs.writeFileSync(path.join(prefix, nativeRelative), native)
	  lockedFiles.push(nativeRelative)
	  const files = Object.fromEntries(lockedFiles.map((relative) => [
	    relative.split(path.sep).join("/"),
	    crypto.createHash("sha256").update(fs.readFileSync(path.join(prefix, relative))).digest("hex"),
	  ]))
	  const canonical = native.subarray(0, 256)
	  canonical.writeBigUInt64LE(128n, 80)
	  canonical.writeUInt32LE(0, 112)
	  canonical.writeUInt32LE(0, 116)
	  files[nativeRelative.split(path.sep).join("/")] = {
	    digest: crypto.createHash("sha256").update(canonical).digest("hex"),
	    size: canonical.length,
	    canonical: "macho_unsigned",
	  }
	  if (process.env.OPENSCIENCE_TEST_CROSS_PACKAGE_SOFTLINK === "1") {
	    const targetRelative = path.join("bin", "locked-link-target")
	    fs.writeFileSync(path.join(prefix, targetRelative), "locked target\\n")
	    files[targetRelative.split(path.sep).join("/")] = crypto
	      .createHash("sha256")
	      .update(fs.readFileSync(path.join(prefix, targetRelative)))
	      .digest("hex")
	    const linkRelative = path.join("compiler_compat", "ld")
	    fs.mkdirSync(path.dirname(path.join(prefix, linkRelative)), { recursive: true })
	    const linkTarget = "../bin/locked-link-target"
	    fs.symlinkSync(linkTarget, path.join(prefix, linkRelative))
	    files[linkRelative.split(path.sep).join("/")] = {
	      kind: "symlink",
	      // Conda softlink metadata can describe the target used when the
	      // source package was built rather than the target selected by this
	      // exact multi-package lock.
	      digest: "0".repeat(64),
	      linkTarget,
	    }
	  }
	  fs.writeFileSync(process.env.OPENSCIENCE_TEST_TRUSTED_OWNERSHIP, JSON.stringify({ version: 1, files, scripts: [] }))
	}
`,
  )
  env.OPENSCIENCE_TEST_MICROMAMBA_SHA256 = crypto
    .createHash("sha256")
    .update(Buffer.from(await Bun.file(micromamba).arrayBuffer()))
    .digest("hex")
  await executable(
    path.join(conda, "envs", "python", "bin", "python"),
    `#!/bin/sh\necho probe >> "${pythonLog}"\necho '{"ok":true}'\n`,
  )
  return {
    root,
    data,
    conda,
    pythonLog,
    rLog,
    prefixLog,
    argsLog,
    lockLog,
    trustedOwnership,
    attestationLog,
    startupMarker,
    env,
    async dispose() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

type Mode =
  | "runtime"
  | "bootstrap"
  | "task"
  | "doctor"
  | "partial"
  | "compile"
  | "concurrent"
  | "sequential"
  | "status-twice"
  | "approval-dispatch"
  | "invalid-lock"

async function invoke(mode: Mode, env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn([process.execPath, fixture, mode], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exit }
}

async function run(mode: Mode, env: NodeJS.ProcessEnv) {
  const result = await invoke(mode, env)
  expect(result.stderr).toBe("")
  expect(result.exit).toBe(0)
  return result.stdout
}

async function taskProbeCount(file: string) {
  const value = await Bun.file(file)
    .text()
    .catch(() => "")
  return value.split("\n").filter((line) => line === "task-probe").length
}

async function approvalDispatch(current: Awaited<ReturnType<typeof profile>>, label: string) {
  const planned = path.join(current.root, `${label}.planned`)
  const approved = path.join(current.root, `${label}.approved`)
  const project = path.join(current.root, `${label}.project`)
  const proc = Bun.spawn([process.execPath, fixture, "approval-dispatch"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: {
      ...current.env,
      OPENSCIENCE_TEST_APPROVAL_PLANNED: planned,
      OPENSCIENCE_TEST_APPROVAL_GRANTED: approved,
      OPENSCIENCE_TEST_APPROVAL_PROJECT: project,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  for (let attempt = 0; attempt < 1_000 && !(await Bun.file(planned).exists()); attempt++) {
    if (proc.exitCode !== null) break
    await Bun.sleep(10)
  }
  if (!(await Bun.file(planned).exists())) {
    proc.kill()
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    throw new Error(`Approval fixture exited ${exit} before planning: ${stderr || stdout}`)
  }
  return {
    approve: () => fs.writeFile(approved, "approved", { mode: 0o600 }),
    async result() {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exit }
    },
  }
}

test("Python runtime neither provisions R nor re-probes a ready starter", async () => {
  const current = await profile()
  try {
    expect(await run("runtime", current.env)).toContain("runtime-ok")
    expect((await Bun.file(current.pythonLog).text()).trim().split("\n")).toHaveLength(1)
    expect(await Bun.file(current.rLog).exists()).toBe(false)
    expect(await Bun.file(current.prefixLog).exists()).toBe(false)
  } finally {
    await current.dispose()
  }
})

test("starter repair solves directly at the durable Conda prefix", async () => {
  const current = await profile()
  try {
    await executable(path.join(current.conda, "envs", "r", "bin", "Rscript"), "#!/bin/sh\nexit 1\n")
    expect(await run("bootstrap", current.env)).toContain("bootstrap-ok")
    expect((await Bun.file(current.prefixLog).text()).trim()).toBe(
      await fs.realpath(path.join(current.conda, "envs", "r")),
    )
    const r = Bun.spawn([path.join(current.conda, "envs", "r", "bin", "Rscript"), "-e", "cat('ok')"], {
      env: current.env,
    })
    expect(await r.exited).toBe(0)
    expect(await fs.readdir(path.join(current.conda, ".rollback"))).toEqual([])
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())(
  "task provisioning uses only the selected @EXPLICIT lock and records its SHA",
  async () => {
    const current = await profile()
    try {
      const inspected = JSON.parse((await run("task", current.env)).trim()) as {
        ready: boolean
        manifest: { spec: string; conda_lock_sha256: string }
      }
      const selected = capabilityCondaPlatform()!
      const target = await fs.realpath(path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id))
      const args = JSON.parse((await Bun.file(current.argsLog).text()).trim()) as string[]
      expect(args.slice(0, 5)).toEqual(["--no-rc", "create", "-y", "-p", target])
      expect(args[5]).toBe("--file")
      expect(args).not.toContain("-c")
      expect(args).not.toContain("python=3.12.11")
      expect(args).not.toContain("pip=25.1.1")
      expect(await Bun.file(current.lockLog).text()).toBe(CORE_SCIENCE_CONDA_LOCKS[selected])
      expect(await Bun.file(args[6]!).exists()).toBe(false)
      expect(inspected.ready).toBe(true)
      expect(inspected.manifest.spec).toBe(CORE_SCIENCE_RUNTIME.lock_digest)
      expect(inspected.manifest.conda_lock_sha256).toBe(CORE_SCIENCE_RUNTIME.local_locks[capabilityPlatform()!])
    } finally {
      await current.dispose()
    }
  },
)

async function readyProfile() {
  const current = await profile()
  await run("task", current.env)
  return current
}

async function expectFailClosed(current: Awaited<ReturnType<typeof profile>>) {
  const probes = await taskProbeCount(current.pythonLog)
  const doctor = JSON.parse((await run("doctor", current.env)).trim()) as { local: { state: string } }
  expect(doctor.local.state).toBe("setup_needed")
  expect(await taskProbeCount(current.pythonLog)).toBe(probes)
  const compiled = await invoke("compile", current.env)
  expect(compiled.exit).not.toBe(0)
  expect(compiled.stderr).toContain("not installed at the manifest lock")
  expect(await taskProbeCount(current.pythonLog)).toBe(probes)
  expect(await Bun.file(current.startupMarker).exists()).toBe(false)
}

test.skipIf(!capabilityPlatform())("attests the Conda prefix before isolated pip or Python startup", async () => {
  const current = await profile()
  try {
    current.env.PYTHONPATH = path.join(current.root, "hostile-python-path")
    current.env.PYTHONHOME = path.join(current.root, "hostile-python-home")
    await run("task", current.env)
    const order = (await Bun.file(current.attestationLog).text()).trim().split("\n")
    expect(order[0]).toBe("closure")
    expect(order).toContain("python")
    expect(await Bun.file(current.startupMarker).exists()).toBe(false)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())(
  "accepts an exact cross-package softlink when its build-time target digest differs",
  async () => {
    const current = await profile()
    try {
      current.env.OPENSCIENCE_TEST_CROSS_PACKAGE_SOFTLINK = "1"
      const inspected = JSON.parse((await run("task", current.env)).trim()) as { ready: boolean }
      expect(inspected.ready).toBe(true)
    } finally {
      await current.dispose()
    }
  },
)

test.skipIf(!capabilityPlatform())("rejects an unowned .pth planted before the first Python invocation", async () => {
  const current = await profile()
  try {
    current.env.OPENSCIENCE_TEST_INJECT_UNOWNED_PTH = "1"
    const result = await invoke("task", current.env)
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain("failed Conda-only archive attestation before Python startup")
    expect(await Bun.file(current.pythonLog).exists()).toBe(false)
    expect(await Bun.file(current.startupMarker).exists()).toBe(false)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())("rejects standalone deterministic manifest tampering", async () => {
  const current = await readyProfile()
  try {
    const file = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id, ".openscience-environment.json")
    const manifest = await Bun.file(file).json()
    await Bun.write(file, JSON.stringify({ ...manifest, verified_at: new Date().toISOString() }))
    await expectFailClosed(current)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())("rejects standalone wheel RECORD tampering", async () => {
  const current = await readyProfile()
  try {
    const file = path.join(
      current.conda,
      "envs",
      CORE_SCIENCE_RUNTIME.pack_id,
      "lib",
      "python3.12",
      "site-packages",
      "fake-1.dist-info",
      "RECORD",
    )
    await Bun.write(file, "forged.py,,\n")
    await expectFailClosed(current)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())("rejects standalone conda-meta recreation or tampering", async () => {
  const current = await readyProfile()
  try {
    const file = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id, "conda-meta", "forged.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ sha256: "0".repeat(64) }))
    await expectFailClosed(current)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())(
  "rejects semantic Mach-O linkedit and signature-offset tampering",
  async () => {
    const current = await readyProfile()
    try {
      const file = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id, "lib", "fake-native.dylib")
      const original = Buffer.from(await Bun.file(file).arrayBuffer())
      const mutations = [
        (value: Buffer) => value.writeBigUInt64LE(32_768n, 64),
        (value: Buffer) => value.writeBigUInt64LE(145n, 80),
        (value: Buffer) => value.writeUInt32LE(255, 112),
      ]
      for (const mutate of mutations) {
        const value = Buffer.from(original)
        mutate(value)
        await Bun.write(file, value)
        await expectFailClosed(current)
        await Bun.write(file, original)
      }
    } finally {
      await current.dispose()
    }
  },
  30_000,
)

test.skipIf(!capabilityPlatform())("ignores forged metadata and rejects owned-byte tampering", async () => {
  const current = await readyProfile()
  try {
    const environment = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id)
    await Bun.write(path.join(environment, "lib", "fake-module.py"), "tampered\n")
    const record = path.join(environment, "lib", "python3.12", "site-packages", "fake-1.dist-info", "RECORD")
    await Bun.write(record, "lib/fake-module.py,sha256=forged,9\n")
    const metadata = path.join(environment, "conda-meta", "forged.json")
    await fs.mkdir(path.dirname(metadata), { recursive: true })
    await Bun.write(metadata, JSON.stringify({ paths_data: {} }))
    await expectFailClosed(current)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())(
  "rejects unowned startup files, scripts, native libraries, and symlink escapes",
  async () => {
    const current = await readyProfile()
    try {
      const environment = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id)
      const site = path.join(environment, "lib", "python3.12", "site-packages")
      for (const relative of ["inject.pth", "sitecustomize.py", "native.so"]) {
        const file = path.join(site, relative)
        await Bun.write(file, "import os\n")
        await expectFailClosed(current)
        await fs.rm(file)
      }
      const script = path.join(environment, "bin", "injected-command")
      await Bun.write(script, "#!/bin/sh\nexit 0\n")
      await expectFailClosed(current)
      await fs.rm(script)

      const module = path.join(environment, "lib", "fake-module.py")
      const outside = path.join(current.root, "outside-module.py")
      await Bun.write(outside, "locked\n")
      await fs.rm(module)
      await fs.symlink(outside, module)
      await expectFailClosed(current)
    } finally {
      await current.dispose()
    }
  },
  30_000,
)

test.skipIf(!capabilityPlatform())("fails closed when trusted archive-derived ownership is unavailable", async () => {
  const current = await readyProfile()
  try {
    await Bun.write(current.trustedOwnership, "{}")
    await expectFailClosed(current)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())("test environment variables alone cannot activate integrity bypasses", async () => {
  const current = await readyProfile()
  try {
    current.env.OPENSCIENCE_TEST_DISABLE_MANAGED_ENVIRONMENT_SUPPORT = "1"
    const probes = await taskProbeCount(current.pythonLog)
    const doctor = JSON.parse((await run("doctor", current.env)).trim()) as { local: { state: string } }
    expect(doctor.local.state).toBe("setup_needed")
    expect(await taskProbeCount(current.pythonLog)).toBe(probes)
    expect(await Bun.file(current.startupMarker).exists()).toBe(false)
  } finally {
    await current.dispose()
  }
})

test.skipIf(!capabilityPlatform())(
  "partial exact expectations fail closed without semantic Python fallback",
  async () => {
    const current = await readyProfile()
    try {
      const site = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id, "lib", "python3.12", "site-packages")
      await Bun.write(path.join(site, "inject.pth"), "import os\n")
      const probes = await taskProbeCount(current.pythonLog)
      const inspected = JSON.parse((await run("partial", current.env)).trim()) as { ready: boolean }
      expect(inspected.ready).toBe(false)
      expect(await taskProbeCount(current.pythonLog)).toBe(probes)
      expect(await Bun.file(current.startupMarker).exists()).toBe(false)
    } finally {
      await current.dispose()
    }
  },
)

test.skipIf(!capabilityPlatform())(
  "deduplicates only in-flight full scans and never caches execution attestation",
  async () => {
    const current = await readyProfile()
    try {
      expect(JSON.parse((await run("concurrent", current.env)).trim())).toEqual(["closure", "python"])
      expect(JSON.parse((await run("sequential", current.env)).trim())).toEqual([
        "closure",
        "python",
        "closure",
        "python",
      ])
      expect(JSON.parse((await run("status-twice", current.env)).trim())).toEqual([])
    } finally {
      await current.dispose()
    }
  },
)

test.skipIf(!capabilityPlatform() || !Sandbox.available())(
  "re-attests the archive-derived runtime after approval and immediately before local spawn",
  async () => {
    const current = await readyProfile()
    try {
      const environment = path.join(current.conda, "envs", CORE_SCIENCE_RUNTIME.pack_id)
      const owned = path.join(environment, "lib", "fake-module.py")
      const startup = path.join(environment, "lib", "python3.12", "site-packages", "inject.pth")

      const tampered = await approvalDispatch(current, "tampered-approval")
      const probesAfterPlan = await taskProbeCount(current.pythonLog)
      await Bun.write(owned, "tampered\n")
      await Bun.write(startup, "import os\n")
      await tampered.approve()
      const rejected = await tampered.result()
      expect(rejected.exit).toBe(0)
      const rejection = JSON.parse(rejected.stdout) as { outcome: string; error: string; marker: boolean }
      expect(rejection).toMatchObject({ outcome: "rejected", marker: false })
      expect(rejection.error).toContain("not installed at the manifest lock")
      expect(await taskProbeCount(current.pythonLog)).toBe(probesAfterPlan)
      expect(await Bun.file(current.startupMarker).exists()).toBe(false)

      await Bun.write(owned, "locked\n")
      await fs.rm(startup)
      const unchanged = await approvalDispatch(current, "unchanged-approval")
      await unchanged.approve()
      const completed = await unchanged.result()
      expect(completed.exit).toBe(0)
      expect(JSON.parse(completed.stdout)).toMatchObject({
        outcome: "completed",
        status: "succeeded",
        marker: true,
      })
    } finally {
      await current.dispose()
    }
  },
  30_000,
)

test("rejects malformed or cross-platform explicit locks before invoking micromamba", async () => {
  const current = await profile()
  try {
    const result = await invoke("invalid-lock", current.env)
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain("may only use osx-arm64 or noarch packages")
    expect(await Bun.file(current.argsLog).exists()).toBe(false)
    expect(await Bun.file(current.prefixLog).exists()).toBe(false)
  } finally {
    await current.dispose()
  }
})
