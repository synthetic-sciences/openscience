import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { WSContext } from "hono/ws"
import { Instance } from "../project/instance"
import { lazy } from "@synsci/util/lazy"
import { Shell } from "@/shell/shell"
import { ExecutionAuthority } from "@/project/execution"
import { AuthoritySignal } from "@/project/authority-signal"
import { AuthorityProcessLedger } from "@/project/authority-process"
import { Sandbox } from "@/sandbox/sandbox"
import { OpenScience } from "@/openscience"
import { terminalArgs, terminalEnv } from "./environment"
import { Replay } from "./replay"
import { WindowsJobLauncher } from "@/process/windows-job-launcher"
import { Filesystem } from "@/util/filesystem"
import { UpdateQuiescence } from "@/process/update-quiescence"

export namespace Pty {
  const log = Log.create({ service: "pty" })
  const REPLAY_REQUEST = "\0"

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      projectID: z.string(),
      sessionID: z.string(),
      authority: ExecutionAuthority.Decision,
      status: z.enum(["running", "exited"]),
      pid: z.number(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    sessionID: z.string().startsWith("ses_"),
    title: z.string().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: string
    subscribers: Map<WSContext, boolean>
    releaseUpdate: () => void
  }

  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      const projects = new Set<string>()
      for (const session of sessions.values()) {
        projects.add(session.info.projectID)
      }
      // Revoke durable ownership while each exact leader is still available
      // for identity/group verification. Native PTY cleanup follows only as a
      // local handle fallback during failed registration; registered sessions
      // are already gone when revoke resolves.
      await Promise.all([...projects].map((projectID) => AuthorityProcessLedger.revoke({ kind: "pty", projectID })))
      for (const session of sessions.values()) {
        session.releaseUpdate()
        for (const ws of session.subscribers.keys()) {
          ws.close()
        }
      }
      sessions.clear()
    },
  )

  export function list() {
    return Array.from(state().values()).map((s) => s.info)
  }

  export function get(id: string) {
    return state().get(id)?.info
  }

  export async function create(input: CreateInput) {
    const id = Identifier.create("pty", false)
    const command = Shell.preferred()
    const args = terminalArgs(command)
    const spawn = await pty()
    return AuthoritySignal.exclusive(async () => {
      const releaseUpdate = UpdateQuiescence.enter("pty")
      let handedOff = false
      try {
        const authority = await ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          capability: "terminal",
        })
        const project = authority.directory ?? Instance.directory
        // Local projects grant their real worktree as a writable root, so an
        // interactive terminal should open where the user expects. Hosted or
        // otherwise isolated sessions retain their private session workspace.
        const cwd = authority.writable.some((root) => Filesystem.contains(root, project))
          ? project
          : authority.workspace
        // Interactive PTY output is not a redaction boundary. Keep provider/cloud
        // credentials on the host; terminals receive runtime discovery only.
        const source = OpenScience.kernelEnv(process.env)
        const env = terminalEnv(source, Instance.project.id, input.sessionID, command)
        const sandbox = Sandbox.wrapArgv({
          file: command,
          args,
          workspace: authority.writable,
          readable: authority.readable,
          unreadable: OpenScience.kernelSensitivePaths(),
          options: authority.sandbox,
        })
        const launch = WindowsJobLauncher.wrap({ file: sandbox.file, args: sandbox.args })
        log.info("creating session", { id, cmd: command, args, cwd })

        const ptyProcess = (() => {
          try {
            return spawn(launch.file, launch.args, {
              name: "xterm-256color",
              cwd,
              env,
            })
          } catch (error) {
            Sandbox.cleanup(sandbox)
            throw error
          }
        })()

        let session: ActiveSession | undefined
        let earlyExit: number | undefined
        let earlyBuffer = ""
        const sessions = state()
        ptyProcess.onData((data) => {
          const active = session
          if (!active) {
            earlyBuffer = Replay.append(earlyBuffer, data)
            return
          }
          active.buffer = Replay.append(active.buffer, data)
          for (const [ws, ready] of active.subscribers) {
            if (ws.readyState !== 1) {
              active.subscribers.delete(ws)
              continue
            }
            if (!ready) continue
            ws.send(data)
          }
        })
        ptyProcess.onExit(({ exitCode }) => {
          Sandbox.cleanup(sandbox)
          if (!session) {
            earlyExit = exitCode
            return
          }
          const active = session
          log.info("session exited", { id, exitCode })
          active.info.status = "exited"
          for (const ws of active.subscribers.keys()) ws.close()
          active.subscribers.clear()
          void Bus.publish(Event.Exited, { id, exitCode })
          void AuthorityProcessLedger.complete(id)
            .then((completed) => {
              if (!completed) throw new Error(`Terminal ${id} still has a live authority process`)
              sessions.delete(id)
              active.releaseUpdate()
            })
            .catch((error) => log.error("failed to complete terminal authority record", { id, error }))
        })

        const registered = await AuthorityProcessLedger.register({
          id,
          kind: "pty",
          pid: ptyProcess.pid,
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          authorityGeneration: authority.generation,
          windowsRelease: launch.release,
        }).catch(async (error) => {
          await AuthorityProcessLedger.revoke({ id, kind: "pty" }).catch(() => undefined)
          try {
            ptyProcess.kill()
          } catch {}
          Sandbox.cleanup(sandbox)
          throw error
        })
        if (!registered || earlyExit !== undefined) {
          await AuthorityProcessLedger.revoke({ id, kind: "pty" })
          try {
            ptyProcess.kill()
          } catch {}
          Sandbox.cleanup(sandbox)
          throw new Error(
            `Terminal process exited before durable authority registration (code ${earlyExit ?? "unknown"})`,
          )
        }

        const info = {
          id,
          title: input.title || `Terminal ${id.slice(-4)}`,
          command,
          args,
          cwd,
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          authority,
          status: "running",
          pid: ptyProcess.pid,
        } as const
        session = {
          info,
          process: ptyProcess,
          buffer: earlyBuffer,
          subscribers: new Map(),
          releaseUpdate,
        }
        sessions.set(id, session)
        handedOff = true
        void Bus.publish(Event.Created, { info })
        return info
      } finally {
        if (!handedOff) releaseUpdate()
      }
    })
  }

  export async function update(id: string, input: UpdateInput) {
    const session = state().get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      session.process.resize(input.size.cols, input.size.rows)
    }
    Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  export async function remove(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("removing session", { id })
    await AuthorityProcessLedger.revoke({ id, kind: "pty" })
    session.releaseUpdate()
    for (const ws of session.subscribers.keys()) {
      ws.close()
    }
    state().delete(id)
    Bus.publish(Event.Deleted, { id })
  }

  export async function releaseSession(sessionID: string) {
    const ids = [...state().values()]
      .filter((session) => session.info.sessionID === sessionID)
      .map((session) => session.info.id)
    await Promise.all(ids.map((id) => remove(id)))
  }

  export async function releaseAll() {
    await Promise.all([...state().keys()].map((id) => remove(id)))
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: WSContext) {
    const session = state().get(id)
    if (!session) {
      ws.close()
      return
    }
    log.info("client connected to session", { id })
    session.subscribers.set(ws, false)
    return {
      onMessage: (message: string | ArrayBuffer) => {
        const data = String(message)
        if (session.subscribers.get(ws) !== true) {
          const buffer = session.buffer
          if (ws.readyState !== 1) return
          session.subscribers.set(ws, true)
          if (buffer) {
            try {
              for (const chunk of Replay.chunks(buffer)) ws.send(chunk)
            } catch {
              session.subscribers.delete(ws)
              ws.close()
              return
            }
          }
          if (data === REPLAY_REQUEST) return
        }
        try {
          session.process.write(data)
        } catch {
          session.subscribers.delete(ws)
          ws.close()
        }
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
      },
    }
  }
}
