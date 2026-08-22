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

export type AuthorizedPath = {
  path: string
  authorization?: SessionFilesystem.Authorization
  authorizationOwnership: "owned" | "none"
  managedToolOutput?: boolean
  revalidate(): Promise<string>
  dispose(): void
  [Symbol.dispose](): void
}

const scopes = new WeakSet<object>()

export function isAuthorizedPath(value: unknown): value is AuthorizedPath {
  return typeof value === "object" && value !== null && scopes.has(value)
}

function scope(input: {
  path: string
  authorization?: SessionFilesystem.Authorization
  managedToolOutput?: boolean
}): AuthorizedPath {
  const state = { disposed: false }
  const dispose = () => {
    if (state.disposed) return
    state.disposed = true
    if (input.authorization) SessionFilesystem.releaseAuthorization(input.authorization)
  }
  const result: AuthorizedPath = {
    path: input.path,
    authorization: input.authorization,
    authorizationOwnership: input.authorization ? "owned" : "none",
    ...(input.managedToolOutput ? { managedToolOutput: true } : {}),
    revalidate: async () => {
      if (state.disposed) {
        throw new SessionFilesystem.DeniedError({
          sessionID: input.authorization?.sessionID ?? "unknown",
          path: input.path,
          access: input.authorization?.access ?? "read",
        })
      }
      if (!input.authorization) {
        const current = await Filesystem.canonical(input.path)
        if (current === input.path) return current
        throw new SessionFilesystem.InvalidPathError({
          path: input.path,
          message: `Refusing to access ${input.path}: the authorized path changed or became a symbolic link before the file operation`,
        })
      }
      return SessionFilesystem.revalidateAuthorization(input.authorization, {
        path: input.path,
        access: input.authorization.access,
      }).then((authorized) => authorized.path)
    },
    dispose,
    [Symbol.dispose]: dispose,
  }
  scopes.add(result)
  return result
}

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
  if (options?.bypass) return scope({ path: canonical })

  const workspace = ctx.sessionID.startsWith("ses_") ? await SessionFilesystem.workspace(ctx.sessionID) : undefined
  const canonicalWorkspace = workspace ? await Filesystem.canonical(workspace) : undefined
  const internal =
    (canonicalWorkspace ? Filesystem.contains(canonicalWorkspace, canonical) : false) ||
    (await Instance.containsCanonicalPath(canonical))
  if (internal) return scope({ path: canonical })
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
  if (!ctx.sessionID.startsWith("ses_")) return scope({ path: canonical })
  const authorized = await SessionFilesystem.authorize({
    sessionID: ctx.sessionID,
    path: canonical,
    access,
  })
  const authorization = await SessionFilesystem.bindAuthorization({
    sessionID: ctx.sessionID,
    access,
    authorized,
  })
  return scope({ path: authorized.path, authorization, managedToolOutput: owned })
}
