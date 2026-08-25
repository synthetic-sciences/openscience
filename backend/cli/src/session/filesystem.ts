import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
import { Storage } from "@/storage/storage"
import { Sandbox } from "@/sandbox/sandbox"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { NamedError } from "@synsci/util/error"
import crypto from "crypto"
import path from "path"
import z from "zod"
import { SessionWorkspace } from "./workspace"
import { AuthoritySignal } from "@/project/authority-signal"
import { ToolOutputPath } from "@/tool/tool-output-path"
import { FileWatcher } from "@/file/watcher"

/**
 * Durable, directional filesystem authority for a session and its project.
 *
 * Permission prompts decide whether a user approves an access request. This
 * module turns that answer into an enforceable capability which every file
 * entry point can check. A write grant is read/write; a read grant can never
 * authorize mutation.
 */
export namespace SessionFilesystem {
  export const Access = z.enum(["read", "write"])
  export type Access = z.infer<typeof Access>

  export const Scope = z.enum(["once", "session", "project", "installation"])
  export type Scope = z.infer<typeof Scope>

  export const Source = z.enum(["workspace", "permission", "api", "tool", "handoff"])
  export type Source = z.infer<typeof Source>

  export const Grant = z.object({
    id: z.string().startsWith("fsg_"),
    path: z.string(),
    access: Access,
    scope: Scope,
    source: Source,
    time: z.object({
      created: z.number(),
      consumed: z.number().optional(),
      revoked: z.number().optional(),
    }),
  })
  export type Grant = z.infer<typeof Grant>

  export type Authorized = {
    path: string
    grant: Grant
  }

  /**
   * An in-process, operation-bound authorization. The WeakSet brand prevents a
   * caller from constructing one from request data, while the immutable grant
   * snapshot lets later phases revalidate a consumed one-shot grant without
   * accidentally consuming a second grant or accepting a later replacement.
   */
  export type Authorization = Readonly<{
    sessionID: string
    path: string
    access: Access
    grantID: string
    grantPath: string
    grantAccess: Access
    grantScope: Scope
    grantSource: Source
    created: number
    consumed?: number
  }>

  const results = new WeakMap<
    object,
    Readonly<{
      sessionID: string
      path: string
      access: Access
      grantID: string
      grantPath: string
      grantAccess: Access
      grantScope: Scope
      grantSource: Source
      created: number
      consumed?: number
    }>
  >()
  const bindings = new WeakSet<object>()

