import crypto from "node:crypto"
import { JobBroker } from "@/compute/job-broker"
import { ManagedEnvironments } from "@/science/kernel/environment-manager"
import { capabilityManifests } from "./manifests"
import {
  CapabilityManifest,
  CapabilityWorkload,
  type CapabilityAvailability,
  type CapabilityMaturity,
  type CapabilityRuntime,
} from "./schema"
import { capabilitySmokeScript } from "./smokes"
import { condaLockSha256 } from "./conda-locks"
import { capabilityCondaPlatform, capabilityPlatform, coreScienceCondaLocks } from "./pack"

export type CapabilityBinding = JobBroker.CapabilityBinding
export type CapabilitySummary = {
  id: string
  name: string
  category: string
  maturity: CapabilityMaturity
  availability: CapabilityAvailability
}
const catalog = new Map<string, CapabilityManifest>(
  Object.values(capabilityManifests).map((item) => [item.id, CapabilityManifest.parse(item)]),
)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
const digest = (value: unknown) => crypto.createHash("sha256").update(canonical(value)).digest("hex")
const digestText = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
const same = (left: readonly string[] | undefined, right: readonly string[]) =>
  JSON.stringify([...(left ?? [])].toSorted()) === JSON.stringify([...right].toSorted())
const summary = (item: CapabilityManifest): CapabilitySummary => ({
  id: item.id,
  name: item.name,
  category: item.category,
  maturity: item.maturity,
  availability: item.availability,
})
function runnable(item: CapabilityManifest): asserts item is CapabilityManifest & {
  runtime: CapabilityRuntime
  smoke: NonNullable<CapabilityManifest["smoke"]>
} {
  if (item.maturity === "blocked") throw new Error(item.blocker ?? `${item.name} is blocked`)
  if (!item.runtime || !item.smoke)
    throw new Error(item.setup?.instructions ?? `${item.name} has no release-packaged executable runtime`)
}
function bounded(runtime: CapabilityRuntime, requested?: { cpus?: number; memory_gb?: number; time_minutes?: number }) {
  const cpus = requested?.cpus ?? runtime.resources.cpus,
    memory = requested?.memory_gb ?? runtime.resources.memory_gb,
    time = requested?.time_minutes ?? runtime.resources.time_minutes
  if (cpus > runtime.resources.cpus) throw new Error(`${runtime.pack_id} is capped at ${runtime.resources.cpus} CPU`)
  if (memory > runtime.resources.memory_gb)
    throw new Error(`${runtime.pack_id} is capped at ${runtime.resources.memory_gb} GiB RAM`)
  if (time > runtime.resources.time_minutes)
    throw new Error(`${runtime.pack_id} is capped at ${runtime.resources.time_minutes} minutes`)
  return { cpus, memory_gb: memory, time_minutes: time, gpus: 0 }
}
async function environment(runtime: CapabilityRuntime) {
  const current = capabilityPlatform()
  const conda = capabilityCondaPlatform()
  const exact = conda ? coreScienceCondaLocks()[conda] : undefined
  const lock = current ? runtime.local_locks[current] : undefined
  if (!current || !exact || !runtime.local_platforms.includes(current) || lock !== condaLockSha256(exact))
    throw new Error(
      `${runtime.pack_id} has no release-locked local wheel set for ${current ?? `${process.platform}-${process.arch}`}`,
    )
  const state = await ManagedEnvironments.inspect(runtime.pack_id, {
    conda_lock: exact,
    lock_digest: runtime.lock_digest,
    pip_packages: runtime.packages,
    pip_requirements: runtime.pip_requirements,
    python: runtime.python,
  })
  if (
    !state.ready ||
    !state.manifest ||
    state.manifest.spec !== runtime.lock_digest ||
    state.manifest.conda_lock_sha256 !== lock ||
    !same(state.manifest.packages, [`python=${runtime.python}`, "pip=25.1.1"]) ||
    !same(state.manifest.pip_packages, runtime.packages)
  )
    throw new Error(`${runtime.pack_id} is not installed at the manifest lock. Run scientific_capability setup first.`)
  return ManagedEnvironments.runtime("python", runtime.pack_id)
}

