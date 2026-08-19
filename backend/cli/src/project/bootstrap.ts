import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Skill } from "../skill/skill"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { Session } from "../session"
import { SessionCompaction } from "../session/compaction"
import { SessionFilesystem } from "../session/filesystem"
import { ProjectTrust } from "./trust"
import { Pty } from "../pty"
import { KernelRuntime } from "@/science/kernel/registry"
import { AuthoritySignal } from "./authority-signal"
import { CommandRuntime } from "@/science/command/registry"
import { AuthorityProcessLedger } from "./authority-process"
import { MCP } from "@/mcp"
import { CredentialProcessLedger } from "@/credentials/process-ledger"
import { Agent } from "@/agent/agent"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeEvents } from "@/runtime/events"
import { SessionPrompt } from "@/session/prompt"
import { BiologyKernelLifecycle } from "@/tool/biology/kernel-lifecycle"
import { subscribeFilesystemEvents } from "./filesystem-event-sync"

async function invalidateProjectTokenCache(projectID: string) {
  const { Provider } = await import("@/provider/provider")
  Provider.invalidateTokenCache(projectID)
}

/**
 * Project executable definitions are memoized independently from Config.
 * Revocation must evict them before the mutation is acknowledged; otherwise a
 * long-running instance can keep returning commands, tools, skills, agents, or
 * plugin auth/hooks loaded while the project was trusted. These operations are
 * synchronous cache swaps (or an in-process event for Skill), so they never
 * acquire the AuthoritySignal lease already held by ProjectTrust.update.
 */
async function invalidateProjectExecutionCaches() {
  Command.invalidate()
  ToolRegistry.invalidate()
  Agent.invalidate()
  Plugin.invalidate()
  const providerAuth = import("@/provider/auth").then(({ ProviderAuth }) => ProviderAuth.invalidate())
  await Promise.all([Skill.invalidate(), providerAuth])
}

async function stopSessions(sessionIDs: string[]) {
  const sessions = [...new Set(sessionIDs)]
  const projectID = Instance.project.id
  const biology = Promise.all(sessions.map((sessionID) => BiologyKernelLifecycle.releaseSession(projectID, sessionID)))
  const jobs = import("../compute/jobs").then((module) =>
    Promise.all(sessions.map((sessionID) => module.ComputeJobs.cancelSession(sessionID))),
  )
  await Promise.all([
    ...sessions.map((sessionID) => Pty.releaseSession(sessionID)),
    ...sessions.map((sessionID) => KernelRuntime.releaseSession(sessionID)),
    ...sessions.map((sessionID) => CommandRuntime.stopSession(projectID, sessionID)),
    biology,
    jobs,
  ])
  await Promise.all(sessions.map((sessionID) => AuthorityProcessLedger.revoke({ projectID, sessionID })))
}

async function stopFilesystem(sessionID: string, scope: SessionFilesystem.Scope) {
  const projectID = Instance.project.id
  await stopSessions(await affected(sessionID, scope))
  if (scope === "project") await AuthorityProcessLedger.revoke({ projectID })
  // Installation grants authorize every project. Reap the global durable
  // ledger as well as each live instance's local runtimes so a killed owner
  // from an unloaded project cannot retain the revoked authority.
  if (scope === "installation") await AuthorityProcessLedger.revoke()
}

async function affected(sessionID: string, scope: SessionFilesystem.Scope) {
  if (scope === "once" || scope === "session") return [sessionID]
  const sessions = []
  for await (const session of Session.list()) sessions.push(session.id)
  return sessions
}

const filesystemSync = Instance.state(
  () => {
    const directory = Instance.directory
    const projectID = Instance.project.id
    const handler = (event: { directory?: string; payload: unknown }) => {
      const raw = typeof event.payload === "object" && event.payload ? event.payload : {}
      if (!("type" in raw) || raw.type !== SessionFilesystem.Event.Changed.type) return
      const payload = SessionFilesystem.Event.Changed.properties.safeParse(
        "properties" in raw ? raw.properties : undefined,
      )
      if (!payload.success || event.directory === directory) return
      if (payload.data.grant.scope !== "installation" && payload.data.projectID !== projectID) return
      Instance.provide({
        directory,
        fn: async () => stopFilesystem(payload.data.sessionID, payload.data.grant.scope),
      }).catch((error) => Log.Default.error("failed to apply filesystem authority change", { error, directory }))
    }
    return subscribeFilesystemEvents(handler)
  },
  async (release) => {
    release()
  },
)