  export const State = z.object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    sessionID: z.string(),
    projectID: z.string(),
    directory: z.string(),
    grants: Grant.array(),
  })
  export type State = z.infer<typeof State>

  export const ProjectState = z.object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    projectID: z.string(),
    grants: Grant.extend({ scope: z.literal("project") }).array(),
  })
  export type ProjectState = z.infer<typeof ProjectState>

  export const InstallationState = z.object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    grants: Grant.extend({ scope: z.literal("installation") }).array(),
  })
  export type InstallationState = z.infer<typeof InstallationState>

  export const Snapshot = State.extend({
    workspace: SessionWorkspace.Info,
    enforcement: z.object({
      broker: z.literal("enforced"),
      processWrite: z.literal("grant_only"),
      processRead: z.enum(["grant_only", "policy_only"]),
    }),
  })
  export type Snapshot = z.infer<typeof Snapshot>

  export const DeniedError = NamedError.create(
    "SessionFilesystemDeniedError",
    z.object({
      sessionID: z.string(),
      path: z.string(),
      access: Access,
    }),
  )

  export const InvalidPathError = NamedError.create(
    "SessionFilesystemInvalidPathError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const Event = {
    Changed: BusEvent.define(
      "session.filesystem.changed",
      z.object({
        sessionID: z.string(),
        projectID: z.string(),
        grant: Grant,
      }),
    ),
  }

  const key = (sessionID: string) => ["session_filesystem", Instance.project.id, sessionID]
  const projectKey = (projectID = Instance.project.id) => ["project_filesystem", projectID]
  const installationKey = ["installation_filesystem"]
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  async function changed(sessionID: string, projectID: string, grant: Grant) {
    const signal = await AuthoritySignal.publish({
      kind: "filesystem",
      projectID,
      sessionID,
      scope: grant.scope,
    })
    await Bus.publish(Event.Changed, { sessionID, projectID, grant })
    await AuthoritySignal.settle(signal.revision)
  }

  async function canonical(input: string, base = Instance.directory) {
    const target = path.isAbsolute(input) ? input : path.resolve(base, input)
    const result = await Filesystem.canonical(target)
    if (result) return Project.canonicalize(result)
    throw new InvalidPathError({ path: target })
  }

  async function toolOutputRoot() {
    // Resolve through the stable managed data-root link on every authority
    // operation. Filesystem.canonical preserves a nonexistent tail below the
    // nearest existing physical parent, so this remains correct before the
    // first truncated output creates the directory and after a live data-root
    // retarget.
    const root = await Filesystem.canonical(ToolOutputPath.root)
    if (!root) throw new InvalidPathError({ path: ToolOutputPath.root })
    return Project.canonicalize(root)
  }

  async function assertNotToolOutput(target: string) {
    if (!Filesystem.overlaps(await toolOutputRoot(), target)) return
    throw new InvalidPathError({ path: target })
  }

  async function projectRoots(root: string, worktree: string) {
    if (managedProject()) return []
    const output = await toolOutputRoot()
    const enclave = [root, worktree].find((value) => Filesystem.contains(output, value))
    if (enclave) {
      throw new InvalidPathError({
        path: enclave,
        message:
          "This folder is reserved for OpenScience's managed tool outputs. Choose the repository folder itself or create a managed project and connect a narrower source folder.",
      })
    }
    // A selected parent may legitimately contain the managed enclave (a
    // legacy project rooted at the user's home is the common case). Preserve
    // authority for benign descendants and carve the enclave out at every
    // broker/process boundary instead of discarding the user's whole project.
    // Targets inside the enclave still require an exact owner capability in
    // authorize/allows/revalidateAuthorization, while native processes mask
    // ToolOutputPath.root through OpenScience.kernelSensitivePaths().
    return [...new Set([root, worktree])]
  }

  export async function validateProject(directory: string) {
    const root = await canonical(directory)
    const worktree = await canonical(Instance.worktree)
    await projectRoots(root, worktree)
  }

  async function managedToolOutput(target: string) {
    return Filesystem.contains(await toolOutputRoot(), target)
  }

  function exactToolOutputGrant(grant: Grant, target: string, access: Access) {
    return (
      access === "read" &&
      grant.source === "tool" &&
      grant.scope === "session" &&
      grant.path === target &&
      permits(grant, access)
    )
  }

  function managedProject() {
    const root = Project.canonicalize(path.join(Global.Path.data, "projects"))
    const worktree = Project.canonicalize(Instance.project.worktree)
    return path.dirname(worktree) === root && uuid.test(path.basename(worktree))
  }

  function sessions() {
    return SessionWorkspace.root()
  }

  function workspaceGrant(record: State) {
    return record.grants.find((grant) => grant.source === "workspace" && grant.scope === "session")
  }

  function isolated(record: State) {
    const grant = workspaceGrant(record)
    if (!grant || !sessions() || path.basename(grant.path) !== record.sessionID) return
    const root = path.dirname(grant.path)
    return { root, workspace: grant.path }
  }

  function assertPrivate(record: State, target: string, access: Access) {
    const boundary = isolated(record)
    if (!boundary) return
    if (!Filesystem.contains(boundary.root, target) || Filesystem.contains(boundary.workspace, target)) return
    if (
      access === "read" &&
      record.grants.some(
        (grant) =>
          grant.source === "handoff" &&
          grant.scope === "session" &&
          !grant.time.consumed &&
          !grant.time.revoked &&
          Filesystem.contains(grant.path, target),
      )
    )
      return
    throw new DeniedError({
      sessionID: record.sessionID,
      path: target,
      access,
    })
  }

  async function read(sessionID: string): Promise<State> {
    return Storage.read<State>(key(sessionID))
  }

  async function assert(record: State) {
    const directory = Project.canonicalize(Instance.directory)
    if (record.projectID === Instance.project.id && record.directory === directory) return record
    throw new DeniedError({
      sessionID: record.sessionID,
      path: directory,
      access: "read",
    })
  }

  function assertProject(sessionID: string, record: ProjectState) {
    if (record.projectID === Instance.project.id) return record
    throw new DeniedError({
      sessionID,
      path: Project.canonicalize(Instance.directory),
      access: "read",
    })
  }

  async function project(sessionID: string) {
    const load = () =>
      Storage.read<ProjectState>(projectKey()).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
    const existing = await load()
    if (existing) return assertProject(sessionID, ProjectState.parse(existing))

    using _ = await Lock.write(`session-filesystem:project:${Instance.project.id}`)
    const record = await Storage.upsert<ProjectState>(projectKey(), (current) =>
      current
        ? ProjectState.parse(current)
        : {
            version: 1,
            revision: 1,
            projectID: Instance.project.id,
            grants: [],
          },
    )
    return assertProject(sessionID, ProjectState.parse(record))
  }

  async function installation() {
    const load = () =>
      Storage.read<InstallationState>(installationKey).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
    const existing = await load()
    if (existing) return InstallationState.parse(existing)

    using _ = await Lock.write("session-filesystem:installation")
    return Storage.upsert<InstallationState>(installationKey, (current) =>
      current
        ? InstallationState.parse(current)
        : {
            version: 1,
            revision: 1,
            grants: [],
          },
    )
  }

  async function ensure(sessionID: string) {
    const existing = await read(sessionID).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (existing) {
      const record = await assert(State.parse(existing))
      const boundary = isolated(record)
      await SessionWorkspace.ensure({
        sessionID,
        directory: record.directory,
        mode: boundary ? "isolated" : "legacy",
        scratchRoot: workspaceGrant(record)?.path ?? record.directory,
        grantRevision: record.revision,
      })
      return record
    }

    // Lazily upgrade sessions created before filesystem grants shipped.
    const session = await Storage.read<{ id: string; projectID: string; directory: string }>([
      "session",
      Instance.project.id,
      sessionID,
    ])
    if (
      session.projectID !== Instance.project.id ||
      Project.canonicalize(session.directory) !== Project.canonicalize(Instance.directory)
    ) {
      throw new DeniedError({
        sessionID,
        path: Project.canonicalize(Instance.directory),
        access: "read",
      })
    }
    await initialize(sessionID, session.directory)
    return assert(State.parse(await read(sessionID)))
  }

  export async function initialize(sessionID: string, directory: string, options: { revokeExisting?: boolean } = {}) {
    const root = await canonical(directory)
    const worktree = await canonical(Instance.worktree)
    // A broad legacy project such as the user's home directory may contain the
    // managed tool-output enclave. Keep its ordinary descendants usable while
    // the enclave remains an exact, broker-only capability.
    const roots = await projectRoots(root, worktree)
    const existing = await read(sessionID).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (existing) return assert(State.parse(existing))

    const workspace = await SessionWorkspace.create({
      sessionID,
      directory: root,
      mode: "isolated",
    })
    const canonicalWorkspace = await canonical(workspace.scratchRoot)
    const grants: Grant[] = [
      {
        id: `fsg_${crypto.randomUUID()}`,
        path: canonicalWorkspace,
        access: "write",
        scope: "session",
        source: "workspace",
        time: { created: Date.now() },
      },
      ...(roots.length
        ? roots.map(
            (value): Grant => ({
              id: `fsg_${crypto.randomUUID()}`,
              path: value,
              access: "write",
              scope: "session",
              source: "api",
              time: { created: Date.now() },
            }),
          )
        : []),
    ]
    const record: State = {
      version: 1,
      revision: 1,
      sessionID,
      projectID: Instance.project.id,
      directory: root,
      grants,
    }
    let inserted = false
    const stored = await Storage.upsert<State>(key(sessionID), (current) => {
      if (current) return State.parse(current)
      inserted = true
      return record
    })
    if (!inserted) return assert(State.parse(stored)).then((value) => workspaceGrant(value))
    await project(sessionID)
    if (options.revokeExisting !== false) {
      for (const grant of grants) {
        await changed(sessionID, Instance.project.id, grant)
      }
    }
    return grants[0]
  }

  /**
   * Attach user-selected source locations before the first session exists.
   * These grants are project-scoped, so every later session inherits them
   * through `state()` without turning a host path into the project identity.
   */
  export async function seedProject(input: { projectID: string; grants: Array<{ path: string; access: Access }> }) {
    const roots = await Promise.all(
      input.grants.map(async (grant) => {
        if (!path.isAbsolute(grant.path)) throw new InvalidPathError({ path: grant.path })
        const root = await Filesystem.canonical(grant.path)
        if (!root) throw new InvalidPathError({ path: grant.path })
        await assertNotToolOutput(Project.canonicalize(root))
        return { path: Project.canonicalize(root), access: grant.access }
      }),
    )
    if (roots.length === 0) return

    const storage = projectKey(input.projectID)
    let additions: Array<Grant & { scope: "project" }> = []
    await Storage.upsert<ProjectState>(storage, (raw) => {
      const record = raw
        ? ProjectState.parse(raw)
        : ({ version: 1, revision: 1, projectID: input.projectID, grants: [] } satisfies ProjectState)
      if (record.projectID !== input.projectID) throw new InvalidPathError({ path: input.projectID })
      additions = roots
        .filter(
          (root, index, all) =>
            all.findIndex((item) => item.path === root.path && item.access === root.access) === index &&
            !record.grants.some(
              (grant) => !grant.time.revoked && grant.path === root.path && grant.access === root.access,
            ),
        )
        .map((root): Grant & { scope: "project" } => ({
          id: `fsg_${crypto.randomUUID()}`,
          path: root.path,
          access: root.access,
          scope: "project",
          source: "api",
          time: { created: Date.now() },
        }))
      if (!additions.length) return record
      return { ...record, revision: record.revision + 1, grants: [...record.grants, ...additions] }
    })
    for (const grant of additions) await changed(`project:${input.projectID}`, input.projectID, grant)
  }

  export async function grant(input: {
    sessionID: string
    path: string
    access: Access
    scope: Scope
    source?: Source
  }) {
    if (input.source === "tool" || input.source === "handoff") {
      throw new InvalidPathError({ path: input.path })
    }
    return insert(input)
  }

  /**
   * Give a direct delegated child read-only access to its parent's scratch
   * workspace. Both sessions must be isolated siblings in this project's
   * managed workspace root; arbitrary session or external paths cannot be
   * supplied. The directional grant lets delegated children inspect finalized
   * parent artifacts without allowing mutation or exposing unrelated sessions.
   */
  export async function grantTaskHandoff(input: { parentSessionID: string; childSessionID: string }) {
    const [parent, child] = await Promise.all([ensure(input.parentSessionID), ensure(input.childSessionID)])
    const source = isolated(parent)
    const target = isolated(child)
    if (
      !source ||
      !target ||
      source.root !== target.root ||
      source.workspace === target.workspace ||
      path.basename(source.workspace) !== input.parentSessionID ||
      path.basename(target.workspace) !== input.childSessionID ||
      parent.projectID !== child.projectID ||
      parent.directory !== child.directory
    ) {
      throw new DeniedError({
        sessionID: input.childSessionID,
        path: source?.workspace ?? parent.directory,
        access: "read",
      })
    }
    const grant: Grant = {
      id: `fsg_${crypto.randomUUID()}`,
      path: source.workspace,
      access: "read",
      scope: "session",
      source: "handoff",
      time: { created: Date.now() },
    }
    const result = await Storage.update<State>(key(input.childSessionID), (draft) => {
      const duplicate = draft.grants.find(
        (item) =>
          item.source === "handoff" &&
          item.path === source.workspace &&
          item.access === "read" &&
          item.scope === "session" &&
          !item.time.revoked,
      )
      if (duplicate) {
        grant.id = duplicate.id
        grant.time = duplicate.time
        return
      }
      draft.grants.push(grant)
      draft.revision++
    })
    const stored = result.grants.find((item) => item.id === grant.id) ?? grant
    await changed(input.childSessionID, Instance.project.id, stored)
    return stored
  }

  /** Internal exact-file capability for app-managed truncated tool output. */
  export async function grantToolOutput(input: { sessionID: string; path: string }) {
    const state = await ensure(input.sessionID)
    const root = await canonical(input.path)
    assertPrivate(state, root, "read")
    const grant: Grant = {
      id: `fsg_${crypto.randomUUID()}`,
      path: root,
      access: "read",
      scope: "session",
      source: "tool",
      time: { created: Date.now() },
    }
    const result = await Storage.update<State>(key(input.sessionID), (draft) => {
      const duplicate = draft.grants.find(
        (item) =>
          item.source === "tool" &&
          !item.time.consumed &&
          !item.time.revoked &&
          item.path === root &&
          item.access === "read" &&
          item.scope === "session",
      )
      if (duplicate) {
        grant.id = duplicate.id
        grant.time = duplicate.time
        return
      }
      draft.grants.push(grant)
    })
    // Tool-output authority is broker-only. It must not change the process
    // authority generation or emit the revocation event used to stop warm
    // kernels, PTYs, commands, and compute jobs. Native processes never mount
    // this grant; only brokered file tools and an explicitly materialized Task
    // handoff can consume it.
    return result.grants.find((item) => item.id === grant.id) ?? grant
  }

  async function insert(input: { sessionID: string; path: string; access: Access; scope: Scope; source?: Source }) {
    const state = await ensure(input.sessionID)
    const root = await canonical(input.path)
    await assertNotToolOutput(root)
    assertPrivate(state, root, input.access)
    const now = Date.now()
    const grant: Grant = {
      id: `fsg_${crypto.randomUUID()}`,
      path: root,
      access: input.access,
      scope: input.scope,
      source: input.source ?? "api",
      time: { created: now },
    }
    if (input.scope === "installation") {
      await installation()
      const result = await Storage.update<InstallationState>(installationKey, (draft) => {
        const duplicate = draft.grants.find(
          (item) => !item.time.revoked && item.path === root && item.access === input.access,
        )
        if (duplicate) {
          grant.id = duplicate.id
          grant.time = duplicate.time
          return
        }
        draft.grants.push({ ...grant, scope: "installation" })
        draft.revision++
      })
      const stored = result.grants.find((item) => item.id === grant.id) ?? grant
      await changed(input.sessionID, Instance.project.id, stored)
      return stored
    }
    if (input.scope === "project") {
      await project(input.sessionID)
      const result = await Storage.update<ProjectState>(projectKey(), (draft) => {
        assertProject(input.sessionID, ProjectState.parse(draft))
        const duplicate = draft.grants.find(
          (item) =>
            !item.time.revoked && item.path === root && item.access === input.access && item.scope === input.scope,
        )
        if (duplicate) {
          grant.id = duplicate.id
          grant.time = duplicate.time
          return
        }
        draft.grants.push({ ...grant, scope: "project" })
        draft.revision++
      })
      const stored = result.grants.find((item) => item.id === grant.id) ?? grant
      await changed(input.sessionID, Instance.project.id, stored)
      return stored
    }
    const result = await Storage.update<State>(key(input.sessionID), (draft) => {
      const duplicate = draft.grants.find(
        (item) =>
          !item.time.consumed &&
          !item.time.revoked &&
          item.path === root &&
          item.access === input.access &&
          item.scope === input.scope,
      )
      if (duplicate) {
        grant.id = duplicate.id
        grant.time = duplicate.time
        return
      }
      draft.grants.push(grant)
      draft.revision++
    })
    const stored = result.grants.find((item) => item.id === grant.id) ?? grant
    await changed(input.sessionID, Instance.project.id, stored)
    return stored
  }

  function permits(grant: Grant, access: Access) {
    if (grant.time.consumed || grant.time.revoked) return false
    if (access === "write") return grant.access === "write"
    return grant.access === "read" || grant.access === "write"
  }

  /**
   * Resolve and authorize a target in one operation. The returned path is the
   * canonical path callers must use, preventing a checked symlink spelling
   * from being reused for the actual I/O.
   */
  export async function authorize(input: { sessionID: string; path: string; access: Access }): Promise<Authorized> {
    const record = await state(input.sessionID)
    const target = await canonical(input.path, workspaceGrant(record)?.path ?? record.directory)
    assertPrivate(record, target, input.access)
    const enclave = await managedToolOutput(target)
    const matches = record.grants
      .filter((grant) =>
        enclave
          ? exactToolOutputGrant(grant, target, input.access)
          : permits(grant, input.access) && Filesystem.contains(grant.path, target),
      )
      .sort((a, b) => {
        const priority = { installation: 0, project: 1, session: 2, once: 3 }
        if (a.scope !== b.scope) return priority[a.scope] - priority[b.scope]
        return b.path.length - a.path.length
      })
    const grant = matches[0]
    if (!grant) {
      throw new DeniedError({
        sessionID: input.sessionID,
        path: target,
        access: input.access,
      })
    }
    if (grant.scope === "once") {
      const consumed = Date.now()
      await Storage.update<State>(key(input.sessionID), (draft) => {
        const current = draft.grants.find((item) => item.id === grant.id)
        if (!current || current.time.consumed || current.time.revoked) {
          throw new DeniedError({
            sessionID: input.sessionID,
            path: target,
            access: input.access,
          })
        }
        current.time.consumed = consumed
        draft.revision++
      })
      grant.time.consumed = consumed
      await changed(input.sessionID, Instance.project.id, grant)
    }
    const result = { path: target, grant }
    results.set(
      result,
      Object.freeze({
        sessionID: input.sessionID,
        path: target,
        access: input.access,
        grantID: grant.id,
        grantPath: grant.path,
        grantAccess: grant.access,
        grantScope: grant.scope,
        grantSource: grant.source,
        created: grant.time.created,
        ...(grant.time.consumed ? { consumed: grant.time.consumed } : {}),
      }),
    )
    return result
  }

  /** Bind the exact result of `authorize` to one multi-phase broker operation. */
  export async function bindAuthorization(input: {
    sessionID: string
    access: Access
    authorized: Authorized
  }): Promise<Authorization> {
    const result = results.get(input.authorized)
    if (!result || result.sessionID !== input.sessionID || (input.access === "write" && result.access !== "write")) {
      throw new DeniedError({
        sessionID: input.sessionID,
        path: input.authorized.path,
        access: input.access,
      })
    }
    const record = await state(input.sessionID)
    const grant = record.grants
      .filter(
        (candidate) =>
          candidate.id === result.grantID &&
          candidate.path === result.grantPath &&
          candidate.access === result.grantAccess &&
          candidate.scope === result.grantScope &&
          candidate.source === result.grantSource &&
          candidate.time.created === result.created &&
          !candidate.time.revoked &&
          (!candidate.time.consumed ||
            (candidate.id === result.grantID && candidate.time.consumed === result.consumed)) &&
          (input.access === "write"
            ? candidate.access === "write"
            : candidate.access === "read" || candidate.access === "write") &&
          Filesystem.contains(candidate.path, result.path),
      )
      .toSorted((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id))[0]
    if (!grant || (grant.scope === "once" && !grant.time.consumed)) {
      throw new DeniedError({
        sessionID: input.sessionID,
        path: result.path,
        access: input.access,
      })
    }
    const binding = Object.freeze({
      sessionID: input.sessionID,
      path: result.path,
      access: input.access,
      grantID: grant.id,
      grantPath: grant.path,
      grantAccess: grant.access,
      grantScope: grant.scope,
      grantSource: grant.source,
      created: grant.time.created,
      ...(grant.time.consumed ? { consumed: grant.time.consumed } : {}),
    })
    results.delete(input.authorized)
    bindings.add(binding)
    return binding
  }

  /** End one broker operation's authority lifetime deterministically. */
  export function releaseAuthorization(binding: Authorization) {
    bindings.delete(binding)
  }

  /**
   * Revalidate a bound operation without re-consuming a once grant. A directory
   * binding may cover descendants used by the same operation; an exact-file
   * binding remains exact. Revocation, replacement, path retargeting, and access
   * escalation all fail closed.
   */
  export async function revalidateAuthorization(
    binding: Authorization,
    input?: { path?: string; access?: Access },
  ): Promise<Authorized> {
    const access = input?.access ?? binding.access
    const requested = input?.path ?? binding.path
    const denied = () => new DeniedError({ sessionID: binding.sessionID, path: requested, access })
    if (!bindings.has(binding)) throw denied()
    if (access === "write" && binding.access !== "write") throw denied()

    const record = await state(binding.sessionID)
    const target = await canonical(requested, workspaceGrant(record)?.path ?? record.directory).catch(() => undefined)
    if (!target) throw denied()
    assertPrivate(record, target, access)
    const grant = record.grants.find((item) => item.id === binding.grantID)
    if (
      !grant ||
      grant.path !== binding.grantPath ||
      grant.access !== binding.grantAccess ||
      grant.scope !== binding.grantScope ||
      grant.source !== binding.grantSource ||
      grant.time.created !== binding.created ||
      grant.time.revoked ||
      grant.time.consumed !== binding.consumed ||
      (access === "write" ? grant.access !== "write" : grant.access !== "read" && grant.access !== "write")
    ) {
      throw denied()
    }
    const enclave = await managedToolOutput(target)
    if (
      enclave
        ? !exactToolOutputGrant({ ...grant, time: { ...grant.time, consumed: undefined } }, target, access)
        : !Filesystem.contains(grant.path, target)
    ) {
      throw denied()
    }
    return { path: target, grant }
  }

  /**
   * Check reusable session authority without consuming access. One-shot grants
   * stay bound to the request that created them instead of suppressing a
   * concurrent prompt which could otherwise consume that request's grant.
   */
  export async function allows(input: { sessionID: string; path: string; access: Access }) {
    const record = await state(input.sessionID)
    const target = await canonical(input.path, workspaceGrant(record)?.path ?? record.directory)
    assertPrivate(record, target, input.access)
    const enclave = await managedToolOutput(target)
    return record.grants.some(
      (grant) =>
        grant.scope !== "once" &&
        (enclave
          ? exactToolOutputGrant(grant, target, input.access)
          : permits(grant, input.access) && Filesystem.contains(grant.path, target)),
    )
  }

  /**
   * An explicit read-only connection is a durable upper bound, not an invitation
   * for an automatic permission policy to add a stronger session grant. The
   * boundary remains until the user explicitly adds a matching write grant via
   * the filesystem settings/API.
   */
  export async function restrictsWrite(input: { sessionID: string; path: string }) {
    const record = await state(input.sessionID)
    const target = await canonical(input.path, workspaceGrant(record)?.path ?? record.directory)
    assertPrivate(record, target, "write")
    const grants = record.grants.filter((grant) => permits(grant, "read") && Filesystem.contains(grant.path, target))
    if (!grants.length) return false
    return !grants.some((grant) => permits(grant, "write"))
  }

  /**
   * An exact app-managed tool output belongs to the session that produced it.
   * This is deliberately narrower than a normal filesystem grant: callers may
   * read that one file without reopening the external-directory policy, but a
   * parent directory, sibling output, or another session never inherits it.
   */
  export async function ownsToolOutput(input: { sessionID: string; path: string }) {
    const record = await state(input.sessionID)
    const target = await canonical(input.path, workspaceGrant(record)?.path ?? record.directory)
    return record.grants.some(
      (grant) =>
        grant.source === "tool" && grant.scope === "session" && grant.path === target && permits(grant, "read"),
    )
  }

  export async function list(sessionID: string) {
    return state(sessionID).then((value) => value.grants)
  }

  export async function state(sessionID: string) {
    const record = await ensure(sessionID)
    const [shared, global] = await Promise.all([project(sessionID), installation()])
    const result = State.parse({
      ...record,
      revision: record.revision + shared.revision + global.revision - 2,
      grants: [...record.grants, ...shared.grants, ...global.grants],
    })
    await SessionWorkspace.revise(sessionID, result.revision)
    return result
  }

  /** Public policy packet. Native Seatbelt and bubblewrap backends enforce
   * canonical read grants; policy_only is reserved for an unavailable native
   * sandbox where brokered file access still remains enforced. */
  export async function snapshot(sessionID: string): Promise<Snapshot> {
    const filesystem = await state(sessionID)
    const workspace = await SessionWorkspace.touch(sessionID)
    return {
      ...filesystem,
      workspace,
      enforcement: {
        broker: "enforced",
        processWrite: "grant_only",
        processRead: Sandbox.describe().readIsolation === "grant_only" ? "grant_only" : "policy_only",
      },
    }
  }

  /** Start native watchers only when a Files-pane client materializes this
   * snapshot. Harness and process-authority callers also need the policy
   * packet, but must not allocate one long-lived watcher per agent session. */
  export async function watch(sessionID: string, current?: Snapshot) {
    const value = current ?? (await snapshot(sessionID))
    return FileWatcher.watchSession(sessionID, [
      value.workspace.scratchRoot,
      ...value.grants
        .filter(
          (grant) =>
            !grant.time.consumed &&
            !grant.time.revoked &&
            grant.scope !== "once" &&
            (grant.source === "permission" || grant.source === "api"),
        )
        .map((grant) => grant.path),
    ])
  }

  /** Persistent explicit read roots for newly launched processes. One-shot
   * grants are bound to the single brokered invocation that consumes them. */
  export async function processReadRoots(sessionID: string) {
    const record = await state(sessionID)
    return record.grants
      .filter((grant) => grant.source !== "tool" && grant.scope !== "once" && permits(grant, "read"))
      .map((grant) => grant.path)
  }

  /** Persistent explicit write roots for newly launched processes. */
  export async function processWriteRoots(sessionID: string) {
    const record = await state(sessionID)
    return record.grants.filter((grant) => grant.scope !== "once" && permits(grant, "write")).map((grant) => grant.path)
  }

  export async function workspace(sessionID: string) {
    const record = await ensure(sessionID)
    return SessionWorkspace.touch(sessionID).then((value) => value.scratchRoot)
  }

  export async function revoke(sessionID: string, grantID: string) {
    return AuthoritySignal.exclusive(async () => {
      const current = await state(sessionID)
      const target = current.grants.find((item) => item.id === grantID)
      if (!target) throw new Storage.NotFoundError({ message: `Filesystem grant not found: ${grantID}` })
      const revoked = Date.now()
      if (target.source === "tool") {
        const record = await Storage.update<State>(key(sessionID), (draft) => {
          const grant = draft.grants.find((item) => item.id === grantID && item.source === "tool")
          if (!grant) throw new Storage.NotFoundError({ message: `Filesystem grant not found: ${grantID}` })
          grant.time.revoked = revoked
        })
        return record.grants.find((item) => item.id === grantID)!
      }
      if (target.scope === "installation") {
        const record = await Storage.update<InstallationState>(installationKey, (draft) => {
          const grant = draft.grants.find((item) => item.id === grantID)
          if (!grant) throw new Storage.NotFoundError({ message: `Filesystem grant not found: ${grantID}` })
          grant.time.revoked = revoked
          draft.revision++
        })
        const grant = record.grants.find((item) => item.id === grantID)!
        await changed(sessionID, Instance.project.id, grant)
        return grant
      }
      if (target.scope === "project") {
        const record = await Storage.update<ProjectState>(projectKey(), (draft) => {
          assertProject(sessionID, ProjectState.parse(draft))
          const grant = draft.grants.find((item) => item.id === grantID)
          if (!grant) throw new Storage.NotFoundError({ message: `Filesystem grant not found: ${grantID}` })
          grant.time.revoked = revoked
          draft.revision++
        })
        const grant = record.grants.find((item) => item.id === grantID)!
        await changed(sessionID, Instance.project.id, grant)
        return grant
      }
      const record = await Storage.update<State>(key(sessionID), (draft) => {
        const grant = draft.grants.find((item) => item.id === grantID)
        if (!grant) throw new Storage.NotFoundError({ message: `Filesystem grant not found: ${grantID}` })
        grant.time.revoked = revoked
        draft.revision++
      })
      const grant = record.grants.find((item) => item.id === grantID)!
      await changed(sessionID, Instance.project.id, grant)
      return grant
    })
  }

  export async function remove(sessionID: string) {
    return AuthoritySignal.exclusive(async () => {
      const record = await read(sessionID).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
      if (record) {
        await ensure(sessionID)
        await SessionWorkspace.trash(sessionID)
      }
      await Storage.remove(key(sessionID))
      await FileWatcher.unwatchSession(sessionID).catch(() => {})
      return AuthoritySignal.publish({
        kind: "filesystem",
        projectID: Instance.project.id,
        sessionID,
        scope: "session",
      })
    })
  }

  /** Move stale orphan scratch into recoverable trash and purge trash only
   * after the workspace retention window. */
  export async function sweep() {
    await SessionWorkspace.sweep()
  }
}