function execution(
  runtime: CapabilityRuntime,
  local?: Awaited<ReturnType<typeof ManagedEnvironments.runtime>>,
): JobBroker.CapabilityExecution {
  if (local && (!local.binary || !local.env?.CONDA_PREFIX)) {
    throw new Error("Managed capability environment did not expose its trusted binary and root")
  }
  return JobBroker.CapabilityExecution.parse({
    network: runtime.network.execution,
    lock_digest: runtime.lock_digest,
    pip_requirements: runtime.pip_requirements,
    runtime_binary: local?.binary,
    runtime_root: local?.env?.CONDA_PREFIX,
  })
}
function activate(command: string, runtime: Awaited<ReturnType<typeof ManagedEnvironments.runtime>>) {
  if (!runtime.env?.CONDA_PREFIX || !runtime.env.PATH)
    throw new Error("Managed capability environment did not expose runtime paths")
  if (process.platform === "win32")
    return `set "CONDA_PREFIX=${runtime.env.CONDA_PREFIX}"\r\nset "PATH=${runtime.env.PATH}"\r\n${command}`
  return `export CONDA_PREFIX=${quote(runtime.env.CONDA_PREFIX)}\nexport PATH=${quote(runtime.env.PATH)}\n${command}`
}
export namespace CapabilityRegistry {
  export function register(values: Iterable<CapabilityManifest>) {
    for (const value of values) {
      const item = CapabilityManifest.parse(value)
      if (catalog.has(item.id)) throw new Error(`Scientific capability '${item.id}' is already registered`)
      catalog.set(item.id, item)
    }
  }
  export function list() {
    return [...catalog.values()].map(summary).toSorted((a, b) => a.name.localeCompare(b.name))
  }
  export function listDetailed() {
    return [...catalog.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  }
  export function describe(id: string) {
    const item = catalog.get(id)
    return item ? CapabilityManifest.parse(item) : undefined
  }
  export function binding(input: { manifest: CapabilityManifest; profile: "task" | "smoke" }): CapabilityBinding {
    if (!input.manifest.runtime) throw new Error(`${input.manifest.name} has no packaged runtime binding`)
    return JobBroker.CapabilityBinding.parse({
      id: input.manifest.id,
      version: input.manifest.version,
      manifest_sha256: digest(input.manifest),
      profile: input.profile,
      runtime_digest: digest(input.manifest.runtime),
    })
  }
  export async function reattest(expectedBinding: CapabilityBinding, expectedExecution: JobBroker.CapabilityExecution) {
    const item = describe(expectedBinding.id)
    if (!item) throw new Error(`Scientific capability '${expectedBinding.id}' is no longer registered`)
    runnable(item)
    const currentBinding = binding({ manifest: item, profile: expectedBinding.profile })
    if (canonical(currentBinding) !== canonical(expectedBinding)) {
      throw new Error(`Scientific capability '${expectedBinding.id}' binding changed before dispatch`)
    }
    if (expectedExecution.lock_digest !== item.runtime.lock_digest) {
      throw new Error(`Scientific capability '${expectedBinding.id}' runtime lock changed before dispatch`)
    }
    const local = await environment(item.runtime)
    const currentExecution = execution(item.runtime, local)
    if (canonical(currentExecution) !== canonical(expectedExecution)) {
      throw new Error(`Scientific capability '${expectedBinding.id}' execution root changed before dispatch`)
    }
    return { binding: currentBinding, execution: currentExecution }
  }
  export async function compileTask(id: string, raw: CapabilityWorkload) {
    const item = describe(id)
    if (!item) throw new Error(`Unknown scientific capability: ${id}`)
    runnable(item)
    const work = CapabilityWorkload.parse(raw)
    if (!item.runtime.targets.includes(work.target))
      throw new Error(`${item.name} supports ${item.runtime.targets.join(" and ")}, not ${work.target}`)
    const capability = binding({ manifest: item, profile: "task" })
    const local = work.target === "local" ? await environment(item.runtime) : undefined
    const command = local ? activate(work.command, local) : work.command
    const input = JobBroker.Input.parse({
      name: work.name,
      purpose:
        `${work.purpose} [capability:${capability.id}@${capability.version}:task:${capability.manifest_sha256.slice(0, 12)}]`.slice(
          0,
          500,
        ),
      command,
      cwd: work.cwd,
      target: { kind: work.target },
      resources: bounded(item.runtime, work.resources),
      artifacts: work.artifacts,
      uploads: work.uploads ?? [],
      packages: work.target === "modal" ? item.runtime.packages : undefined,
      image: work.target === "modal" ? item.runtime.image : undefined,
      gpu: work.target === "modal" ? "none" : undefined,
    })
    return {
      tool: "compute_job" as const,
      capability: summary(item),
      binding: capability,
      execution: execution(item.runtime, local),
      input: { action: "plan" as const, ...input },
    }
  }
  export async function compileSmoke(id: string, target: "local" | "modal", cwd: string) {
    const item = describe(id)
    if (!item) throw new Error(`Unknown scientific capability: ${id}`)
    runnable(item)
    if (!item.runtime.targets.includes(target)) throw new Error(`${item.name} does not support ${target}`)
    const script = capabilitySmokeScript(item.id)
    if (digestText(script) !== item.smoke.script_digest)
      throw new Error(`${item.name} smoke source no longer matches its manifest`)
    const encoded = Buffer.from(script).toString("base64"),
      capability = binding({ manifest: item, profile: "smoke" })
    const code = `import base64;exec(compile(base64.b64decode(${JSON.stringify(encoded)}), ${JSON.stringify(`${item.id}-smoke.py`)}, 'exec'))`
    let command = `python -I -c ${quote(code)}`
    const local = target === "local" ? await environment(item.runtime) : undefined
    if (local) command = activate(command, local)
    const input = JobBroker.Input.parse({
      name: `${item.name} bounded smoke`,
      purpose: `${item.smoke.summary} [capability:${capability.id}@${capability.version}:smoke:${capability.manifest_sha256.slice(0, 12)}]`,
      command,
      cwd,
      target: { kind: target },
      resources: bounded(item.runtime, {
        cpus: 1,
        memory_gb: Math.min(2, item.runtime.resources.memory_gb),
        time_minutes: Math.min(5, item.runtime.resources.time_minutes),
      }),
      artifacts: item.smoke.artifacts,
      uploads: [],
      packages: target === "modal" ? item.runtime.packages : undefined,
      image: target === "modal" ? item.runtime.image : undefined,
      gpu: target === "modal" ? "none" : undefined,
    })
    return {
      tool: "compute_job" as const,
      capability: summary(item),
      binding: capability,
      execution: execution(item.runtime, local),
      input: { action: "plan" as const, ...input },
    }
  }
}
