import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import crypto from "node:crypto"
import { constants as FS } from "node:fs"
import { Tool } from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectory, sessionToolDirectory, type AuthorizedPath } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { Filesystem } from "../util/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { FileTrash } from "../file/trash"
import { Lock } from "@/util/lock"
import type { SessionFilesystem } from "@/session/filesystem"
import { AuthoritySignal } from "@/project/authority-signal"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

type ApprovedFile = {
  bytes: Buffer
  content: string
  dev: number
  ino: number
  mode: number
}

type FileChange = {
  filePath: string
  oldContent: string
  newContent: string
  type: "add" | "update" | "delete" | "move"
  movePath?: string
  diff: string
  additions: number
  deletions: number
  approved?: ApprovedFile
  authorization?: SessionFilesystem.Authorization
  access?: AuthorizedPath
  targetAccess?: AuthorizedPath
}

async function revalidate(change: FileChange, target = false) {
  const expected = target ? (change.movePath ?? change.filePath) : change.filePath
  const access = target ? (change.targetAccess ?? change.access) : change.access
  const current = (await access?.revalidate()) ?? expected
  if (current !== expected) throw new Error(`File authority changed before editing ${expected}`)
}

async function readApprovedFile(filepath: string): Promise<ApprovedFile> {
  const requested = await fs.lstat(filepath)
  if (requested.isSymbolicLink()) throw new Error(`Refusing to edit a symbolic link: ${filepath}`)
  const handle = await fs.open(filepath, FS.O_RDONLY | FS.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`Only regular files can be edited: ${filepath}`)
    const bytes = await handle.readFile()
    return {
      bytes,
      content: bytes.toString("utf8"),
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode & 0o777,
    }
  } finally {
    await handle.close()
  }
}

async function assertAbsent(filepath: string) {
  const exists = await fs.lstat(filepath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (exists) throw new Error(`Refusing to overwrite an existing file: ${filepath}`)
}

async function assertApprovedFile(filepath: string, approved: ApprovedFile) {
  const current = await readApprovedFile(filepath).catch((error) => {
    throw new Error(`Refusing to edit ${filepath}: the file changed after approval: ${error}`)
  })
  if (current.dev !== approved.dev || current.ino !== approved.ino) {
    throw new Error(`Refusing to edit ${filepath}: the file identity changed after approval`)
  }
  if (!current.bytes.equals(approved.bytes)) {
    throw new Error(`Refusing to edit ${filepath}: the file changed after approval`)
  }
}

async function stageFile(target: string, content: string, mode: number) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const canonical = await Filesystem.canonical(target)
  if (!canonical || canonical !== target) throw new Error(`Edit destination became ambiguous: ${target}`)
  const staged = path.join(path.dirname(target), `.openscience-edit-${crypto.randomUUID()}.tmp`)
  await fs.writeFile(staged, content, { encoding: "utf8", flag: "wx", mode })
  return staged
}

