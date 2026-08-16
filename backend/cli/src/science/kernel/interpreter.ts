import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import z from "zod"
import type { KernelStartOptions } from "./types"
import { Environment } from "@/package/environment"
import { Instance } from "@/project/instance"

export const KernelEnvironmentName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use a simple environment name without path separators")

/**
 * The one place "default" is resolved, so every caller agrees on which
 * directory a name means.
 *
 * `language` exists because the answer differs by language and getting it wrong
 * is silent: `package_install` took `params.environment` raw, so its schema
 * default of "default" provisioned `envs/<project>/default`, while a kernel
 * called with no environment normalised to "python" and looked in
 * `envs/<project>/python`. The install reported success, the manifest was
 * written, and the very next `import` failed — with both sides behaving exactly
 * as documented. R needs "r" for the same reason.
 */
export function normalizeKernelEnvironmentName(input?: string, language: "python" | "r" = "python") {
  const value = KernelEnvironmentName.parse(input ?? language)
  return value.toLowerCase() === "default" ? language : value
}

export class KernelEnvironmentUnavailable extends Error {
  constructor(
    readonly environmentName: string,
    readonly candidates: string[],
  ) {
    super(
      `Python environment '${environmentName}' was not found. Expected an interpreter at ${candidates.join(" or ")}. ` +
        "Omit environment (or use 'default') for the host/conventional .venv runtime. " +
        "Named venv or Conda-prefix environments belong at .venv/<name>.",
    )
    this.name = "KernelEnvironmentUnavailable"
  }
}

const layout = (root: string) =>
  process.platform === "win32"
    ? { binary: path.join(root, "Scripts", "python.exe"), bin: path.join(root, "Scripts") }
    : { binary: path.join(root, "bin", "python"), bin: path.join(root, "bin") }

async function executable(file: string) {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat?.isFile()) return false
  return fs.access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(
    () => true,
    () => false,
  )
}

/**
 * Resolve a named project Python environment without accepting arbitrary paths.
 *
 * Three places are consulted, in order: the environment `package_install`
 * manages for this project, then `.venv/<name>`, then — for the default
 * environment only — the conventional `.venv` and the host interpreter.
 *
 * The managed one comes first deliberately. It is the only one this product
 * creates and installs into, so a name that `package_install` has provisioned
 * must resolve to that environment rather than to a same-named directory a
 * project happens to carry. Both remain project-scoped names; neither accepts
 * an arbitrary path.
 */
export async function pythonEnvironment(projectRoot: string, input?: string): Promise<KernelStartOptions> {
  const environmentName = normalizeKernelEnvironmentName(input)
  // Instance is not always provided — `pythonEnvironment` is reachable from
  // contexts with no project bound, and throwing there would turn "no managed
  // environment" into "the resolver crashed".
  const managed = (() => {
    try {
      return Environment.directory(Instance.project.id, environmentName)
    } catch {
      return undefined
    }
  })()
  const roots = [...(managed ? [managed] : []), path.join(projectRoot, ".venv", environmentName)]
  if (environmentName === "python") roots.push(path.join(projectRoot, ".venv"))
  const candidates = roots.map((root) => ({ root, ...layout(root) }))

  for (const candidate of candidates) {
    if (!(await executable(candidate.binary))) continue
    return {
      binary: candidate.binary,
      environmentName,
      // Only for the managed one. `environment` is the DIRECTORY the sandbox has
      // to be granted and the kernel is bound to; a project's own `.venv` needs
      // neither, because it already lives inside the workspace.
      ...(candidate.root === managed ? { environment: managed } : {}),
      env: {
        VIRTUAL_ENV: path.dirname(candidate.bin),
        PATH: [candidate.bin, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    }
  }

  if (environmentName !== "python") {
    throw new KernelEnvironmentUnavailable(
      environmentName,
      candidates.map((candidate) => candidate.binary),
    )
  }
  return { environmentName }
}
