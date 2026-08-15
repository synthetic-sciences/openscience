import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import z from "zod"
import type { KernelStartOptions } from "./types"

export const KernelEnvironmentName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use a simple environment name without path separators")

export function normalizeKernelEnvironmentName(input?: string) {
  const value = KernelEnvironmentName.parse(input ?? "python")
  return value.toLowerCase() === "default" ? "python" : value
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
 * Named venv or Conda-prefix environments live under `.venv/<name>`. The
 * conventional `.venv` layout and host interpreter remain fallbacks for the
 * default `python` environment so existing projects work without setup.
 */
export async function pythonEnvironment(projectRoot: string, input?: string): Promise<KernelStartOptions> {
  const environmentName = normalizeKernelEnvironmentName(input)
  const roots = [path.join(projectRoot, ".venv", environmentName)]
  if (environmentName === "python") roots.push(path.join(projectRoot, ".venv"))
  const candidates = roots.map(layout)

  for (const candidate of candidates) {
    if (!(await executable(candidate.binary))) continue
    return {
      binary: candidate.binary,
      environmentName,
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
