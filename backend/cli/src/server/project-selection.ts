import type { Context } from "hono"
import { Project } from "../project/project"

function text(input: unknown) {
  if (typeof input !== "string") return
  const value = input.trim()
  return value || undefined
}

function decode(input: string | undefined) {
  if (!input) return
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

/**
 * Resolve the project capability carried by a request before the Instance
 * middleware is mounted. Explicit route payload values take precedence so
 * legacy body/query directory overrides are still checked against the selected
 * project's server-owned roots.
 */
export async function projectSelection(
  context: Context,
  input: {
    projectID?: unknown
    directory?: unknown
  } = {},
) {
  const projectID =
    text(context.req.query("project")) ??
    text(context.req.query("projectID")) ??
    text(context.req.header("x-openscience-project")) ??
    text(input.projectID)
  const raw =
    text(input.directory) ?? text(context.req.query("directory")) ?? text(context.req.header("x-openscience-directory"))
  const directory = decode(raw)

  if (projectID) return { ...(await Project.resolve(projectID, directory)), selector: directory }
  return {
    project: undefined,
    directory: directory ? Project.canonicalize(directory) : undefined,
    alias: undefined,
    // The caller-supplied root before canonicalization, so routes that mint an
    // instance can reject it while the folder picker keeps reporting its own
    // friendlier "path not found".
    selector: directory,
  }
}
