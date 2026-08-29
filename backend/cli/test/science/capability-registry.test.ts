import { describe, expect, test } from "bun:test"
import {
  CORE_SCIENCE_CONDA_LOCKS,
  capabilityLockDigest,
  condaLockSha256,
} from "../../src/science/capability/conda-locks"
import {
  CORE_SCIENCE_LOCAL_LOCKS,
  CORE_SCIENCE_REQUIREMENTS,
  CORE_SCIENCE_RUNTIME,
  capabilityPlatform,
  coreScienceCondaLocks,
} from "../../src/science/capability/pack"
import { CapabilityRegistry } from "../../src/science/capability/registry"
import { CapabilityRuntime, CapabilityWorkload } from "../../src/science/capability/schema"

describe("scientific capability registry", () => {
  test("exposes the honest 54-entry maturity and availability inventory", () => {
    const items = CapabilityRegistry.list()
    expect(items).toHaveLength(54)
    expect(items.every((item) => item.maturity === "experimental" || item.maturity === "blocked")).toBe(true)
    expect(items.find((item) => item.id === "scipy")).toMatchObject({
      maturity: "experimental",
      availability: { local: "setup_needed", hosted: "setup_needed" },
    })
    expect(items.find((item) => item.id === "boltz2")).toMatchObject({
      maturity: "experimental",
      availability: { local: "unavailable", hosted: "setup_needed" },
    })
    expect(items.find((item) => item.id === "paper-qa")).toMatchObject({
      maturity: "experimental",
      availability: { local: "setup_needed", hosted: "unavailable" },
    })
    expect(items.find((item) => item.id === "alphafold2")).toMatchObject({
      maturity: "blocked",
      availability: { local: "unavailable", hosted: "unavailable" },
    })
    expect(items.find((item) => item.id === "openfold3")).toMatchObject({
      maturity: "experimental",
      availability: { local: "unavailable", hosted: "setup_needed" },
    })
    expect(items.filter((item) => item.maturity === "experimental")).toHaveLength(52)
    expect(items.filter((item) => item.maturity === "blocked")).toHaveLength(2)
  })

  test("owns one immutable exact runtime graph for the five packaged capabilities", () => {
    expect(CORE_SCIENCE_RUNTIME.packages).toHaveLength(18)
    expect(CORE_SCIENCE_RUNTIME.packages).toContain("scipy==1.18.1")
    expect(CORE_SCIENCE_RUNTIME.packages).toContain("matplotlib==3.11.1")
    expect(CORE_SCIENCE_RUNTIME.packages).toContain("scikit-learn==1.9.0")
    expect(CORE_SCIENCE_RUNTIME.packages).toContain("biopython==1.88")
    expect(CORE_SCIENCE_RUNTIME.packages).toContain("rdkit==2026.3.5")
    expect(CORE_SCIENCE_RUNTIME.packages.every((item) => /^[A-Za-z0-9_.-]+==[^=<>!~\s]+$/.test(item))).toBe(true)
    expect(CORE_SCIENCE_RUNTIME.image).toMatch(/@sha256:[a-f0-9]{64}$/)
    expect(CORE_SCIENCE_RUNTIME.lock_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(CORE_SCIENCE_RUNTIME.local_platforms).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"])
    expect(CORE_SCIENCE_RUNTIME.local_locks).toEqual(CORE_SCIENCE_LOCAL_LOCKS)
    expect(CORE_SCIENCE_RUNTIME.network).toEqual({ build: "package_index_only", execution: "none" })
    expect(CORE_SCIENCE_REQUIREMENTS.trim().split("\n")).toHaveLength(18)
    expect(
      CORE_SCIENCE_REQUIREMENTS.trim()
        .split("\n")
        .every((line) => line.includes("--hash=sha256:")),
    ).toBe(true)
    expect(CORE_SCIENCE_RUNTIME.lock_digest).toBe(
      capabilityLockDigest({
        channels: ["conda-forge"],
        packages: ["python=3.12.11", "pip=25.1.1"],
        conda_locks: CORE_SCIENCE_CONDA_LOCKS,
        pip_packages: CORE_SCIENCE_RUNTIME.packages,
        pip_requirements: CORE_SCIENCE_REQUIREMENTS,
      }),
    )
    for (const id of ["scipy", "matplotlib", "scikit-learn", "biopython", "rdkit"]) {
      expect(CapabilityRegistry.describe(id)?.runtime).toEqual(CORE_SCIENCE_RUNTIME)
    }
  })

  test("publishes only exact per-platform lock SHAs and keeps strict Conda URLs internal", () => {
    const locks = coreScienceCondaLocks()
    expect(Object.keys(locks).toSorted()).toEqual(["linux-64", "linux-aarch64", "osx-arm64"])
    const platforms = {
      "osx-arm64": "darwin-arm64",
      "linux-aarch64": "linux-arm64",
      "linux-64": "linux-x64",
    } as const
    for (const [platform, lock] of Object.entries(locks)) {
      const lines = lock.split("\n")
      expect(lines[0]).toBe("@EXPLICIT")
      expect(lines.length).toBeGreaterThan(2)
      for (const line of lines.slice(1)) {
        expect(line).toMatch(
          /^https:\/\/conda\.anaconda\.org\/conda-forge\/(?:osx-arm64|linux-aarch64|linux-64|noarch)\/[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\.conda|\.tar\.bz2)#sha256=[a-f0-9]{64}$/,
        )
        expect([platform, "noarch"]).toContain(new URL(line).pathname.split("/")[2])
      }
      expect(CORE_SCIENCE_RUNTIME.local_locks[platforms[platform as keyof typeof platforms]]).toBe(
        condaLockSha256(lock),
      )
    }
    expect(JSON.stringify(CapabilityRegistry.describe("scipy"))).not.toContain("conda.anaconda.org")
    expect(
      CapabilityRuntime.safeParse({
        ...CORE_SCIENCE_RUNTIME,
        local_locks: { "darwin-arm64": CORE_SCIENCE_LOCAL_LOCKS["darwin-arm64"] },
      }).success,
    ).toBe(false)
  })

  test("rejects old macOS, musl, and glibc older than 2.28", () => {
    expect(capabilityPlatform({ platform: "darwin", arch: "arm64", release: "20.6.0" })).toBeUndefined()
    expect(capabilityPlatform({ platform: "darwin", arch: "arm64", release: "21.0.0" })).toBe("darwin-arm64")
    expect(capabilityPlatform({ platform: "linux", arch: "x64", glibc: undefined })).toBeUndefined()
    expect(capabilityPlatform({ platform: "linux", arch: "x64", glibc: "2.27" })).toBeUndefined()
    expect(capabilityPlatform({ platform: "linux", arch: "x64", glibc: "2.28" })).toBe("linux-x64")
    expect(capabilityPlatform({ platform: "linux", arch: "arm64", glibc: "2.39" })).toBe("linux-arm64")
  })

  test("compiles a bounded zero-default-upload Modal plan without caller environment overrides", async () => {
    const result = await CapabilityRegistry.compileTask("scipy", {
      name: "Fit model",
      purpose: "Fit and validate the requested model.",
      command: "python analysis.py",
      target: "modal",
      artifacts: ["results.json"],
    })
    expect(result.tool).toBe("compute_job")
    expect(result.binding).toMatchObject({ id: "scipy", version: "2.0.0", profile: "task" })
    expect(result.execution).toMatchObject({
      network: "none",
      lock_digest: CORE_SCIENCE_RUNTIME.lock_digest,
      pip_requirements: CORE_SCIENCE_REQUIREMENTS.trimEnd(),
      runtime_binary: undefined,
      runtime_root: undefined,
    })
    expect(result.input).toMatchObject({
      action: "plan",
      target: { kind: "modal" },
      packages: CORE_SCIENCE_RUNTIME.packages,
      image: CORE_SCIENCE_RUNTIME.image,
      gpu: "none",
      uploads: [],
    })
    expect(result.input.resources).toMatchObject({ cpus: 1, memory_gb: 2, time_minutes: 10, gpus: 0 })
    expect(
      CapabilityWorkload.safeParse({
        name: "Override",
        purpose: "Attempt to replace the environment.",
        command: "python analysis.py",
        target: "modal",
        packages: ["numpy==0.0.1"],
      }).success,
    ).toBe(false)
  })

  test("compiles canonical zero-input smokes and enforces resource ceilings", async () => {
    const smoke = await CapabilityRegistry.compileSmoke("rdkit", "modal", "scientific-capabilities/rdkit/test")
    expect(smoke.binding.profile).toBe("smoke")
    expect(smoke.execution.network).toBe("none")
    expect(smoke.input.uploads).toEqual([])
    expect(smoke.input.artifacts).toContain("capability-result.json")
    expect(smoke.input.command).toContain("base64")
    await expect(
      CapabilityRegistry.compileTask("scipy", {
        name: "Too large",
        purpose: "Exceed the reviewed resource envelope.",
        command: "python analysis.py",
        target: "modal",
        resources: { cpus: 2 },
      }),
    ).rejects.toThrow("capped at 1 CPU")
  })

  test("keeps hosted BioNeMo and AlphaFold2 claims truthful", () => {
    expect(CapabilityRegistry.describe("diffdock")).toMatchObject({
      maturity: "experimental",
      availability: { local: "unavailable", hosted: "setup_needed" },
      hosted: { kind: "nvidia_nim", adapter_id: "diffdock" },
    })
    expect(CapabilityRegistry.describe("openfold3")).toMatchObject({
      maturity: "experimental",
      availability: { local: "unavailable", hosted: "setup_needed" },
      hosted: { kind: "nvidia_nim", adapter_id: "openfold3" },
      basis: expect.stringContaining("pending validation"),
    })
    expect(CapabilityRegistry.describe("alphafold2")).toMatchObject({
      maturity: "blocked",
      blocker: expect.stringContaining("weights"),
    })
    expect(CapabilityRegistry.describe("not-real")).toBeUndefined()
  })
})
