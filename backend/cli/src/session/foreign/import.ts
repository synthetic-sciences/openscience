// Imports one Claude Code or Codex conversation into the current project as an
// OpenScience session that can be continued, and keeps it in step on re-import.
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Global } from "../../global"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { FileLease } from "../../util/file-lease"
import { Filesystem } from "../../util/filesystem"
import { Log } from "../../util/log"
import { Session } from ".."
import { SessionFilesystem } from "../filesystem"
import { ClaudeReader } from "./claude"
import { CodexReader } from "./codex"
import { ForeignConvert } from "./convert"
import { Provenance } from "./provenance"
import type { ForeignConversation, ForeignReader, ForeignSessionInfo, ForeignSource } from "./types"

export namespace ForeignImport {
  const log = Log.create({ service: "session.foreign-import" })

  export const Source = z.enum(["claude", "codex"])
  export const FolderAccess = z.enum(["write", "read", "none"])
  export type FolderAccess = z.infer<typeof FolderAccess>

  export const NotFoundError = NamedError.create(
    "ForeignSessionNotFoundError",
    z.object({ source: z.string(), sourceID: z.string(), message: z.string() }),
  )

  export const SessionInfo = z
    .object({
      source: Source,
      id: z.string(),
      path: z.string(),
      cwd: z.string().optional(),
      title: z.string().optional(),
      firstMessage: z.string().optional(),
      created: z.number(),
      modified: z.number(),
      messageCount: z.number().optional(),
    })
    .meta({ ref: "ForeignSessionInfo" })

  export const Folder = z
    .object({
      path: z.string().optional(),
      exists: z.boolean(),
      connected: SessionFilesystem.Access.optional(),
    })
    .meta({ ref: "ForeignSessionFolder" })

  export const RunResult = z
    .object({
      sessionID: z.string(),
      outcome: z.enum(["created", "updated", "copied", "unchanged"]),
      reason: z.enum(["continued", "rewound"]).optional(),
      folderMissing: z.boolean().optional(),
    })
    .meta({ ref: "ForeignSessionImportResult" })

  export const EmptyError = NamedError.create(
    "ForeignSessionEmptyError",
    z.object({ source: z.string(), sourceID: z.string(), message: z.string() }),
  )

  export type Outcome = "created" | "updated" | "copied" | "unchanged"
  export type Result = {
    sessionID: string
    outcome: Outcome
    reason?: "continued" | "rewound"
    folderMissing?: boolean
  }

