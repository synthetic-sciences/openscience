import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { SessionFilesystem } from "../session/filesystem"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
  access?: SessionFilesystem.Access
}

export type AuthorizedPath = { path: string; managedToolOutput?: boolean }

/** The agent-facing cwd is the isolated workspace owned by this session. */
export async function sessionToolDirectory(ctx: Pick<Tool.Context, "sessionID">) {
  if (!ctx.sessionID.startsWith("ses_")) return Instance.directory
  return SessionFilesystem.workspace(ctx.sessionID)
}

export async function assertExternalDirectory(
  ctx: Tool.Context,
  target?: string,
  options?: Options,
): Promise<AuthorizedPath | undefined> {
  if (!target) return

  const canonical = await Filesystem.canonical(target)
  if (!canonical) throw new SessionFilesystem.InvalidPathError({ path: path.resolve(target) })
  if (options?.bypass) return { path: canonical }

  const workspace = ctx.sessionID.startsWith("ses_") ? await SessionFilesystem.workspace(ctx.sessionID) : undefined
  const canonicalWorkspace = workspace ? await Filesystem.canonical(workspace) : undefined
  const internal =
    (canonicalWorkspace ? Filesystem.contains(canonicalWorkspace, canonical) : false) ||
    (await Instance.containsCanonicalPath(canonical))
  if (internal) return { path: canonical }
  const owned = ctx.sessionID.startsWith("ses_")
    ? await SessionFilesystem.ownsToolOutput({ sessionID: ctx.sessionID, path: canonical })
    : false
  const access = options?.access ?? "read"
  const granted =
    !owned && ctx.sessionID.startsWith("ses_")
      ? await SessionFilesystem.allows({ sessionID: ctx.sessionID, path: canonical, access })
      : false

  if (!owned && !granted) {
    const kind = options?.kind ?? "file"
    const parentDir = kind === "directory" ? canonical : path.dirname(canonical)
    const glob = path.join(parentDir, "*")

    await ctx.ask({
      permission: "external_directory",
      patterns: [glob],
      always: [glob],
      metadata: {
        filepath: canonical,
        parentDir,
        filesystem: {
          path: parentDir,
          access,
        },
      },
    })
  }

  // Direct unit tests use a deliberately synthetic context. Production tool
  // contexts always carry a real session id and therefore fail closed here.
  if (!ctx.sessionID.startsWith("ses_")) return { path: canonical }
  const authorized = await SessionFilesystem.authorize({
    sessionID: ctx.sessionID,
    path: canonical,
    access,
  })
  return { ...authorized, ...(owned ? { managedToolOutput: true } : {}) }
}