const authoritySync = Instance.state(
  async () => {
    const directory = Instance.directory
    const projectID = Instance.project.id
    return AuthoritySignal.watch(async (change) => {
      return Instance.provide({
        directory,
        fn: async () => {
          if (change.type === "resync") {
            const sessions = []
            for await (const session of Session.list()) sessions.push(session.id)
            await Promise.all([
              stopSessions(sessions),
              LSP.dispose(),
              MCP.disposeLocal(),
              invalidateProjectExecutionCaches(),
            ])
            await Promise.all([
              AuthorityProcessLedger.revoke({ projectID }),
              CredentialProcessLedger.revoke({ kind: "mcp", projectID }),
              CredentialProcessLedger.revoke({ kind: "provider", projectID }),
              invalidateProjectTokenCache(projectID),
            ])
            return true
          }
          const event = change.event
          if (event.kind === "trust") {
            if (event.projectID !== projectID) return false
            if (!event.denied) {
              await invalidateProjectExecutionCaches()
              return true
            }
            const jobs = import("../compute/jobs").then((module) => module.ComputeJobs.cancelProject(projectID))
            const biology = BiologyKernelLifecycle.releaseProject(projectID)
            await Promise.all([
              Pty.releaseAll(),
              KernelRuntime.releaseProject(projectID),
              CommandRuntime.stopProject(projectID),
              LSP.dispose(),
              MCP.disposeLocal(),
              invalidateProjectExecutionCaches(),
              biology,
              jobs,
            ])
            await Promise.all([
              AuthorityProcessLedger.revoke({ projectID }),
              CredentialProcessLedger.revoke({ kind: "mcp", projectID }),
              CredentialProcessLedger.revoke({ kind: "provider", projectID }),
              invalidateProjectTokenCache(projectID),
            ])
            return true
          }
          if (event.scope !== "installation" && event.projectID !== projectID) return false
          await stopFilesystem(event.sessionID, event.scope)
          return true
        },
      })
    })
  },
  async (watcher) => {
    await watcher[Symbol.asyncDispose]()
  },
)

const runtimeCancellationSync = Instance.state(
  () =>
    RuntimeEvents.watchCancellationRequests(async (request) => {
      await applyRuntimeCancellationRequest(request)
    }),
  async (watcher) => {
    await watcher[Symbol.asyncDispose]()
  },
)

export function applyRuntimeCancellationRequest(request: {
  sessionID: string
  runID: string
  source: "user" | "runner_timeout"
}) {
  return RuntimeEvents.cancel({
    ...request,
    // Run the controller abort synchronously after the exact journal owner is
    // terminalized but before terminal event delivery yields. A stale request
    // that no longer owns the journal never invokes this callback and cannot
    // cancel a newer prompt in the same session.
    onCancelled: () => SessionPrompt.cancel(request.sessionID),
  })
}

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()
  filesystemSync()
  await authoritySync()
  runtimeCancellationSync()

  // Scratch workspaces: remove orphans whose session record is gone.
  SessionFilesystem.sweep().catch(() => {})

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  // Hot-reload the skill registry when a SKILL.md changes on disk (external
  // edits surface via the watcher when OPENSCIENCE_EXPERIMENTAL_FILEWATCHER=1;
  // in-app authoring self-invalidates through Skill.writeUser).
  Bus.subscribe(FileWatcher.Event.Updated, async (payload) => {
    if (payload.properties.file.endsWith("SKILL.md")) {
      await Skill.invalidate().catch(() => {})
    }
  })

  // Free the per-session compaction circuit-breaker entry when a session is deleted, so a
  // long-running instance handling many sessions doesn't accumulate stale breaker state.
  Bus.subscribe(Session.Event.Deleted, async (payload) => {
    SessionCompaction.resetBreaker(payload.properties.info.id)
    const jobs = import("../compute/jobs").then((module) =>
      module.ComputeJobs.cancelSession(payload.properties.info.id),
    )
    const biology = BiologyKernelLifecycle.releaseSession(Instance.project.id, payload.properties.info.id)
    await Promise.all([
      Pty.releaseSession(payload.properties.info.id),
      KernelRuntime.removeSession(Instance.project.id, payload.properties.info.id),
      CommandRuntime.stopSession(Instance.project.id, payload.properties.info.id),
      biology,
      jobs,
    ])
    await AuthorityProcessLedger.revoke({
      projectID: Instance.project.id,
      sessionID: payload.properties.info.id,
    })
  })

  // Process authority is revision-bound. Trust revocation stops every live
  // project process. Filesystem changes stop every process covered by their
  // session, project, or installation scope, including other live instances.
  Bus.subscribe(ProjectTrust.Event.Changed, async (payload) => {
    if (payload.properties.status.canExecuteProjectCode) {
      await invalidateProjectExecutionCaches()
      return
    }
    const jobs = import("../compute/jobs").then((module) => module.ComputeJobs.cancelProject(Instance.project.id))
    const biology = BiologyKernelLifecycle.releaseProject(Instance.project.id)
    await Promise.all([
      Pty.releaseAll(),
      KernelRuntime.releaseProject(Instance.project.id),
      CommandRuntime.stopProject(Instance.project.id),
      LSP.dispose(),
      MCP.disposeLocal(),
      invalidateProjectExecutionCaches(),
      biology,
      jobs,
    ])
    await Promise.all([
      AuthorityProcessLedger.revoke({ projectID: Instance.project.id }),
      CredentialProcessLedger.revoke({ kind: "mcp", projectID: Instance.project.id }),
      CredentialProcessLedger.revoke({ kind: "provider", projectID: Instance.project.id }),
      invalidateProjectTokenCache(Instance.project.id),
    ])
  })

  Bus.subscribe(SessionFilesystem.Event.Changed, async (payload) => {
    await stopFilesystem(payload.properties.sessionID, payload.properties.grant.scope)
  })

  // Tombstoned deletions are deliberately resumed only after all runtime
  // cleanup handlers above are installed, so recovery has the same strict
  // acknowledgment contract as the original request.
  await Session.resumeDeleting()
}
