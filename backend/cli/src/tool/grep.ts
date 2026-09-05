import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory, sessionToolDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000
const MAX_MATCHES = 100

async function output(proc: { stdout: ReadableStream<Uint8Array>; kill(): void }, abort: AbortSignal) {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  const state = { buffer: "", lines: [] as string[], stopped: false }
  try {
    while (state.lines.length <= MAX_MATCHES) {
      abort.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      state.buffer += decoder.decode(chunk.value, { stream: true })
      const lines = state.buffer.split(/\r?\n/)
      state.buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        state.lines.push(line)
        if (state.lines.length <= MAX_MATCHES) continue
        state.stopped = true
        proc.kill()
        break
      }
    }
    if (!state.stopped && state.buffer) state.lines.push(state.buffer)
    return state
  } finally {
    reader.releaseLock()
  }
}

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const directory = await sessionToolDirectory(ctx)
    let searchPath = params.path ?? directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(directory, searchPath)
    using authorized = await assertExternalDirectory(ctx, searchPath, { kind: "directory" })
    searchPath = authorized?.path ?? searchPath

    const rgPath = await Ripgrep.filepath()
    const args = [
      "-nH",
      "--hidden",
      "--no-messages",
      "--max-columns",
      String(MAX_LINE_LENGTH),
      "--max-columns-preview",
      "--field-match-separator=|",
      "--regexp",
      params.pattern,
    ]
    if (params.include) {
      args.push("--glob", params.include)
    }
    searchPath = (await authorized?.revalidate()) ?? searchPath
    args.push(searchPath)

    ctx.abort.throwIfAborted()
    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
    })

    const error = new Response(proc.stderr).text()
    const collected = await output(proc, ctx.abort)
    const [errorOutput, exitCode] = await Promise.all([error, proc.exited])
    ctx.abort.throwIfAborted()

    // Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
    // With --no-messages, we suppress error output but still get exit code 2 for broken symlinks etc.
    // Invalid patterns and inaccessible roots are failures, not proof that no
    // files exist. A valid content search can also find files but no matching
    // lines; keep that distinct from a filename search.
    if (exitCode === 2 && collected.lines.length === 0) {
      throw new Error(`Search failed: ${errorOutput.trim() || "Some paths could not be searched."}`)
    }
    if (exitCode === 1) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No matching content found",
      }
    }

    if (!collected.stopped && exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    const hasErrors = exitCode === 2
    const matches = []

    for (const line of collected.lines) {
      if (!line) continue

      const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
      if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

      const lineNum = parseInt(lineNumStr, 10)
      const lineText = lineTextParts.join("|")

      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => null)
      if (!stats) continue

      matches.push({
        path: filePath,
        modTime: stats.mtime.getTime(),
        lineNum,
        lineText,
      })
    }

    matches.sort((a, b) => b.modTime - a.modTime)

    const truncated = collected.stopped || matches.length > MAX_MATCHES
    const finalMatches = truncated ? matches.slice(0, MAX_MATCHES) : matches

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No matching content found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
