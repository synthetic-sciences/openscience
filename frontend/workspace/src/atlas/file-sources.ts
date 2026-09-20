export type FilesystemAccess = "read" | "write"
export type FilesystemScope = "once" | "session" | "project" | "installation"
type FilesystemSource = "workspace" | "project" | "skill" | "permission" | "api" | "tool" | "handoff" | "parent"

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
  /** Where the session's relative paths land right now: the folder pinned for
   * this conversation, the one the server chose for it, or the session's own
   * scratch directory. Absent from servers older than the field. */
  toolDirectory?: string
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

/** Two spellings of one location. A Windows volume is case-insensitive, so
 * `C:\Research` and `c:/research` are the same folder and must compare equal;
 * a POSIX path is not, and `/Data` is not `/data`. */
export function equalFilePath(left: string, right: string) {
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
    (root.toolDirectory !== undefined && typeof root.toolDirectory !== "string") ||
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
        grant.source !== "project" &&
        grant.source !== "skill" &&
        grant.source !== "permission" &&
        grant.source !== "api" &&
        grant.source !== "tool" &&
        grant.source !== "handoff" &&
        grant.source !== "parent") ||
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
    ...(root.toolDirectory ? { toolDirectory: normalizeFilePath(root.toolDirectory) } : {}),
    enforcement: {
      broker: "enforced",
      processWrite: "grant_only",
      processRead: enforcement.processRead,
    },
  }
}

function activeFilesystemGrants(snapshot?: FilesystemSnapshot) {
  return (snapshot?.grants ?? []).filter((grant) => !grant.time.consumed && !grant.time.revoked)
}

/** Folders the user connected or approved for this project. The project's
 * own roots, skill directories and one-shot tool grants are runtime authority,
 * not working files. */
function projectFilesystemGrants(snapshot?: FilesystemSnapshot) {
  return activeFilesystemGrants(snapshot).filter(
    (grant) => (grant.source === "permission" || grant.source === "api") && grant.scope !== "installation",
  )
}

/**
 * The folders the pane lists as connected locations: the ones connected or
 * approved for this project, plus the folder this conversation actually works
 * in when that is a grant the list would otherwise skip — one inherited from a
 * lead session, or one approved installation-wide.
 *
 * Those two are working folders that no row named, so the pane had nowhere to
 * open and fell back to the managed project root, which is empty. A folder the
 * agent writes in has to be reachable from the pane that browses it.
 */
export function connectedFilesystemGrants(snapshot?: FilesystemSnapshot) {
  const listed = projectFilesystemGrants(snapshot)
  const working = workingFilesystemRoot(snapshot)
  if (!working || listed.some((grant) => equalFilePath(grant.path, working))) return listed
  const inherited = workingRootCandidates(snapshot).find((grant) => equalFilePath(grant.path, working))
  return inherited ? [...listed, inherited] : listed
}

/** The folders the server will consider when this conversation has pinned
 * none. Mirrors `workingRootCandidates` in the CLI's session filesystem:
 * durable writable folders the user connected, plus the ones a parent session
 * handed down. Deliberately wider than `connectedFilesystemGrants`, which
 * decides what the pane lists rather than what the agent works in. */
function workingRootCandidates(snapshot?: FilesystemSnapshot) {
  return activeFilesystemGrants(snapshot)
    .filter(
      (grant) =>
        (grant.source === "permission" || grant.source === "api" || grant.source === "parent") &&
        grant.scope !== "once" &&
        grant.access === "write",
    )
    .toSorted((left, right) => right.time.created - left.time.created)
}

/**
 * The folder this conversation works in — the one the composer's "Working in …"
 * chip names. The server has already resolved it, pinned choice and all, so the
 * answer is read off the snapshot rather than guessed a second time from the
 * grants, where a pinned folder leaves no trace. A scratch working folder comes
 * back as the session workspace root, which the pane offers as "This session".
 * Older servers send no answer; only then is it recomputed.
 */
export function workingFilesystemRoot(snapshot?: FilesystemSnapshot) {
  return snapshot?.toolDirectory ?? workingRootCandidates(snapshot)[0]?.path
}

export function sessionFilesystemRoot(snapshot?: FilesystemSnapshot) {
  return activeFilesystemGrants(snapshot).find(
    (grant) => grant.source === "workspace" && grant.scope === "session" && grant.access === "write",
  )?.path
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
