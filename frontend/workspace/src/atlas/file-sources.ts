export type FilesystemAccess = "read" | "write"
export type FilesystemScope = "once" | "session" | "project" | "installation"
export type FilesystemSource = "workspace" | "permission" | "api" | "tool" | "handoff"

export interface FilesystemGrant {
  id: string
  path: string
  access: FilesystemAccess
  scope: FilesystemScope
  source: FilesystemSource
  time: {
    created: number
    consumed?: number
    revoked?: number
  }
}

export interface FilesystemSnapshot {
  version: 1
  revision: number
  sessionID: string
  projectID: string
  directory: string
  grants: FilesystemGrant[]
  enforcement: {
    broker: "enforced"
    processWrite: "grant_only"
    processRead: "grant_only" | "policy_only"
  }
}

export interface FilesystemIdentity {
  sessionID: string
  projectID?: string
  directory: string
}

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function normalizeFilePath(value: string) {
  const input = value.replaceAll("\\", "/")
  const drive = input.match(/^[A-Za-z]:/)?.[0]
  const rooted = input.startsWith("/")
  const parts = input
    .replace(/^[A-Za-z]:/, "")
    .split("/")
    .filter(Boolean)
    .reduce<string[]>((all, part) => {
      if (part === ".") return all
      if (part === "..") return all.slice(0, -1)
      return [...all, part]
    }, [])
  const prefix = drive ? `${drive.toLowerCase()}/` : rooted ? "/" : ""
  return `${prefix}${parts.join("/")}` || prefix || "."
}

export function containsFilePath(root: string, target: string) {
  const base = normalizeFilePath(root).replace(/\/+$/, "") || "/"
  const file = normalizeFilePath(target)
  if (base === "/") return file.startsWith("/")
  const windows = /^[a-z]:\//.test(base) || /^[a-z]:\//.test(file)
  const parent = windows ? base.toLowerCase() : base
  const child = windows ? file.toLowerCase() : file
  return child === parent || child.startsWith(`${parent}/`)
}

function equalFilePath(left: string, right: string) {
  const first = normalizeFilePath(left)
  const second = normalizeFilePath(right)
  if (!/^[a-z]:\//.test(first) && !/^[a-z]:\//.test(second)) return first === second
  return first.toLowerCase() === second.toLowerCase()
}

export function fileSourceName(value: string) {
  const parts = normalizeFilePath(value).split("/").filter(Boolean)
  return parts[parts.length - 1] || "Folder"
}

export function parseFilesystemSnapshot(value: unknown, identity: FilesystemIdentity): FilesystemSnapshot | undefined {
  const root = record(value)
  const enforcement = record(root?.enforcement)
  if (
    root?.version !== 1 ||
    typeof root.revision !== "number" ||
    root.sessionID !== identity.sessionID ||
    typeof root.projectID !== "string" ||
    (identity.projectID && root.projectID !== identity.projectID) ||
    typeof root.directory !== "string" ||
    !equalFilePath(root.directory, identity.directory) ||
    !Array.isArray(root.grants) ||
    enforcement?.broker !== "enforced" ||
    enforcement.processWrite !== "grant_only" ||
    (enforcement.processRead !== "grant_only" && enforcement.processRead !== "policy_only")
  )
    return

  const grants = root.grants.flatMap((value): FilesystemGrant[] => {
    const grant = record(value)
    const time = record(grant?.time)
    if (
      typeof grant?.id !== "string" ||
      !grant.id.startsWith("fsg_") ||
      typeof grant.path !== "string" ||
      (grant.access !== "read" && grant.access !== "write") ||
      (grant.scope !== "once" &&
        grant.scope !== "session" &&
        grant.scope !== "project" &&
        grant.scope !== "installation") ||
      (grant.source !== "workspace" &&
        grant.source !== "permission" &&
        grant.source !== "api" &&
        grant.source !== "tool" &&
        grant.source !== "handoff") ||
      typeof time?.created !== "number" ||
      (time.consumed !== undefined && typeof time.consumed !== "number") ||
      (time.revoked !== undefined && typeof time.revoked !== "number")
    )
      return []
    return [
      {
        id: grant.id,
        path: normalizeFilePath(grant.path),
        access: grant.access,
        scope: grant.scope,
        source: grant.source,
        time: {
          created: time.created,
          consumed: time.consumed,
          revoked: time.revoked,
        },
      },
    ]
  })
  if (grants.length !== root.grants.length) return

  return {
    version: 1,
    revision: root.revision,
    sessionID: root.sessionID,
    projectID: root.projectID,
    directory: normalizeFilePath(root.directory),
    grants,
    enforcement: {
      broker: "enforced",
      processWrite: "grant_only",
      processRead: enforcement.processRead,
    },
  }
}

export function activeFilesystemGrants(snapshot?: FilesystemSnapshot) {
  return (snapshot?.grants ?? []).filter((grant) => !grant.time.consumed && !grant.time.revoked)
}

export function connectedFilesystemGrants(snapshot?: FilesystemSnapshot) {
  return activeFilesystemGrants(snapshot).filter((grant) => grant.source === "permission" || grant.source === "api")
}

export function sessionFilesystemRoot(snapshot?: FilesystemSnapshot) {
  return activeFilesystemGrants(snapshot).find(
    (grant) => grant.source === "workspace" && grant.scope === "session" && grant.access === "write",
  )?.path
}

export function filesystemRole(grant: Pick<FilesystemGrant, "access">) {
  if (grant.access === "write") return "Read & write"
  return "Read only"
}

export function filesystemScope(grant: Pick<FilesystemGrant, "scope">) {
  if (grant.scope === "once") return "One request"
  if (grant.scope === "installation") return "Every project"
  if (grant.scope === "project") return "This project"
  return "This session"
}

export function findFilesystemGrant(
  snapshot: FilesystemSnapshot | undefined,
  target: string,
  access: FilesystemAccess,
) {
  return activeFilesystemGrants(snapshot)
    .filter((grant) => {
      if (!containsFilePath(grant.path, target)) return false
      if (access === "write") return grant.access === "write"
      return true
    })
    .toSorted((a, b) => b.path.length - a.path.length)[0]
}

export function requestedFolder(target: string) {
  const file = normalizeFilePath(target)
  const index = file.lastIndexOf("/")
  if (index <= 0) return file
  return file.slice(0, index)
}
