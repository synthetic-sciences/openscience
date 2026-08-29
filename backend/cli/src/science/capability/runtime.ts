import { ManagedEnvironments } from "@/science/kernel/environment-manager"
import { condaLockSha256 } from "./conda-locks"
import { CapabilityEvidence } from "./evidence"
import { capabilityCondaPlatform, capabilityPlatform, coreScienceCondaLocks } from "./pack"
import type { CapabilityManifest, CapabilityRuntime as Runtime } from "./schema"

const same = (left: readonly string[] | undefined, right: readonly string[]) =>
  JSON.stringify([...(left ?? [])].toSorted()) === JSON.stringify([...right].toSorted())
const localLock = (runtime: Runtime) => {
  const current = capabilityPlatform()
  return current ? runtime.local_locks[current] : undefined
}
const condaLock = () => {
  const current = capabilityCondaPlatform()
  return current ? coreScienceCondaLocks()[current] : undefined
}
const localReady = (runtime: Runtime, state: Awaited<ReturnType<typeof ManagedEnvironments.inspect>>) => {
  const lock = localLock(runtime)
  return Boolean(
    lock &&
      state.ready &&
      state.manifest &&
      state.manifest.spec === runtime.lock_digest &&
      state.manifest.conda_lock_sha256 === lock &&
      same(state.manifest.packages, [`python=${runtime.python}`, "pip=25.1.1"]) &&
      same(state.manifest.pip_packages, runtime.packages),
  )
}
const localSupported = (runtime: Runtime) => {
  const current = capabilityPlatform()
  const lock = condaLock()
  return Boolean(
    current &&
      lock &&
      runtime.local_platforms.includes(current) &&
      runtime.local_locks[current] === condaLockSha256(lock),
  )
}
async function modal(runtime: Runtime) {
  if (!runtime.targets.includes("modal")) return { state: "not_applicable" as const, configured: false, enabled: false }
  const { ComputeSettings } = await import("@/server/routes/settings/compute")
  const provider = (await ComputeSettings.get()).providers.find((item) => item.id === "modal")
  // Stored, enabled credentials establish configuration only. They do not
  // prove token validity, account access, transport, or runtime execution.
  return {
    state: provider?.connected && provider.enabled ? ("configured" as const) : ("setup_needed" as const),
    configured: Boolean(provider?.connected),
    enabled: Boolean(provider?.enabled),
  }
}
async function versions(binary: string, pins: readonly string[]) {
  const names = pins.map((item) => item.slice(0, item.indexOf("==")))
  const code = [
    "import importlib.metadata, json, platform",
    `names = ${JSON.stringify(names)}`,
    "print(json.dumps({'python': platform.python_version(), 'packages': {name: importlib.metadata.version(name) for name in names}}, sort_keys=True))",
  ].join("\n")
  const process = Bun.spawn([binary, "-I", "-c", code], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0) throw new Error((stderr || stdout || `Runtime verification failed with exit ${exit}`).trim())
  return JSON.parse(stdout) as { python: string; packages: Record<string, string> }
}
export namespace CapabilityRuntime {
  export async function doctor(manifest: CapabilityManifest, options: { verification?: "full" | "status" } = {}) {
    const evidence = await CapabilityEvidence.forCapability(manifest.id)
    if (!manifest.runtime)
      return {
        capability: manifest.id,
        maturity: manifest.maturity,
        availability: manifest.availability,
        local: { state: manifest.availability.local },
        hosted: { state: manifest.availability.hosted },
        setup: manifest.setup ?? null,
        blocker: manifest.blocker ?? null,
        evidence,
      }
    const supported = manifest.runtime.targets.includes("local") && localSupported(manifest.runtime)
    const state = supported
        ? await ManagedEnvironments.inspect(
            manifest.runtime.pack_id,
            {
              conda_lock: condaLock(),
              lock_digest: manifest.runtime.lock_digest,
              pip_packages: manifest.runtime.packages,
              pip_requirements: manifest.runtime.pip_requirements,
              python: manifest.runtime.python,
            },
            { verification: options.verification ?? "full" },
          )
        : null,
      ready = Boolean(supported && state && localReady(manifest.runtime, state)),
      hosted = await modal(manifest.runtime)
    const localState = supported
      ? ready
        ? options.verification === "status"
          ? ("configured" as const)
          : ("ready" as const)
        : ("setup_needed" as const)
      : ("unavailable" as const)
    return {
      capability: manifest.id,
      maturity: manifest.maturity,
      availability: {
        local: manifest.runtime.targets.includes("local") ? localState : "not_applicable",
        hosted: hosted.state,
      },
      local: {
        state: localState,
        platform: capabilityPlatform() ?? `${process.platform}-${process.arch}`,
        environment: manifest.runtime.pack_id,
        lock_sha256: localLock(manifest.runtime) ?? null,
        path: state?.path ?? null,
        manifest: state?.manifest ?? null,
        integrity: state?.integrity ?? {
          state: "unavailable",
          verified_at: null,
          verification_required_before_execution: true,
        },
      },
      hosted,
      runtime: {
        python: manifest.runtime.python,
        image: manifest.runtime.image,
        lock_digest: manifest.runtime.lock_digest,
        packages: manifest.runtime.packages,
        resources: manifest.runtime.resources,
      },
      evidence,
    }
  }
  export async function setup(manifest: CapabilityManifest) {
    if (manifest.maturity === "blocked") throw new Error(manifest.blocker ?? `${manifest.name} is blocked`)
    const runtime = manifest.runtime
    if (!runtime?.targets.includes("local"))
      throw new Error(manifest.setup?.instructions ?? `${manifest.name} has no packaged local setup`)
    if (!localSupported(runtime))
      throw new Error(
        `${manifest.name} has no release-locked local wheel set for ${capabilityPlatform() ?? `${process.platform}-${process.arch}`}; use its hosted target`,
      )
    const platform = capabilityPlatform()!
    const conda = capabilityCondaPlatform()!
    const locks = coreScienceCondaLocks()
    if (condaLockSha256(locks[conda]) !== runtime.local_locks[platform]) {
      throw new Error(`${runtime.pack_id} exact Conda lock does not match its public ${platform} lock SHA`)
    }
    await ManagedEnvironments.ensureTask(runtime.pack_id, {
      channels: ["conda-forge"],
      packages: [`python=${runtime.python}`, "pip=25.1.1"],
      conda_locks: locks,
      pip_packages: [...runtime.packages],
      pip_requirements: runtime.pip_requirements,
      lock_digest: runtime.lock_digest,
    })
    const environment = await ManagedEnvironments.runtime("python", runtime.pack_id)
    if (!environment.binary) throw new Error(`${runtime.pack_id} did not expose Python after setup`)
    const installed = await versions(environment.binary, runtime.packages)
    if (installed.python !== runtime.python)
      throw new Error(`${runtime.pack_id} installed Python ${installed.python}, expected ${runtime.python}`)
    for (const pin of runtime.packages) {
      const offset = pin.indexOf("=="),
        name = pin.slice(0, offset),
        expected = pin.slice(offset + 2)
      if (installed.packages[name] !== expected)
        throw new Error(`${runtime.pack_id} installed ${name}==${installed.packages[name]}, expected ${pin}`)
    }
    return {
      capability: manifest.id,
      state: "ready" as const,
      environment: runtime.pack_id,
      python: installed.python,
      packages: installed.packages,
      lock_digest: runtime.lock_digest,
      conda_lock_sha256: runtime.local_locks[platform],
    }
  }
}
