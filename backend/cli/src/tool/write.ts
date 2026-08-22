import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory, sessionToolDirectory } from "./external-directory"
import { SafeFileIO } from "@/file/safe-io"
import { AuthoritySignal } from "@/project/authority-signal"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  }),
  async execute(params, ctx) {
    const directory = await sessionToolDirectory(ctx)
    const requested = path.isAbsolute(params.filePath) ? params.filePath : path.join(directory, params.filePath)
    using access = await assertExternalDirectory(ctx, requested, { access: "write" })
    const filepath = access?.path ?? requested

    const approved = await SafeFileIO.optional(filepath)
    const exists = !!approved
    const contentOld = approved?.bytes.toString("utf8") ?? ""
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    await AuthoritySignal.exclusive(async () => {
      const current = (await access?.revalidate()) ?? filepath
      if (current !== filepath) throw new Error("File authority changed before the write")
      await SafeFileIO.write(current, params.content, approved)
    })
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: exists ? "change" : "add",
    })
    FileTime.read(ctx.sessionID, filepath)

    let output = "Wrote file successfully."
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length === 0) continue
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === normalizedFilepath) {
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
