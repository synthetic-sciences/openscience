import fs from "fs/promises"
import path from "path"
import { Identifier } from "../id/id"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"
import { SessionFilesystem } from "../session/filesystem"
import { ToolOutputPath } from "./tool-output-path"
import { HarnessState } from "@/harness/state"
import { Config } from "@/config/config"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 50 * 1024
  export const DIR = ToolOutputPath.root
  export const GLOB = ToolOutputPath.glob
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const HOUR_MS = 60 * 60 * 1000

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
    sessionID?: string
  }

  export function init() {
    Scheduler.register({
      id: "tool.truncation.cleanup",
      interval: HOUR_MS,
      run: cleanup,
      scope: "global",
    })
  }

  export async function cleanup() {
    const cutoff = Date.now() - RETENTION_MS
    const glob = new Bun.Glob("tool_*")
    const entries = await Array.fromAsync(glob.scan({ cwd: DIR, onlyFiles: true })).catch(() => [] as string[])
    for (const entry of entries) {
      const file = path.join(DIR, entry)
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat || stat.mtimeMs >= cutoff) continue
      await fs.unlink(file).catch(() => {})
    }
  }

  function hasTaskTool(agent?: Agent.Info): boolean {
    if (!agent?.permission) return false
    const rule = PermissionNext.evaluate("task", "*", agent.permission)
    return rule.action !== "deny"
  }

  /** A fresh owned output path; the file is created by whoever writes it. */
  export function file(): string {
    return path.join(DIR, Identifier.ascending("tool"))
  }

  /** Offer Task only when this session can actually delegate this turn; a
   * hint the model cannot follow costs a wasted call. */
  export function hint(filepath: string, agent?: Agent.Info, delegation = true): string {
    return hasTaskTool(agent) && delegation
      ? `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nRead that exact path with Read (offset/limit) for the sections you need, or use the Task tool to have the explore agent read it for you; the saved output is readable only by its exact path, and its directory cannot be listed or searched with Grep.`
      : `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nRead that exact path with Read (offset/limit) for the sections you need; the saved output is readable only by its exact path, and its directory cannot be listed or searched with Grep.`
  }

  /** The model-facing text for a truncated result: the kept preview, what was
   * left out, where the full output lives, and, when the caller kept one,
   * the end of the output, since a traceback or a final status line sits
   * there and the head alone reads like success. */
  export function message(
    input: {
      preview: string
      removed: number
      unit: "bytes" | "lines"
      filepath: string
      direction?: "head" | "tail"
      tail?: string
    },
    agent?: Agent.Info,
    delegation = true,
  ): string {
    const note = `...${input.removed} ${input.unit} truncated...`
    const guidance = hint(input.filepath, agent, delegation)
    const tail = input.tail?.trim() ? `\n\nThe output ends with:\n${input.tail.replace(/\n+$/, "")}` : ""
    return (input.direction ?? "head") === "head"
      ? `${input.preview}\n\n${note}\n\n${guidance}${tail}`
      : `${note}\n\n${guidance}\n\n${input.preview}`
  }

  export async function grant(filepath: string, sessionID?: string): Promise<void> {
    if (!sessionID?.startsWith("ses_")) return
    await SessionFilesystem.grantToolOutput({ sessionID, path: filepath })
  }

  export async function output(text: string, options: Options = {}, agent?: Agent.Info): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false }
    }

    const out: string[] = []
    let i = 0
    let bytes = 0
    let hitBytes = false

    if (direction === "head") {
      for (i = 0; i < lines.length && i < maxLines; i++) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.push(lines[i])
        bytes += size
      }
    } else {
      for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.unshift(lines[i])
        bytes += size
      }
    }

    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
    const unit = hitBytes ? "bytes" : "lines"
    const preview = out.join("\n")
    // A head-truncated output keeps its last lines too: an interpreter's
    // traceback and a final status line are where a long output says how it
    // ended, and the head alone reads like success.
    const tail = direction === "head" && i < lines.length ? lastLines(lines.slice(i), TAIL_LINES, TAIL_BYTES) : ""

    const filepath = file()
    await Bun.write(Bun.file(filepath), text)
    await grant(filepath, options.sessionID)

    // Tool output can be truncated outside a project instance (tests, CLI
    // helpers); the hint then keeps its default form.
    const config = await Config.get().catch(() => undefined)
    const delegation = config ? HarnessState.delegates(config, options.sessionID) : true
    return {
      content: message({ preview, removed, unit, filepath, direction, tail }, agent, delegation),
      truncated: true,
      outputPath: filepath,
    }
  }

  export const TAIL_LINES = 40
  export const TAIL_BYTES = 4 * 1024

  /** The last whole lines of `lines` within the line and byte budgets. */
  function lastLines(lines: string[], maxLines: number, maxBytes: number): string {
    const out: string[] = []
    let bytes = 0
    for (let index = lines.length - 1; index >= 0 && out.length < maxLines; index--) {
      const size = Buffer.byteLength(lines[index], "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) break
      out.unshift(lines[index])
      bytes += size
    }
    return out.join("\n")
  }
}