async function installExclusive(staged: string, target: string) {
  try {
    // link() is an atomic no-replace install on the target filesystem.
    await fs.link(staged, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite an existing file: ${target}`)
    }
    throw error
  }
}

type PreparedChange = {
  change: FileChange
  target?: string
  staged?: string
  stagedApproved?: ApprovedFile
  backup?: string
  sourceMoved: boolean
  installed: boolean
  removed?: FileTrash.Record
}

async function prepareChange(change: FileChange): Promise<PreparedChange> {
  if (change.type === "delete") return { change, sourceMoved: false, installed: false }
  const target = change.movePath ?? change.filePath
  const mode = change.approved?.mode ?? 0o644
  const staged = await stageFile(target, change.newContent, mode)
  try {
    return {
      change,
      target,
      staged,
      stagedApproved: await readApprovedFile(staged),
      ...(change.type === "update"
        ? { backup: path.join(path.dirname(change.filePath), `.openscience-approved-${crypto.randomUUID()}.bak`) }
        : {}),
      sourceMoved: false,
      installed: false,
    }
  } catch (error) {
    await fs.rm(staged, { force: true })
    throw error
  }
}

async function removeInstalled(item: PreparedChange) {
  if (!item.installed || !item.target || !item.stagedApproved) return
  await assertApprovedFile(item.target, item.stagedApproved)
  await fs.unlink(item.target)
  item.installed = false
}

async function applyTransaction(changes: FileChange[], ctx: Tool.Context) {
  const prepared: PreparedChange[] = []
  try {
    for (const change of changes) {
      if (change.type === "delete") {
        prepared.push(await prepareChange(change))
        continue
      }
      prepared.push(
        await AuthoritySignal.exclusive(async () => {
          await revalidate(change, change.type === "move")
          return prepareChange(change)
        }),
      )
    }
  } catch (error) {
    await Promise.all(prepared.map((item) => (item.staged ? fs.rm(item.staged, { force: true }) : undefined)))
    throw error
  }

  const started: PreparedChange[] = []
  try {
    for (const item of prepared) {
      const change = item.change
      started.push(item)
      switch (change.type) {
        case "add":
          await AuthoritySignal.exclusive(async () => {
            await revalidate(change)
            await installExclusive(item.staged!, change.filePath)
          })
          item.installed = true
          break
        case "update":
          if (!change.approved || !item.backup) throw new Error(`Missing approved file snapshot for ${change.filePath}`)
          await AuthoritySignal.exclusive(async () => {
            await revalidate(change)
            await fs.rename(change.filePath, item.backup!)
            item.sourceMoved = true
            await assertApprovedFile(item.backup!, change.approved!)
            await installExclusive(item.staged!, change.filePath)
          })
          item.installed = true
          break
        case "move":
          if (!change.approved || !change.movePath) {
            throw new Error(`Missing approved move state for ${change.filePath}`)
          }
          item.removed = await FileTrash.trash({
            projectID: Instance.project.id,
            sessionID: ctx.sessionID,
            path: change.filePath,
            authorization: change.authorization,
            authorizationOwnership: "borrowed",
            expectedContent: change.approved.bytes,
          })
          await AuthoritySignal.exclusive(async () => {
            await revalidate(change, true)
            await installExclusive(item.staged!, change.movePath!)
          })
          item.installed = true
          break
        case "delete":
          if (!change.approved) throw new Error(`Missing approved file snapshot for ${change.filePath}`)
          item.removed = await FileTrash.trash({
            projectID: Instance.project.id,
            sessionID: ctx.sessionID,
            path: change.filePath,
            authorization: change.authorization,
            authorizationOwnership: "borrowed",
            expectedContent: change.approved.bytes,
          })
          break
      }
    }

    await Promise.all(
      prepared.map(async (item) => {
        // Cleanup is post-commit housekeeping. A transient unlink failure must
        // not convert a fully committed transaction into an unsafe rollback.
        if (item.backup) await fs.rm(item.backup, { force: true }).catch(() => undefined)
        if (item.staged) await fs.rm(item.staged, { force: true }).catch(() => undefined)
      }),
    )
    return prepared.flatMap((item) => (item.removed ? [item.removed] : []))
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const item of started.toReversed()) {
      try {
        await removeInstalled(item)
        if (item.removed) await FileTrash.rollback(item.removed)
        if (item.sourceMoved && item.backup) {
          await installExclusive(item.backup, item.change.filePath)
          await fs.unlink(item.backup)
          item.sourceMoved = false
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Multi-file patch failed and one or more rollback steps need manual recovery",
      )
    }
    throw error
  } finally {
    await Promise.all(prepared.map((item) => (item.staged ? fs.rm(item.staged, { force: true }) : undefined)))
  }
}

export const ApplyPatchTool = Tool.define("apply_patch", {
  description: DESCRIPTION,
  parameters: PatchParams,
  async execute(params, ctx) {
    if (!params.patchText) {
      throw new Error("patchText is required")
    }

    // Parse the patch to get hunks
    let hunks: Patch.Hunk[]
    try {
      const parseResult = Patch.parsePatch(params.patchText)
      hunks = parseResult.hunks
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${error}`)
    }

    if (hunks.length === 0) {
      const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
      if (normalized === "*** Begin Patch\n*** End Patch") {
        throw new Error("patch rejected: empty patch")
      }
      throw new Error("apply_patch verification failed: no hunks found")
    }

    // Validate file paths and check permissions
    const fileChanges: FileChange[] = []
    const accesses: AuthorizedPath[] = []
    using _accesses = {
      [Symbol.dispose]() {
        for (const access of accesses.toReversed()) access.dispose()
      },
    }
    const authorize = async (target: string) => {
      const access = await assertExternalDirectory(ctx, target, { access: "write" })
      if (access) accesses.push(access)
      return access
    }

    let totalDiff = ""

    const directory = await sessionToolDirectory(ctx)
    for (const hunk of hunks) {
      const requested = path.resolve(directory, hunk.path)
      const access = await authorize(requested)
      const filePath = access?.path ?? requested

      switch (hunk.type) {
        case "add": {
          await assertAbsent(filePath)
          const oldContent = ""
          const newContent =
            hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

          let additions = 0
          let deletions = 0
          for (const change of diffLines(oldContent, newContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          fileChanges.push({
            filePath,
            oldContent,
            newContent,
            type: "add",
            diff,
            additions,
            deletions,
            authorization: access?.authorization,
            access,
          })

          totalDiff += diff + "\n"
          break
        }

        case "update": {
          const approved = await readApprovedFile(filePath).catch((error) => {
            throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}: ${error}`)
          })
          const oldContent = approved.content
          let newContent = oldContent

          // Apply the update chunks to get new content
          try {
            const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks, oldContent)
            newContent = fileUpdate.content
          } catch (error) {
            throw new Error(`apply_patch verification failed: ${error}`)
          }

          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

          let additions = 0
          let deletions = 0
          for (const change of diffLines(oldContent, newContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          const requestedMove = hunk.move_path ? path.resolve(directory, hunk.move_path) : undefined
          const targetAccess = requestedMove ? await authorize(requestedMove) : undefined
          const movePath = targetAccess?.path ?? requestedMove
          if (movePath) {
            if (movePath === filePath) throw new Error(`apply_patch verification failed: move destination is unchanged`)
            await assertAbsent(movePath)
          }

          fileChanges.push({
            filePath,
            oldContent,
            newContent,
            type: hunk.move_path ? "move" : "update",
            movePath,
            diff,
            additions,
            deletions,
            approved,
            authorization: access?.authorization,
            access,
            targetAccess,
          })

          totalDiff += diff + "\n"
          break
        }

        case "delete": {
          const approved = await readApprovedFile(filePath).catch((error) => {
            throw new Error(`apply_patch verification failed: ${error}`)
          })
          const contentToDelete = approved.content
          const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

          const deletions = contentToDelete.split("\n").length

          fileChanges.push({
            filePath,
            oldContent: contentToDelete,
            newContent: "",
            type: "delete",
            diff: deleteDiff,
            additions: 0,
            deletions,
            approved,
            authorization: access?.authorization,
            access,
          })

          totalDiff += deleteDiff + "\n"
          break
        }
      }
    }

    // Build per-file metadata for UI rendering (used for both permission and result)
    const files = fileChanges.map((change) => ({
      filePath: change.filePath,
      relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath),
      type: change.type,
      diff: change.diff,
      before: change.oldContent,
      after: change.newContent,
      additions: change.additions,
      deletions: change.deletions,
      movePath: change.movePath,
    }))

    // Check permissions if needed
    const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath))
    await ctx.ask({
      permission: "edit",
      patterns: relativePaths,
      always: ["*"],
      metadata: {
        filepath: relativePaths.join(", "),
        diff: totalDiff,
        files,
      },
    })

    // Approval is bound to exact source bytes+inode and to absent add/move
    // destinations. Serialize the full preflight + commit and roll every
    // completed file back if a later commit step fails.
    using _transaction = await Lock.write(`apply-patch:${Instance.project.id}`)
    for (const change of fileChanges) {
      if (change.approved) await assertApprovedFile(change.filePath, change.approved)
      if (change.type === "add") await assertAbsent(change.filePath)
      if (change.type === "move" && change.movePath) await assertAbsent(change.movePath)
    }

    const trash = await applyTransaction(fileChanges, ctx)
    const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
    for (const change of fileChanges) {
      const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
      switch (change.type) {
        case "add":
          updates.push({ file: change.filePath, event: "add" })
          break

        case "update":
          updates.push({ file: change.filePath, event: "change" })
          break

        case "move":
          if (change.movePath) {
            updates.push({ file: change.filePath, event: "unlink" })
            updates.push({ file: change.movePath, event: "add" })
          }
          break

        case "delete":
          updates.push({ file: change.filePath, event: "unlink" })
          break
      }

      if (edited) {
        await Bus.publish(File.Event.Edited, {
          file: edited,
        })
      }
    }

    // Publish file change events
    for (const update of updates) {
      await Bus.publish(FileWatcher.Event.Updated, update)
    }

    // Notify LSP of file changes and collect diagnostics
    for (const change of fileChanges) {
      if (change.type === "delete") continue
      const target = change.movePath ?? change.filePath
      await LSP.touchFile(target, true)
    }
    const diagnostics = await LSP.diagnostics()

    // Generate output summary
    const summaryLines = fileChanges.map((change) => {
      if (change.type === "add") {
        return `A ${path.relative(Instance.worktree, change.filePath)}`
      }
      if (change.type === "delete") {
        return `D ${path.relative(Instance.worktree, change.filePath)}`
      }
      const target = change.movePath ?? change.filePath
      return `M ${path.relative(Instance.worktree, target)}`
    })
    let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`
    if (trash.length) {
      output += `\n\nRecoverable for 30 days: ${trash.map((record) => record.id).join(", ")}`
    }

    // Report LSP errors for changed files
    const MAX_DIAGNOSTICS_PER_FILE = 20
    for (const change of fileChanges) {
      if (change.type === "delete") continue
      const target = change.movePath ?? change.filePath
      const normalized = Filesystem.normalizePath(target)
      const issues = diagnostics[normalized] ?? []
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length > 0) {
        const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        const suffix =
          errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
        output += `\n\nLSP errors detected in ${path.relative(Instance.worktree, target)}, please fix:\n<diagnostics file="${target}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
      }
    }

    return {
      title: output,
      metadata: {
        diff: totalDiff,
        files,
        diagnostics,
        trash,
      },
      output,
    }
  },
})