  /** Default locations; the environment variables override them (tests, unusual installs). */
  function roots(source: ForeignSource, root?: string): string[] {
    if (root) return [root]
    if (source === "claude") {
      const override = process.env.OPENSCIENCE_IMPORT_ROOT_CLAUDE
      if (override) return [override]
      // Claude Code honours CLAUDE_CONFIG_DIR for a relocated config.
      return [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(Global.Path.home, ".claude"), "projects")]
    }
    const codex = process.env.OPENSCIENCE_IMPORT_ROOT_CODEX
    if (codex) return [codex]
    // Codex honours CODEX_HOME for a relocated home.
    const home = process.env.CODEX_HOME || path.join(Global.Path.home, ".codex")
    return [path.join(home, "sessions"), path.join(home, "archived_sessions")]
  }

  function readers(source: ForeignSource, root?: string): ForeignReader[] {
    return roots(source, root).map((item) =>
      source === "claude" ? ClaudeReader.create(item) : CodexReader.create(item),
    )
  }

  export async function list(source: ForeignSource, root?: string): Promise<ForeignSessionInfo[]> {
    const all = (await Promise.all(readers(source, root).map((reader) => reader.list()))).flat()
    return all.toSorted((a, b) => b.modified - a.modified)
  }

  /** Exact-id lookup: the id is never used to build a path. */
  async function find(source: ForeignSource, sourceID: string, root?: string) {
    for (const reader of readers(source, root)) {
      const info = (await reader.list()).find((item) => item.id === sourceID)
      if (info) return { reader, info }
    }
    throw new NotFoundError({ source, sourceID, message: `No ${source} conversation with id ${sourceID}` })
  }

  async function canonical(value: string) {
    const resolved = await Filesystem.canonical(value)
    return resolved ? Project.canonicalize(resolved) : undefined
  }

  async function isDirectory(value: string) {
    return (await fs.stat(value).catch(() => undefined))?.isDirectory() ?? false
  }

  export async function folder(
    source: ForeignSource,
    sourceID: string,
    root?: string,
  ): Promise<{ path?: string; exists: boolean; connected?: "read" | "write" }> {
    const { info } = await find(source, sourceID, root)
    if (!info.cwd) return { exists: false }
    if (!(await isDirectory(info.cwd))) return { path: info.cwd, exists: false }
    const connected = await existingGrant(info.cwd)
    return { path: info.cwd, exists: true, ...(connected ? { connected: connected.access } : {}) }
  }

  async function existingGrant(dir: string) {
    const target = await canonical(dir)
    if (!target) return undefined
    const grants = (await SessionFilesystem.projectSnapshot()).grants.filter(
      (grant) => !grant.time.revoked && grant.path === target,
    )
    return grants.find((grant) => grant.access === "write") ?? grants[0]
  }

  /** Grant the folder at the requested level, reusing a grant that already
   * covers it and never lowering write to read. */
  async function grantFolder(dir: string, access: "read" | "write") {
    const current = await existingGrant(dir)
    if (current && (current.access === "write" || access === "read")) return current
    return SessionFilesystem.connectProject({ path: dir, access })
  }

  const lockPath = (source: ForeignSource, sourceID: string) =>
    path.join(
      Global.Path.data,
      "session-import",
      `${Instance.project.id}.${source}.${crypto.createHash("sha256").update(sourceID).digest("hex").slice(0, 32)}.lock`,
    )

  async function latestImport(source: ForeignSource, sourceID: string) {
    let latest: { sessionID: string; record: Provenance.Record } | undefined
    for (const sessionID of await Provenance.findBySource(source, sourceID)) {
      const exists = await Session.get(sessionID)
        .then(() => true)
        .catch(() => false)
      const record = await Provenance.read(sessionID)
      if (!exists || !record) {
        await Provenance.remove(sessionID)
        continue
      }
      if (!latest || record.importedAt >= latest.record.importedAt) latest = { sessionID, record }
    }
    return latest
  }

  /** Internal folder rule: the public three, plus "existing" (reuse a grant, never create one). */
  type FolderRule = FolderAccess | "existing"
  type RunInput = { source: ForeignSource; sourceID: string; folderAccess: FolderRule }

  export async function run(input: {
    source: ForeignSource
    sourceID: string
    folderAccess: FolderAccess
    root?: string
  }): Promise<Result> {
    const { reader, info } = await find(input.source, input.sourceID, input.root)
    return runInfo(reader, info, input)
  }

  /** One conversation, already resolved from the reader's own listing. */
  async function runInfo(reader: ForeignReader, info: ForeignSessionInfo, input: RunInput): Promise<Result> {
    await using lease = await FileLease.acquire(lockPath(input.source, input.sourceID), 120_000)
    return await lease.during(async () => {
      const conversation = await reader.load(info)
      const previous = await latestImport(input.source, input.sourceID)
      if (!previous && conversation.entries.length === 0) {
        throw new EmptyError({
          source: input.source,
          sourceID: input.sourceID,
          message: "This conversation has no messages to import.",
        })
      }
      if (!previous) return create(input, conversation, "created", undefined, false)

      const { sessionID, record } = previous
      const branch = new Set(conversation.branchIDs)
      // An empty earlier import wrote nothing; everything is new.
      const fromIndex = record.lastSourceID
        ? conversation.entries.findIndex((entry) => entry.sourceID === record.lastSourceID)
        : -1
      const nothingImported = !record.lastSourceID
      // The branch the copy came from is gone: the source was rewound or edited.
      if ((fromIndex < 0 && !nothingImported) || record.branchIDs.some((id) => !branch.has(id))) {
        return create(input, conversation, "copied", "rewound", true)
      }
      const from = fromIndex + 1
      // Nothing new in the source: leave the session alone, whether or not it was continued here.
      if (from >= conversation.entries.length) {
        // Branch ids can still grow (a trailing turn the source is writing).
        await Provenance.write(sessionID, { ...record, branchIDs: conversation.branchIDs })
        return { sessionID, outcome: "unchanged" as const }
      }
      const messages = await Session.messages({ sessionID })
      if (messages.some((message) => message.info.id > record.lastMessageID)) {
        return create(input, conversation, "copied", "continued", true)
      }
      const session = await Session.get(sessionID)
      const workingRoot = (await SessionFilesystem.state(sessionID)).workingRoot
      const cwd = workingRoot && workingRoot !== "scratch" ? workingRoot : session.directory
      const written = await ForeignConvert.write({
        sessionID,
        conversation,
        from,
        cwd,
        root: Instance.worktree,
        agent: "research",
      })
      await Provenance.write(sessionID, {
        ...record,
        branchIDs: conversation.branchIDs,
        lastSourceID: written.lastSourceID,
        lastMessageID: written.lastMessageID,
        importedAt: Date.now(),
      })
      return { sessionID, outcome: "updated" as const }
    })
  }

  async function create(
    input: RunInput,
    conversation: ForeignConversation,
    outcome: "created" | "copied",
    reason: "continued" | "rewound" | undefined,
    beside: boolean,
  ): Promise<Result> {
    const info = conversation.info
    let workingRoot: string | undefined
    let folderMissing: boolean | undefined
    if (input.folderAccess === "existing") throw new Error('folder rule "existing" is added in the project import')
    if (input.folderAccess !== "none") {
      if (info.cwd && (await isDirectory(info.cwd))) {
        try {
          const grant = await grantFolder(info.cwd, input.folderAccess)
          if (grant.access === "write") workingRoot = grant.path
        } catch (error) {
          // A folder OpenScience will not connect (its own scratch, tool output).
          log.warn("folder not connected", { cwd: info.cwd, error })
          folderMissing = true
        }
      } else folderMissing = true
    }
    const base = info.title ?? info.firstMessage?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "Imported conversation"
    // Every session made from this conversation counts; a copy beside a live import is numbered.
    const count = await Provenance.nextCopy(info.source, info.id)
    const title = beside ? `${base} (import #${Math.max(count, 2)})` : base
    const session = await Session.create({ title, workingRoot })
    try {
      const written = await ForeignConvert.write({
        sessionID: session.id,
        conversation,
        cwd: workingRoot ?? session.directory,
        root: Instance.worktree,
        agent: "research",
      })
      await Provenance.write(session.id, {
        source: info.source,
        sourceID: info.id,
        path: info.path,
        cwd: info.cwd,
        branchIDs: conversation.branchIDs,
        lastSourceID: written.lastSourceID,
        lastMessageID: written.lastMessageID,
        importedAt: Date.now(),
      })
    } catch (error) {
      // Never leave a half-written session without provenance: a retry would duplicate it.
      await Session.remove(session.id).catch(() => undefined)
      throw error
    }
    return {
      sessionID: session.id,
      outcome,
      ...(reason ? { reason } : {}),
      ...(folderMissing ? { folderMissing } : {}),
    }
  }
}
